import type { ClientToServerMessage, ServerToClientMessage } from "./types";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting";

interface EncryptedChatSocketOptions {
  nickname: string;
  authProof: string;
  onStatusChange(status: ConnectionStatus): void;
  onMessage(message: ServerToClientMessage): void;
  onSystemMessage(message: string): void;
}

export class EncryptedChatSocket {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private shouldReconnect = true;
  private reconnectAttempts = 0;

  constructor(private readonly options: EncryptedChatSocketOptions) {}

  connect(): void {
    this.shouldReconnect = true;
    this.openSocket();
  }

  send(message: ClientToServerMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.options.onStatusChange("disconnected");
  }

  private openSocket(): void {
    this.options.onStatusChange(
      this.reconnectAttempts > 0 ? "reconnecting" : "connecting"
    );

    const socket = new WebSocket(
      getWebSocketUrl(this.options.nickname, this.options.authProof)
    );
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.options.onStatusChange("connected");
      this.options.onSystemMessage("已连接");
    });

    socket.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as ServerToClientMessage;
        this.options.onMessage(parsed);
      } catch {
        this.options.onSystemMessage("收到一条格式无效的服务器消息");
      }
    });

    socket.addEventListener("close", (event) => {
      if (!this.shouldReconnect) {
        return;
      }

      if (event.code === 1008) {
        this.shouldReconnect = false;
        this.options.onStatusChange("disconnected");
        this.options.onSystemMessage("无法进入频道：shared secret 不正确，或服务端未配置频道密钥。");
        return;
      }

      this.options.onStatusChange("disconnected");
      this.options.onSystemMessage("已断开，WebSocket 重连中");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      this.options.onSystemMessage("WebSocket 连接错误");
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * this.reconnectAttempts, 5000);
    this.reconnectTimer = window.setTimeout(() => {
      this.openSocket();
    }, delay);
  }
}

function getWebSocketUrl(nickname: string, authProof: string): string {
  const configuredUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const devProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const baseUrl = configuredUrl
    ? configuredUrl
    : import.meta.env.DEV
      ? `${devProtocol}//${window.location.hostname}:3001/ws`
      : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;

  const url = new URL(baseUrl);
  url.searchParams.set("nickname", nickname);
  url.searchParams.set("auth", authProof);
  return url.toString();
}
