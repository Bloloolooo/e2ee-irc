import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const AUTH_SALT = "single-channel-e2ee-irc-v1/auth";
const PBKDF2_ITERATIONS = 250_000;
const CHANNEL_AUTH_TOKEN =
  process.env.CHANNEL_AUTH_TOKEN ?? deriveAuthToken(process.env.CHANNEL_SHARED_SECRET);
const ADMIN_NICKNAME = process.env.ADMIN_NICKNAME;
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST_DIR =
  process.env.WEB_DIST_DIR ?? path.resolve(CURRENT_DIR, "..", "..", "web", "dist");

interface ClientState {
  connectionId: string;
  nickname: string;
  limiter: ConnectionRateLimiter;
}

const app = express();
const server = createHttpServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Map<WebSocket, ClientState>();
const fileStore = new FileStore(path.resolve(process.cwd(), "data", "files"));

app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, onlineCount: clients.size });
});

app.post("/files", requireChannelAuth, async (req, res) => {
  try {
    const manifest = await fileStore.createManifest({
      ...req.body,
      uploader: req.header("x-nickname") ?? ""
    });
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
  requireChannelAuth,
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

app.get("/files/:fileId/manifest", requireChannelAuth, async (req, res) => {
  try {
    res.json(await fileStore.getPublicManifest(req.params.fileId));
  } catch (error) {
    sendHttpError(res, error);
  }
});

app.get("/files/:fileId/chunks/:index", requireChannelAuth, async (req, res) => {
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

if (fs.existsSync(WEB_DIST_DIR)) {
  app.use(express.static(WEB_DIST_DIR));
  app.get("*", (req, res, next) => {
    if (
      req.path.startsWith("/files") ||
      req.path.startsWith("/admin") ||
      req.path.startsWith("/health") ||
      req.path.startsWith("/ws")
    ) {
      next();
      return;
    }

    res.sendFile(path.join(WEB_DIST_DIR, "index.html"));
  });
}

wss.on("connection", (socket, req) => {
  const auth = getWebSocketAuth(req);
  if (!isAuthorizedChannelMember(auth.nickname, auth.proof)) {
    socket.send(serializeServerMessage({
      type: "server.error",
      error: CHANNEL_AUTH_TOKEN ? "invalid_channel_key" : "channel_auth_not_configured"
    }));
    socket.close(1008, "invalid_channel_key");
    return;
  }

  const connectionId = crypto.randomUUID();
  clients.set(socket, {
    connectionId,
    nickname: auth.nickname,
    limiter: new ConnectionRateLimiter()
  });

  console.info("client connected", {
    connectionId,
    nickname: auth.nickname,
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
      nickname: auth.nickname,
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
  const protocol = isHttpsServer() ? "https" : "http";
  console.info(`e2ee-irc server listening on ${protocol}://localhost:${PORT}`);
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

function createHttpServer(appInstance: express.Express): http.Server | https.Server {
  if (TLS_CERT_PATH && TLS_KEY_PATH) {
    return https.createServer(
      {
        cert: fs.readFileSync(TLS_CERT_PATH),
        key: fs.readFileSync(TLS_KEY_PATH)
      },
      appInstance
    );
  }

  return http.createServer(appInstance);
}

function deriveAuthToken(secret: string | undefined): string | undefined {
  if (!secret) {
    return undefined;
  }

  return crypto
    .pbkdf2Sync(secret, AUTH_SALT, PBKDF2_ITERATIONS, 32, "sha256")
    .toString("base64");
}

function requireChannelAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const nickname = req.header("x-nickname") ?? "";
  const proof = req.header("x-channel-auth") ?? "";

  if (!CHANNEL_AUTH_TOKEN) {
    res.status(503).json({ error: "channel_auth_not_configured" });
    return;
  }

  if (!isAuthorizedChannelMember(nickname, proof)) {
    res.status(401).json({ error: "invalid_channel_key" });
    return;
  }

  next();
}

function isHttpsServer(): boolean {
  return Boolean(TLS_CERT_PATH && TLS_KEY_PATH);
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
  const nickname = req.header("x-nickname") ?? "";
  const proof = req.header("x-channel-auth") ?? "";

  if (!CHANNEL_AUTH_TOKEN) {
    res.status(503).json({ error: "channel_auth_not_configured" });
    return;
  }

  if (!isAuthorizedChannelMember(nickname, proof)) {
    res.status(401).json({ error: "invalid_channel_key" });
    return;
  }

  if (!ADMIN_NICKNAME || nickname !== ADMIN_NICKNAME) {
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

function getWebSocketAuth(req: http.IncomingMessage): {
  nickname: string;
  proof: string;
} {
  const url = new URL(req.url ?? "/ws", "http://localhost");
  return {
    nickname: url.searchParams.get("nickname") ?? "",
    proof: url.searchParams.get("auth") ?? ""
  };
}

function isAuthorizedChannelMember(nickname: string, proof: string): boolean {
  if (!CHANNEL_AUTH_TOKEN) {
    return false;
  }

  if (!isValidNickname(nickname) || !proof) {
    return false;
  }

  const expected = Buffer.from(CHANNEL_AUTH_TOKEN, "utf8");
  const actual = Buffer.from(proof, "utf8");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function isValidNickname(nickname: string): boolean {
  return nickname.length >= 1 && nickname.length <= 40;
}
