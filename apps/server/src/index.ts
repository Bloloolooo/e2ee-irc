import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { ConnectionRateLimiter } from "./rateLimit.js";
import {
  parseClientMessage,
  serializeServerMessage,
  type ServerToClientMessage
} from "./protocol.js";

const PORT = Number(process.env.PORT ?? 3001);
const MAX_MESSAGE_BYTES = 8 * 1024;

interface ClientState {
  connectionId: string;
  limiter: ConnectionRateLimiter;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Map<WebSocket, ClientState>();

app.get("/health", (_req, res) => {
  res.json({ ok: true, onlineCount: clients.size });
});

wss.on("connection", (socket, req) => {
  const connectionId = crypto.randomUUID();
  clients.set(socket, {
    connectionId,
    limiter: new ConnectionRateLimiter()
  });

  console.info("client connected", {
    connectionId,
    onlineCount: clients.size,
    remoteAddress: req.socket.remoteAddress
  });

  send(socket, {
    type: "server.welcome",
    version: 1,
    connectionId,
    onlineCount: clients.size
  });
  broadcastPresence();

  socket.on("message", (data) => {
    const state = clients.get(socket);
    if (!state) {
      return;
    }

    if (!state.limiter.allow()) {
      send(socket, { type: "server.error", error: "rate_limited" });
      return;
    }

    const raw = normalizeMessage(data);
    if (!raw || Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) {
      send(socket, { type: "server.error", error: "message_too_large" });
      return;
    }

    const message = parseClientMessage(raw);
    if (!message) {
      send(socket, { type: "server.error", error: "invalid_message" });
      return;
    }

    console.info("relay ciphertext", {
      connectionId: state.connectionId,
      messageId: message.id,
      sender: message.sender,
      sentAt: message.sentAt,
      ciphertextBytes: Buffer.byteLength(message.ciphertext, "utf8")
    });

    broadcast(message);
  });

  socket.on("close", () => {
    clients.delete(socket);
    console.info("client disconnected", {
      connectionId,
      onlineCount: clients.size
    });
    broadcastPresence();
  });

  socket.on("error", (error) => {
    console.warn("websocket error", {
      connectionId,
      message: error.message
    });
  });
});

server.listen(PORT, () => {
  console.info(`e2ee-irc server listening on http://localhost:${PORT}`);
});

function normalizeMessage(data: WebSocket.RawData): string | null {
  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  return null;
}

function broadcastPresence(): void {
  broadcast({
    type: "server.presence",
    onlineCount: clients.size
  });
}

function broadcast(message: ServerToClientMessage): void {
  const payload = serializeServerMessage(message);
  for (const client of clients.keys()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function send(socket: WebSocket, message: ServerToClientMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(serializeServerMessage(message));
  }
}
