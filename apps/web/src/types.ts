export type ClientToServerMessage =
  | ChatCiphertextMessage
  | FileCredentialCiphertextMessage;

export type ServerToClientMessage =
  | ServerWelcomeMessage
  | ServerPresenceMessage
  | ChatCiphertextMessage
  | FileCredentialCiphertextMessage
  | ServerErrorMessage;

export interface ChatCiphertextMessage {
  type: "chat.ciphertext";
  version: 1;
  id: string;
  sender: string;
  sentAt: number;
  iv: string;
  ciphertext: string;
}

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

export interface ServerWelcomeMessage {
  type: "server.welcome";
  version: 1;
  connectionId: string;
  onlineCount: number;
}

export interface ServerPresenceMessage {
  type: "server.presence";
  onlineCount: number;
}

export interface ServerErrorMessage {
  type: "server.error";
  error: string;
}

export interface ChatPlaintextMessage {
  type: "chat.plaintext";
  id: string;
  sender: string;
  text: string;
  sentAt: number;
}

export interface FileCredentialPlaintext {
  type: "file.credential.plaintext";
  id: string;
  sender: string;
  sentAt: number;
  fileId: string;
  wrappedFileKeyIv: string;
  wrappedFileKey: string;
  metadataIv: string;
  encryptedMetadata: string;
  chunkSize: number;
  chunkCount: number;
  totalCiphertextBytes: number;
  expiresAt: number;
}

export interface FileMetadataPlaintext {
  type: "file.metadata.plaintext";
  filename: string;
  mimeType: string;
  size: number;
  lastModified?: number;
}

export type LocalMessage =
  | {
      kind: "chat";
      id: string;
      sender: string;
      text: string;
      sentAt: number;
      own: boolean;
    }
  | {
      kind: "file";
      id: string;
      sender: string;
      sentAt: number;
      own: boolean;
      fileId: string;
      filename: string;
      mimeType: string;
      size: number;
      expiresAt: number;
      wrappedFileKeyIv: string;
      wrappedFileKey: string;
      chunkCount: number;
    }
  | {
      kind: "system";
      id: string;
      text: string;
      level: "info" | "warning" | "error";
      sentAt: number;
    };
