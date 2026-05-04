import {
  base64ToBytes,
  bytesToBase64,
  decryptBytes,
  decryptMessage,
  encryptBytes,
  encryptMessage,
  importAesGcmKey,
  randomBytes,
  randomId,
  toArrayBuffer
} from "./crypto";
import type { AppCryptoKey } from "./crypto";
import type {
  FileCredentialPlaintext,
  FileMetadataPlaintext
} from "./types";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CHUNK_SIZE = 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export interface UploadEncryptedFileResult {
  credential: FileCredentialPlaintext;
  metadata: FileMetadataPlaintext;
}

export interface UploadEncryptedFileOptions {
  file: File;
  channelKey: AppCryptoKey;
  authProof: string;
  sender: string;
  onProgress(progress: number): void;
}

export interface DownloadEncryptedFileOptions {
  fileId: string;
  channelKey: AppCryptoKey;
  authProof: string;
  nickname: string;
  wrappedFileKeyIv: string;
  wrappedFileKey: string;
  filename: string;
  mimeType: string;
  onProgress(progress: number): void;
}

interface CreateFileResponse {
  fileId: string;
  expiresAt: number;
  chunkCount: number;
}

interface PublicFileManifest {
  fileId: string;
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

export async function uploadEncryptedFile({
  file,
  channelKey,
  authProof,
  sender,
  onProgress
}: UploadEncryptedFileOptions): Promise<UploadEncryptedFileResult> {
  if (file.size <= 0) {
    throw new Error("empty_file");
  }

  if (file.size > MAX_FILE_BYTES) {
    throw new Error("file_too_large");
  }

  const fileId = randomId();
  const sentAt = Date.now();
  const expiresAt = sentAt + RETENTION_MS;
  const rawFileKey = randomBytes(32);
  const fileKey = await importAesGcmKey(rawFileKey);
  const wrapped = await encryptBytes(channelKey, rawFileKey);

  const metadata: FileMetadataPlaintext = {
    type: "file.metadata.plaintext",
    filename: file.name || "encrypted-file",
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    lastModified: file.lastModified || undefined
  };
  const encryptedMetadata = await encryptMessage(fileKey, metadata);

  const encryptedChunks: Array<{ iv: string; ciphertext: Uint8Array }> = [];
  let totalCiphertextBytes = 0;
  const chunkCount = Math.ceil(file.size / CHUNK_SIZE);

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunkBytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    const encrypted = await encryptBytes(fileKey, chunkBytes);
    encryptedChunks.push(encrypted);
    totalCiphertextBytes += encrypted.ciphertext.byteLength;
    onProgress(Math.round(((index + 0.5) / chunkCount) * 100));
  }

  const created = await postJson<CreateFileResponse>("/files", {
    fileId,
    uploader: sender,
    expiresAt,
    chunkSize: CHUNK_SIZE,
    chunkCount,
    totalCiphertextBytes,
    metadataIv: encryptedMetadata.iv,
    encryptedMetadata: encryptedMetadata.ciphertext
  }, authHeaders(sender, authProof));

  for (const [index, chunk] of encryptedChunks.entries()) {
    const response = await fetch(`/files/${fileId}/chunks/${index}`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-chunk-iv": chunk.iv,
        ...authHeaders(sender, authProof)
      },
      body: toArrayBuffer(chunk.ciphertext)
    });

    if (!response.ok) {
      throw new Error("chunk_upload_failed");
    }

    onProgress(Math.round(((index + 1) / encryptedChunks.length) * 100));
  }

  rawFileKey.fill(0);

  return {
    metadata,
    credential: {
      type: "file.credential.plaintext",
      id: randomId(),
      sender,
      sentAt,
      fileId,
      wrappedFileKeyIv: wrapped.iv,
      wrappedFileKey: bytesToBase64(wrapped.ciphertext),
      metadataIv: encryptedMetadata.iv,
      encryptedMetadata: encryptedMetadata.ciphertext,
      chunkSize: CHUNK_SIZE,
      chunkCount: created.chunkCount,
      totalCiphertextBytes,
      expiresAt: created.expiresAt
    }
  };
}

export async function decryptFileCredentialForDisplay(
  channelKey: AppCryptoKey,
  credential: FileCredentialPlaintext
): Promise<FileMetadataPlaintext> {
  const fileKey = await unwrapFileKey(
    channelKey,
    credential.wrappedFileKeyIv,
    credential.wrappedFileKey
  );
  return decryptMessage<FileMetadataPlaintext>(
    fileKey,
    credential.metadataIv,
    credential.encryptedMetadata
  );
}

export async function downloadEncryptedFile({
  fileId,
  channelKey,
  authProof,
  nickname,
  wrappedFileKeyIv,
  wrappedFileKey,
  filename,
  mimeType,
  onProgress
}: DownloadEncryptedFileOptions): Promise<void> {
  const fileKey = await unwrapFileKey(channelKey, wrappedFileKeyIv, wrappedFileKey);
  const manifest = await getJson<PublicFileManifest>(
    `/files/${fileId}/manifest`,
    authHeaders(nickname, authProof)
  );
  const plaintextChunks: Uint8Array[] = [];

  for (const chunk of manifest.chunks) {
    const response = await fetch(`/files/${fileId}/chunks/${chunk.index}`, {
      headers: authHeaders(nickname, authProof)
    });
    if (!response.ok) {
      throw new Error("chunk_download_failed");
    }

    const encryptedChunk = new Uint8Array(await response.arrayBuffer());
    const plaintext = await decryptBytes(fileKey, chunk.iv, encryptedChunk);
    plaintextChunks.push(plaintext);
    onProgress(Math.round(((chunk.index + 1) / manifest.chunkCount) * 100));
  }

  const blob = new Blob(plaintextChunks.map(toArrayBuffer), {
    type: mimeType || "application/octet-stream"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "encrypted-file";
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function unwrapFileKey(
  channelKey: AppCryptoKey,
  wrappedFileKeyIv: string,
  wrappedFileKey: string
): Promise<AppCryptoKey> {
  const rawKey = await decryptBytes(
    channelKey,
    wrappedFileKeyIv,
    base64ToBytes(wrappedFileKey)
  );
  const fileKey = await importAesGcmKey(rawKey);
  rawKey.fill(0);
  return fileKey;
}

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error("request_failed");
  }

  return response.json() as Promise<T>;
}

async function getJson<T>(
  url: string,
  headers: Record<string, string>
): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error("request_failed");
  }

  return response.json() as Promise<T>;
}

function authHeaders(nickname: string, authProof: string): Record<string, string> {
  return {
    "x-nickname": nickname,
    "x-channel-auth": authProof
  };
}
