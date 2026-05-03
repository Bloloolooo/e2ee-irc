import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { FileStore, MAX_CHUNK_BYTES } from "./fileStore.js";
import { ConnectionRateLimiter } from "./rateLimit.js";
import {
  parseClientMessage,
  serializeServerMessage,
  type ServerToClientMessage
} from "./protocol.js";

const PORT = Number(process.env.PORT ?? 3001);
const MAX_MESSAGE_BYTES = 8 * 1024;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

interface ClientState {
  connectionId: string;
  limiter: ConnectionRateLimiter;
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Map<WebSocket, ClientState>();
const fileStore = new FileStore(path.resolve(process.cwd(), "data", "files"));

app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, onlineCount: clients.size });
});

app.post("/files", async (req, res) => {
  try {
    const manifest = await fileStore.createManifest(req.body);
    res.status(201).json({
      fileId: manifest.fileId,
      expiresAt: manifest.expiresAt,
      chunkCount: manifest.chunkCount
    });
  } catch (error) {
    sendHttpError(res, error);
  }
});

app.put(
  "/files/:fileId/chunks/:index",
  express.raw({
    type: "application/octet-stream",
    limit: MAX_CHUNK_BYTES
  }),
  async (req, res) => {
    try {
      const index = Number(req.params.index);
      const iv = req.header("x-chunk-iv") ?? "";
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const manifest = await fileStore.putChunk(req.params.fileId, index, iv, body);
      res.json({
        fileId: manifest.fileId,
        index,
        uploaded: true
      });
    } catch (error) {
      sendHttpError(res, error);
    }
  }
);

app.get("/files/:fileId/manifest", async (req, res) => {
  try {
    res.json(await fileStore.getPublicManifest(req.params.fileId));
  } catch (error) {
    sendHttpError(res, error);
  }
});

app.get("/files/:fileId/chunks/:index", async (req, res) => {
  try {
    const chunk = await fileStore.getChunk(req.params.fileId, Number(req.params.index));
    res.type("application/octet-stream").send(chunk);
  } catch (error) {
    sendHttpError(res, error);
  }
});

app.get("/admin/files", requireAdmin, async (_req, res) => {
  try {
    res.json({ files: await fileStore.listAdminFiles() });
  } catch (error) {
    sendHttpError(res, error);
  }
});

app.delete("/admin/files/:fileId", requireAdmin, async (req, res) => {
  try {
    await fileStore.deleteFile(req.params.fileId);
    res.status(204).send();
  } catch (error) {
    sendHttpError(res, error);
  }
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

void fileStore.ensureReady();
setInterval(() => {
  fileStore.cleanupExpired().catch((error) => {
    console.warn("file cleanup failed", { message: error.message });
  });
}, 60 * 60 * 1000).unref();

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

function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
}

function sendHttpError(res: express.Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "unknown_error";
  const status = errorStatus(message);
  res.status(status).json({ error: message });
}

function errorStatus(message: string): number {
  if (message.includes("expired") || message.includes("missing") || message.includes("incomplete")) {
    return 404;
  }

  if (message.includes("invalid") || message.includes("exceeded") || message.includes("large")) {
    return 400;
  }

  return 500;
}
