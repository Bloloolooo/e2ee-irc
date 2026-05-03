import fs from "node:fs/promises";
import path from "node:path";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 1024 * 1024 + 32;
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredFileManifest {
  fileId: string;
  uploader: string;
  createdAt: number;
  expiresAt: number;
  chunkSize: number;
  chunkCount: number;
  totalCiphertextBytes: number;
  metadataIv: string;
  encryptedMetadata: string;
  chunks: Array<{
    index: number;
    iv: string | null;
    byteLength: number;
    uploadedAt: number | null;
  }>;
}

export interface CreateFileManifestInput {
  fileId: string;
  uploader: string;
  expiresAt?: number;
  chunkSize: number;
  chunkCount: number;
  totalCiphertextBytes: number;
  metadataIv: string;
  encryptedMetadata: string;
}

export interface PublicFileManifest {
  fileId: string;
  createdAt: number;
  expiresAt: number;
  chunkSize: number;
  chunkCount: number;
  totalCiphertextBytes: number;
  metadataIv: string;
  encryptedMetadata: string;
  chunks: Array<{
    index: number;
    iv: string;
    byteLength: number;
  }>;
}

export interface AdminFileSummary {
  fileId: string;
  uploader: string;
  createdAt: number;
  expiresAt: number;
  chunkSize: number;
  chunkCount: number;
  uploadedChunkCount: number;
  totalCiphertextBytes: number;
  storedCiphertextBytes: number;
  complete: boolean;
}

export class FileStore {
  constructor(private readonly rootDir: string) {}

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async createManifest(input: CreateFileManifestInput): Promise<StoredFileManifest> {
    validateFileId(input.fileId);
    validateUploader(input.uploader);
    validateBase64(input.metadataIv, 64, "metadataIv");
    validateBase64(input.encryptedMetadata, 16_000, "encryptedMetadata");

    if (!Number.isInteger(input.chunkSize) || input.chunkSize <= 0 || input.chunkSize > MAX_CHUNK_BYTES) {
      throw new Error("invalid_chunk_size");
    }

    if (!Number.isInteger(input.chunkCount) || input.chunkCount <= 0 || input.chunkCount > 256) {
      throw new Error("invalid_chunk_count");
    }

    if (
      !Number.isInteger(input.totalCiphertextBytes) ||
      input.totalCiphertextBytes <= 0 ||
      input.totalCiphertextBytes > MAX_FILE_BYTES + input.chunkCount * 32
    ) {
      throw new Error("invalid_total_size");
    }

    const now = Date.now();
    const expiresAt = normalizeExpiry(input.expiresAt, now);
    const fileDir = this.getFileDir(input.fileId);

    await fs.mkdir(path.join(fileDir, "chunks"), { recursive: true });

    const manifest: StoredFileManifest = {
      fileId: input.fileId,
      uploader: input.uploader,
      createdAt: now,
      expiresAt,
      chunkSize: input.chunkSize,
      chunkCount: input.chunkCount,
      totalCiphertextBytes: input.totalCiphertextBytes,
      metadataIv: input.metadataIv,
      encryptedMetadata: input.encryptedMetadata,
      chunks: Array.from({ length: input.chunkCount }, (_value, index) => ({
        index,
        iv: null,
        byteLength: 0,
        uploadedAt: null
      }))
    };

    await this.writeManifest(manifest);
    return manifest;
  }

  async putChunk(
    fileId: string,
    index: number,
    iv: string,
    bytes: Buffer
  ): Promise<StoredFileManifest> {
    validateFileId(fileId);
    validateBase64(iv, 64, "chunkIv");

    const manifest = await this.readManifest(fileId);
    ensureNotExpired(manifest);

    if (!Number.isInteger(index) || index < 0 || index >= manifest.chunkCount) {
      throw new Error("invalid_chunk_index");
    }

    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
      throw new Error("invalid_chunk_size");
    }

    const existingTotal = manifest.chunks.reduce((total, chunk) => {
      if (chunk.index === index) {
        return total;
      }
      return total + chunk.byteLength;
    }, 0);

    if (existingTotal + bytes.byteLength > manifest.totalCiphertextBytes) {
      throw new Error("file_size_exceeded");
    }

    const chunkPath = this.getChunkPath(fileId, index);
    await fs.writeFile(chunkPath, bytes);

    manifest.chunks[index] = {
      index,
      iv,
      byteLength: bytes.byteLength,
      uploadedAt: Date.now()
    };
    await this.writeManifest(manifest);
    return manifest;
  }

  async getPublicManifest(fileId: string): Promise<PublicFileManifest> {
    const manifest = await this.readManifest(fileId);
    ensureNotExpired(manifest);

    if (!isComplete(manifest)) {
      throw new Error("file_incomplete");
    }

    return {
      fileId: manifest.fileId,
      createdAt: manifest.createdAt,
      expiresAt: manifest.expiresAt,
      chunkSize: manifest.chunkSize,
      chunkCount: manifest.chunkCount,
      totalCiphertextBytes: manifest.totalCiphertextBytes,
      metadataIv: manifest.metadataIv,
      encryptedMetadata: manifest.encryptedMetadata,
      chunks: manifest.chunks.map((chunk) => ({
        index: chunk.index,
        iv: chunk.iv ?? "",
        byteLength: chunk.byteLength
      }))
    };
  }

  async getChunk(fileId: string, index: number): Promise<Buffer> {
    const manifest = await this.readManifest(fileId);
    ensureNotExpired(manifest);

    if (!Number.isInteger(index) || index < 0 || index >= manifest.chunkCount) {
      throw new Error("invalid_chunk_index");
    }

    if (!manifest.chunks[index]?.iv) {
      throw new Error("chunk_missing");
    }

    return fs.readFile(this.getChunkPath(fileId, index));
  }

  async listAdminFiles(): Promise<AdminFileSummary[]> {
    await this.ensureReady();
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const summaries: AdminFileSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        const manifest = await this.readManifest(entry.name);
        const uploadedChunkCount = manifest.chunks.filter((chunk) => chunk.iv).length;
        const storedCiphertextBytes = manifest.chunks.reduce(
          (total, chunk) => total + chunk.byteLength,
          0
        );

        summaries.push({
          fileId: manifest.fileId,
          uploader: manifest.uploader,
          createdAt: manifest.createdAt,
          expiresAt: manifest.expiresAt,
          chunkSize: manifest.chunkSize,
          chunkCount: manifest.chunkCount,
          uploadedChunkCount,
          totalCiphertextBytes: manifest.totalCiphertextBytes,
          storedCiphertextBytes,
          complete: isComplete(manifest)
        });
      } catch {
        continue;
      }
    }

    return summaries.sort((left, right) => right.createdAt - left.createdAt);
  }

  async deleteFile(fileId: string): Promise<void> {
    validateFileId(fileId);
    await fs.rm(this.getFileDir(fileId), { recursive: true, force: true });
  }

  async cleanupExpired(): Promise<number> {
    const files = await this.listAdminFiles();
    const now = Date.now();
    let deleted = 0;

    for (const file of files) {
      if (file.expiresAt <= now) {
        await this.deleteFile(file.fileId);
        deleted += 1;
      }
    }

    return deleted;
  }

  private async readManifest(fileId: string): Promise<StoredFileManifest> {
    validateFileId(fileId);
    const raw = await fs.readFile(this.getManifestPath(fileId), "utf8");
    return JSON.parse(raw) as StoredFileManifest;
  }

  private async writeManifest(manifest: StoredFileManifest): Promise<void> {
    await fs.writeFile(
      this.getManifestPath(manifest.fileId),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
  }

  private getFileDir(fileId: string): string {
    return path.join(this.rootDir, fileId);
  }

  private getManifestPath(fileId: string): string {
    return path.join(this.getFileDir(fileId), "manifest.json");
  }

  private getChunkPath(fileId: string, index: number): string {
    return path.join(this.getFileDir(fileId), "chunks", index.toString().padStart(6, "0"));
  }
}

function validateFileId(fileId: string): void {
  if (!/^[a-f0-9-]{36}$/.test(fileId)) {
    throw new Error("invalid_file_id");
  }
}

function validateUploader(uploader: string): void {
  if (typeof uploader !== "string" || uploader.length < 1 || uploader.length > 40) {
    throw new Error("invalid_uploader");
  }
}

function validateBase64(value: string, maxLength: number, name: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error(`invalid_${name}`);
  }
}

function normalizeExpiry(expiresAt: number | undefined, now: number): number {
  if (expiresAt === undefined) {
    return now + DEFAULT_RETENTION_MS;
  }

  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error("invalid_expiry");
  }

  return Math.min(expiresAt, now + MAX_RETENTION_MS);
}

function ensureNotExpired(manifest: StoredFileManifest): void {
  if (manifest.expiresAt <= Date.now()) {
    throw new Error("file_expired");
  }
}

function isComplete(manifest: StoredFileManifest): boolean {
  return manifest.chunks.every((chunk) => chunk.iv && chunk.byteLength > 0);
}
