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

const MAX_ID_LENGTH = 80;
const MAX_SENDER_LENGTH = 40;
const MAX_IV_LENGTH = 64;
const MAX_CIPHERTEXT_LENGTH = 11_000;

export function parseClientMessage(raw: string): ClientToServerMessage | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  if (parsed.type !== "chat.ciphertext" || parsed.version !== 1) {
    return null;
  }

  if (!isBoundedString(parsed.id, 1, MAX_ID_LENGTH)) {
    return null;
  }

  if (!isBoundedString(parsed.sender, 1, MAX_SENDER_LENGTH)) {
    return null;
  }

  if (!isPositiveSafeInteger(parsed.sentAt)) {
    return null;
  }

  if (!isBoundedString(parsed.iv, 1, MAX_IV_LENGTH)) {
    return null;
  }

  if (!isBoundedString(parsed.ciphertext, 1, MAX_CIPHERTEXT_LENGTH)) {
    return null;
  }

  return {
    type: "chat.ciphertext",
    version: 1,
    id: parsed.id,
    sender: parsed.sender,
    sentAt: parsed.sentAt,
    iv: parsed.iv,
    ciphertext: parsed.ciphertext
  };
}

export function serializeServerMessage(message: ServerToClientMessage): string {
  return JSON.stringify(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  minLength: number,
  maxLength: number
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minLength &&
    value.length <= maxLength
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
