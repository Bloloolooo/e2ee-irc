import type { ClientToServerMessage, ServerToClientMessage } from "./types";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting";

interface EncryptedChatSocketOptions {
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

    const socket = new WebSocket(getWebSocketUrl());
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

    socket.addEventListener("close", () => {
      if (!this.shouldReconnect) {
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

function getWebSocketUrl(): string {
  const configuredUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (configuredUrl) {
    return configuredUrl;
  }

  if (import.meta.env.DEV) {
    return "ws://localhost:3001/ws";
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}
