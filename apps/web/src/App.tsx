import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  decryptMessage,
  deriveKeyFromSecret,
  encryptMessage
} from "./crypto";
import {
  decryptFileCredentialForDisplay,
  downloadEncryptedFile,
  MAX_FILE_BYTES,
  uploadEncryptedFile
} from "./files";
import type {
  ChatCiphertextMessage,
  ChatPlaintextMessage,
  FileCredentialCiphertextMessage,
  FileCredentialPlaintext,
  FileMetadataPlaintext,
  LocalMessage,
  ServerToClientMessage
} from "./types";
import {
  EncryptedChatSocket,
  type ConnectionStatus
} from "./websocket";

const MAX_PLAINTEXT_CHARS = 4000;
type SystemMessageLevel = Extract<LocalMessage, { kind: "system" }>["level"];

interface Session {
  nickname: string;
  key: CryptoKey;
}

export default function App() {
  const [nicknameInput, setNicknameInput] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [joinError, setJoinError] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [onlineCount, setOnlineCount] = useState(0);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const socketRef = useRef<EncryptedChatSocket | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const statusLabel = useMemo(() => {
    switch (status) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Connecting";
      case "reconnecting":
        return "Reconnecting";
      case "disconnected":
        return "Disconnected";
    }
  }, [status]);

  useEffect(() => {
    if (!session) {
      return;
    }

    const chatSocket = new EncryptedChatSocket({
      onStatusChange: setStatus,
      onMessage: (message) => {
        void handleServerMessage(message, session);
      },
      onSystemMessage: (text) => {
        appendSystemMessage(text, "info");
      }
    });

    socketRef.current = chatSocket;
    chatSocket.connect();

    return () => {
      chatSocket.close();
      if (socketRef.current === chatSocket) {
        socketRef.current = null;
      }
    };
  }, [session]);

  useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [messages]);

  async function handleJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJoinError("");

    const nickname = normalizeNickname(nicknameInput);
    const secret = secretInput;

    if (!nickname) {
      setJoinError("请输入昵称");
      return;
    }

    if (!secret) {
      setJoinError("请输入 shared secret");
      return;
    }

    try {
      setIsJoining(true);
      const key = await deriveKeyFromSecret(secret);
      setSecretInput("");
      setMessages([]);
      setSession({ nickname, key });
    } catch {
      setJoinError("密钥派生失败，请确认浏览器支持 WebCrypto");
    } finally {
      setIsJoining(false);
    }
  }

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!session) {
      return;
    }

    const text = draft.trim();
    if (!text) {
      return;
    }

    if (text.length > MAX_PLAINTEXT_CHARS) {
      appendSystemMessage("消息过长，请缩短后再发送", "warning");
      return;
    }

    const id = crypto.randomUUID();
    const sentAt = Date.now();
    const plaintext: ChatPlaintextMessage = {
      type: "chat.plaintext",
      id,
      sender: session.nickname,
      text,
      sentAt
    };

    try {
      const encrypted = await encryptMessage(session.key, plaintext);
      const ciphertextMessage: ChatCiphertextMessage = {
        type: "chat.ciphertext",
        version: 1,
        id,
        sender: session.nickname,
        sentAt,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext
      };

      socketRef.current?.send(ciphertextMessage);
      setDraft("");
    } catch {
      appendSystemMessage("加密或发送失败", "error");
    }
  }

  async function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file || !session) {
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      appendSystemMessage("文件过大。当前版本限制为 20 MB。", "warning");
      return;
    }

    try {
      setUploadProgress(1);
      const { credential } = await uploadEncryptedFile({
        file,
        channelKey: session.key,
        sender: session.nickname,
        onProgress: setUploadProgress
      });
      const encryptedCredential = await encryptMessage(session.key, credential);
      const message: FileCredentialCiphertextMessage = {
        type: "file.credential.ciphertext",
        version: 1,
        id: credential.id,
        sender: session.nickname,
        sentAt: credential.sentAt,
        fileId: credential.fileId,
        iv: encryptedCredential.iv,
        ciphertext: encryptedCredential.ciphertext
      };

      socketRef.current?.send(message);
      appendSystemMessage("加密文件已上传，凭据已广播", "info");
    } catch {
      appendSystemMessage("文件加密或上传失败", "error");
    } finally {
      setUploadProgress(null);
    }
  }

  async function handleDownloadFile(message: Extract<LocalMessage, { kind: "file" }>) {
    if (!session) {
      return;
    }

    try {
      setDownloadProgress((current) => ({ ...current, [message.fileId]: 1 }));
      await downloadEncryptedFile({
        fileId: message.fileId,
        channelKey: session.key,
        wrappedFileKeyIv: message.wrappedFileKeyIv,
        wrappedFileKey: message.wrappedFileKey,
        filename: message.filename,
        mimeType: message.mimeType,
        onProgress: (progress) => {
          setDownloadProgress((current) => ({
            ...current,
            [message.fileId]: progress
          }));
        }
      });
    } catch {
      appendSystemMessage("文件下载或解密失败，文件可能已过期、删除，或 shared secret 不一致。", "warning");
    } finally {
      window.setTimeout(() => {
        setDownloadProgress((current) => {
          const next = { ...current };
          delete next[message.fileId];
          return next;
        });
      }, 800);
    }
  }

  async function handleServerMessage(
    message: ServerToClientMessage,
    activeSession: Session
  ) {
    if (message.type === "server.welcome") {
      setOnlineCount(message.onlineCount);
      return;
    }

    if (message.type === "server.presence") {
      setOnlineCount(message.onlineCount);
      return;
    }

    if (message.type === "server.error") {
      appendSystemMessage(serverErrorToText(message.error), "warning");
      return;
    }

    if (message.type === "file.credential.ciphertext") {
      try {
        const credential = await decryptMessage<FileCredentialPlaintext>(
          activeSession.key,
          message.iv,
          message.ciphertext
        );

        if (!isValidFileCredential(credential)) {
          appendSystemMessage("收到一条解密后格式无效的文件凭据", "warning");
          return;
        }

        const metadata = await decryptFileCredentialForDisplay(
          activeSession.key,
          credential
        );

        if (!isValidFileMetadata(metadata)) {
          appendSystemMessage("收到一条解密后格式无效的文件信息", "warning");
          return;
        }

        appendChatMessage({
          kind: "file",
          id: credential.id,
          sender: credential.sender,
          sentAt: credential.sentAt,
          own: credential.sender === activeSession.nickname,
          fileId: credential.fileId,
          filename: metadata.filename,
          mimeType: metadata.mimeType,
          size: metadata.size,
          expiresAt: credential.expiresAt,
          wrappedFileKeyIv: credential.wrappedFileKeyIv,
          wrappedFileKey: credential.wrappedFileKey,
          chunkCount: credential.chunkCount
        });
      } catch {
        appendSystemMessage(
          "收到一条无法解密的文件凭据。可能是 shared secret 不一致。",
          "warning"
        );
      }
      return;
    }

    if (message.type !== "chat.ciphertext") {
      return;
    }

    try {
      const plaintext = await decryptMessage<ChatPlaintextMessage>(
        activeSession.key,
        message.iv,
        message.ciphertext
      );

      if (!isValidPlaintextMessage(plaintext)) {
        appendSystemMessage("收到一条解密后格式无效的消息", "warning");
        return;
      }

      appendChatMessage({
        kind: "chat",
        id: plaintext.id,
        sender: plaintext.sender,
        text: plaintext.text,
        sentAt: plaintext.sentAt,
        own: plaintext.sender === activeSession.nickname
      });
    } catch {
      appendSystemMessage(
        "收到一条无法解密的消息。可能是 shared secret 不一致。",
        "warning"
      );
    }
  }

  function appendChatMessage(message: LocalMessage) {
    setMessages((current) => {
      if (
        (message.kind === "chat" || message.kind === "file") &&
        current.some((item) => item.id === message.id)
      ) {
        return current;
      }
      return [...current, message];
    });
  }

  function appendSystemMessage(
    text: string,
    level: SystemMessageLevel
  ) {
    setMessages((current) => [
      ...current,
      {
        kind: "system",
        id: crypto.randomUUID(),
        text,
        level,
        sentAt: Date.now()
      }
    ]);
  }

  function handleLeave() {
    socketRef.current?.close();
    socketRef.current = null;
    setSession(null);
    setOnlineCount(0);
    setStatus("disconnected");
    setMessages([]);
    appendSystemMessage("已离开，明文消息已从本地显示中清除", "info");
  }

  if (!session) {
    return (
      <main className="join-shell">
        <section className="join-panel" aria-labelledby="join-title">
          <p className="eyebrow">Browser encrypted relay</p>
          <h1 id="join-title">Single Channel E2EE IRC</h1>
          <p className="join-note">
            Shared Secret 只保存在当前浏览器内存中，不会发送到服务器。刷新页面后需要重新输入。
          </p>
          <form className="join-form" onSubmit={handleJoin}>
            <label>
              <span>Nickname</span>
              <input
                value={nicknameInput}
                maxLength={40}
                autoComplete="nickname"
                onChange={(event) => setNicknameInput(event.target.value)}
                placeholder="alice"
              />
            </label>
            <label>
              <span>Shared Secret</span>
              <input
                value={secretInput}
                type="password"
                autoComplete="off"
                onChange={(event) => setSecretInput(event.target.value)}
                placeholder="enter shared secret"
              />
            </label>
            {joinError ? <p className="form-error">{joinError}</p> : null}
            <button type="submit" disabled={isJoining}>
              {isJoining ? "Joining..." : "Join Chat"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="chat-shell">
      <header className="chat-header">
        <div>
          <h1>Single Channel E2EE IRC</h1>
          <p>Nickname: {session.nickname}</p>
        </div>
        <div className="status-cluster" aria-label="Connection state">
          <span className={`status-dot status-${status}`} />
          <span>{statusLabel}</span>
          <span>Online: {onlineCount}</span>
        </div>
      </header>

      <section className="message-panel" aria-label="Messages">
        <div className="message-list" ref={messageListRef}>
          {messages.length === 0 ? (
            <p className="empty-state">No local messages in memory.</p>
          ) : (
            messages.map((message) =>
              message.kind === "system" ? (
                <article
                  className={`message system-message system-${message.level}`}
                  key={message.id}
                >
                  <span>{formatTime(message.sentAt)}</span>
                  <p>{message.text}</p>
                </article>
              ) : message.kind === "chat" ? (
                <article
                  className={`message chat-message ${message.own ? "own" : ""}`}
                  key={message.id}
                >
                  <div className="message-meta">
                    <strong>{message.sender}</strong>
                    <span>{formatTime(message.sentAt)}</span>
                  </div>
                  <p>{message.text}</p>
                </article>
              ) : (
                <article
                  className={`message file-message ${message.own ? "own" : ""}`}
                  key={message.id}
                >
                  <div className="message-meta">
                    <strong>{message.sender}</strong>
                    <span>{formatTime(message.sentAt)}</span>
                  </div>
                  <div className="file-attachment">
                    <div>
                      <p className="file-name">{message.filename}</p>
                      <p className="file-meta">
                        {formatBytes(message.size)} · {message.chunkCount} chunks · expires {formatTime(message.expiresAt)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleDownloadFile(message)}
                      disabled={downloadProgress[message.fileId] !== undefined}
                    >
                      {downloadProgress[message.fileId] !== undefined
                        ? `${downloadProgress[message.fileId]}%`
                        : "Download"}
                    </button>
                  </div>
                </article>
              )
            )
          )}
        </div>
      </section>

      <form className="composer" onSubmit={handleSend}>
        <input
          ref={fileInputRef}
          className="hidden-file-input"
          type="file"
          onChange={handleFileSelected}
          aria-label="Attach encrypted file"
        />
        <input
          value={draft}
          maxLength={MAX_PLAINTEXT_CHARS + 1}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type encrypted message..."
          aria-label="Message"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={status !== "connected" || uploadProgress !== null}
          title="Attach encrypted file"
        >
          {uploadProgress !== null ? `${uploadProgress}%` : "Attach"}
        </button>
        <button type="submit" disabled={status !== "connected"}>
          Send
        </button>
        <button type="button" onClick={() => setMessages([])}>
          Clear Local Messages
        </button>
        <button type="button" className="secondary-danger" onClick={handleLeave}>
          Leave
        </button>
      </form>
    </main>
  );
}

function normalizeNickname(nickname: string): string {
  return nickname.trim().replace(/\s+/g, " ").slice(0, 40);
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function serverErrorToText(error: string): string {
  switch (error) {
    case "message_too_large":
      return "消息过长，服务器已拒绝";
    case "rate_limited":
      return "发送过快，请稍后再试";
    case "invalid_message":
      return "服务器拒绝了一条格式无效的消息";
    default:
      return "服务器返回错误";
  }
}

function isValidPlaintextMessage(value: unknown): value is ChatPlaintextMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.type === "chat.plaintext" &&
    typeof record.id === "string" &&
    typeof record.sender === "string" &&
    typeof record.text === "string" &&
    Number.isSafeInteger(record.sentAt)
  );
}

function isValidFileCredential(value: unknown): value is FileCredentialPlaintext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.type === "file.credential.plaintext" &&
    typeof record.id === "string" &&
    typeof record.sender === "string" &&
    typeof record.fileId === "string" &&
    typeof record.wrappedFileKeyIv === "string" &&
    typeof record.wrappedFileKey === "string" &&
    typeof record.metadataIv === "string" &&
    typeof record.encryptedMetadata === "string" &&
    Number.isSafeInteger(record.sentAt) &&
    Number.isSafeInteger(record.chunkSize) &&
    Number.isSafeInteger(record.chunkCount) &&
    Number.isSafeInteger(record.totalCiphertextBytes) &&
    Number.isSafeInteger(record.expiresAt)
  );
}

function isValidFileMetadata(value: unknown): value is FileMetadataPlaintext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.type === "file.metadata.plaintext" &&
    typeof record.filename === "string" &&
    typeof record.mimeType === "string" &&
    Number.isSafeInteger(record.size)
  );
}
