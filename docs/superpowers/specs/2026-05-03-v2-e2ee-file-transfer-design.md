# V2 E2EE File Transfer Design

## Goal

Extend the single-channel E2EE IRC MVP with encrypted file transfer while preserving the core security property: the server manages connections and ciphertext objects, but does not receive shared secrets, file keys, plaintext file contents, plaintext filenames, or plaintext chat history.

V2 turns the server from a pure WebSocket relay into a small encrypted object store. Text chat remains browser-encrypted and relay-oriented. Files are uploaded as encrypted chunks, referenced from chat through encrypted file credentials, and decrypted only in browsers that know the shared secret.

## Non-Goals

- No user registration or member login system.
- No separate admin login UI.
- No plaintext file scanning, preview, search, moderation, or AI processing on the server.
- No server-side decryption.
- No unbounded file uploads.
- No persistent plaintext cache in `localStorage`, `sessionStorage`, IndexedDB, cookies, or server APIs.

## Admin Model

The admin is a storage administrator, not a plaintext administrator.

The backend reads an admin token from environment configuration:

```bash
ADMIN_TOKEN=change-me
```

Admin endpoints require:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

Initial V2 admin endpoints:

- `GET /admin/files`: list encrypted file objects and operational metadata.
- `DELETE /admin/files/:fileId`: delete an encrypted file object and its chunks.

Optional later endpoint:

- `POST /admin/files`: add an already-encrypted file object through an admin tool.

The admin list response may include `fileId`, uploader metadata if intentionally exposed, ciphertext sizes, chunk count, upload time, expiry time, and deletion state. It must not include plaintext filename, plaintext MIME type, plaintext file contents, shared secret, channel key, or file key.

## File Encryption Model

Each file uses envelope encryption:

1. The browser generates 32 random bytes for per-file key material.
2. The browser wraps that key material with the existing channel key derived from the shared secret.
3. The browser imports the same key material as a non-extractable AES-GCM 256-bit `fileKey`.
4. The browser encrypts file chunks with `fileKey`.
5. Each chunk uses a fresh random 12-byte IV.
6. The browser encrypts file metadata with `fileKey`.
7. The browser uploads only encrypted chunks, encrypted metadata, and wrapped key material.

This keeps the current shared-secret model while separating the long-lived channel key from per-file data encryption. It also leaves room for future key rotation or one-time file links.

The raw key bytes must remain in memory only and be cleared from references as soon as practical. The server receives only the wrapped key material, never the unwrapped file key.

## File Credential

After upload, the sender broadcasts an encrypted file credential through the existing chat channel. Other clients see an attachment entry only if they can decrypt this credential.

Proposed ciphertext envelope:

```ts
export interface FileCredentialCiphertextMessage {
  type: "file.credential.ciphertext";
  version: 1;
  id: string;
  sender: string;
  sentAt: number;
  fileId: string;
  iv: string;
  ciphertext: string;
}
```

The encrypted plaintext inside `ciphertext`:

```ts
export interface FileCredentialPlaintext {
  type: "file.credential.plaintext";
  id: string;
  sender: string;
  sentAt: number;
  fileId: string;
  wrappedFileKey: string;
  metadataIv: string;
  encryptedMetadata: string;
  chunkSize: number;
  chunkCount: number;
  totalCiphertextBytes: number;
  expiresAt: number;
}
```

The encrypted metadata plaintext:

```ts
export interface FileMetadataPlaintext {
  type: "file.metadata.plaintext";
  filename: string;
  mimeType: string;
  size: number;
  lastModified?: number;
}
```

The server stores and relays ciphertext values but cannot decrypt the credential or metadata.

## Upload Flow

1. User selects a file.
2. Client validates size before reading. Initial limit: 20 MB.
3. Client generates a file id and `fileKey`.
4. Client encrypts metadata with `fileKey`.
5. Client encrypts file chunks with `fileKey`, one IV per chunk.
6. Client uploads encrypted chunks to the server.
7. Server validates total size, chunk count, and field lengths, then stores encrypted chunks.
8. Client broadcasts `file.credential.ciphertext` over WebSocket.
9. Other clients decrypt the credential and render an attachment bubble with filename, size, sender, and download action.

Initial chunk size: 1 MB. This is small enough for mobile memory pressure and simple enough for MVP V2.

## Download Flow

1. User clicks an attachment.
2. Client decrypts the file credential with the channel key.
3. Client unwraps/imports `fileKey`.
4. Client fetches encrypted chunks by `fileId`.
5. Client decrypts chunks in order, showing progress.
6. Client creates a temporary `Blob` and object URL for download.
7. Client revokes the object URL after the download action.

The browser download itself may persist plaintext to the user's Downloads folder. This is different from chat-history persistence and must be documented clearly in the README.

## Server Storage

Initial V2 can use local filesystem storage for encrypted chunks:

```text
data/files/
  <fileId>/
    manifest.json
    chunks/
      000000.bin
      000001.bin
```

`manifest.json` contains operational metadata only:

- `fileId`
- `uploader`
- `createdAt`
- `expiresAt`
- `chunkSize`
- `chunkCount`
- `totalCiphertextBytes`
- per-chunk IV and byte length

The manifest must not contain plaintext filename, plaintext MIME type, plaintext file content, shared secret, unwrapped file key, or decrypted metadata.

## API Sketch

Public encrypted file APIs:

- `POST /files`: create encrypted file object and upload manifest.
- `PUT /files/:fileId/chunks/:index`: upload encrypted chunk.
- `GET /files/:fileId/manifest`: fetch encrypted file manifest.
- `GET /files/:fileId/chunks/:index`: fetch encrypted chunk.

Admin APIs:

- `GET /admin/files`
- `DELETE /admin/files/:fileId`

All endpoints enforce max request size. Upload endpoints enforce file id format, chunk index bounds, chunk count, total encrypted size, and expiry.

## Expiry and Cleanup

Initial retention policy:

- Default expiry: 24 hours.
- Maximum expiry: 7 days.
- Cleanup task runs periodically in the server process and removes expired encrypted file directories.

Deletion is physical deletion for MVP V2. If later auditability is needed, store deletion markers without retaining chunks.

## Mobile UX

Mobile support needs explicit file-transfer states:

- Upload progress by chunk.
- Download progress by chunk.
- Cancel upload or download.
- Clear error if the file is too large.
- Compact attachment bubble in the chat timeline.

The mobile composer should avoid crowding. File attach should be an icon button next to the text input, while secondary actions stay out of the main row.

## Failure Handling

Expected failures:

- File too large.
- Upload interrupted.
- Download interrupted.
- Expired or deleted file.
- Credential decrypt failure due to wrong shared secret.
- Chunk decrypt failure due to wrong key or corrupted ciphertext.
- Admin token missing or invalid.

Decrypt failures must not crash the UI and must not display raw ciphertext to normal users.

## Security Acceptance Criteria

- Shared secret is never sent to the server.
- File key is never sent to the server unwrapped.
- Plaintext filename and MIME type are encrypted in metadata.
- File contents are encrypted before upload.
- Each file chunk uses a unique AES-GCM IV.
- Admin APIs cannot return plaintext file contents or plaintext metadata.
- Admin can delete encrypted file objects without knowing the shared secret.
- Different shared secrets cannot decrypt file credentials or file contents.
- Plaintext files are not stored in browser persistence APIs by the app.

## Functional Acceptance Criteria

- A user can upload a file and see an attachment in chat.
- Another user with the same shared secret can download and decrypt the file.
- A user with a different shared secret sees a decrypt failure for the file credential.
- Admin can list encrypted file objects.
- Admin can delete an encrypted file object.
- Deleted or expired files cannot be downloaded.
- Upload and download progress are visible on desktop and mobile.
