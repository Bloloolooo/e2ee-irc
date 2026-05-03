export type ClientToServerMessage = ChatCiphertextMessage;

export type ServerToClientMessage =
  | ServerWelcomeMessage
  | ServerPresenceMessage
  | ChatCiphertextMessage
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
      kind: "system";
      id: string;
      text: string;
      level: "info" | "warning" | "error";
      sentAt: number;
    };
