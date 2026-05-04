# Single Channel E2EE IRC

An experimental single-channel browser-based end-to-end encrypted IRC-like chat.

The server is a WebSocket relay plus a small encrypted file object store. It accepts connections, validates ciphertext envelopes, applies basic rate limits, tracks online count, broadcasts ciphertext to connected browsers, and stores encrypted file chunks. Message plaintext and file plaintext are encrypted and decrypted only in the browser.

## Security Notes

- The server does not receive the browser-entered shared secret.
- The shared secret is also used to derive a channel auth proof. The proof is sent to the server so only users with the shared secret can enter the channel.
- The server does not derive or store the AES key.
- The server does not decrypt messages.
- Plaintext only exists briefly in browser memory.
- Plaintext chat history is not persisted locally or on the server.
- Refreshing the page clears the in-memory plaintext messages and requires the shared secret again.
- Uploaded files are encrypted before upload; the server stores only encrypted chunks and encrypted metadata.
- File downloads are decrypted in the browser. The downloaded plaintext file may be saved by the browser to the user's device.
- Admin APIs manage encrypted file objects only. Admin identity is the configured `ADMIN_NICKNAME` inside the authenticated channel.
- `ADMIN_NICKNAME` is nickname-based administration, not a separate strong account system. Anyone who knows the shared secret and uses that nickname can act as admin.
- If the shared secret leaks, message confidentiality fails.
- If the server serves malicious frontend JavaScript, browser-based E2EE can be bypassed.
- This is an experimental security project and should not be used directly for high-risk production communication.

The client uses PBKDF2-SHA-256 with 250,000 iterations and fixed salt `single-channel-e2ee-irc-v1` to derive an AES-GCM 256-bit encryption key from the user-entered shared secret. It also derives a separate channel auth proof with salt `single-channel-e2ee-irc-v1/auth`. Each message uses a fresh random 12-byte IV.

File transfer uses envelope encryption. The browser generates random per-file key material, wraps it with the shared-secret-derived channel key, imports it as an AES-GCM file key, and encrypts metadata and chunks with fresh IVs.

On HTTPS and localhost, the browser uses WebCrypto. On plain HTTP IP origins, where browsers often disable `crypto.subtle`, the client falls back to a JavaScript AES-GCM/PBKDF2 implementation so IP-based access can still work. HTTP mode is usable, but HTTPS remains the safer deployment mode because HTTP cannot protect the delivered frontend JavaScript from network tampering.

## Project Structure

```text
e2ee-irc/
  apps/
    server/  Node.js + TypeScript + Express + ws relay
    web/     Vite + React + TypeScript + WebCrypto client
```

## Development

Install dependencies:

```bash
npm install
```

Run both apps with a channel secret:

```bash
CHANNEL_SHARED_SECRET=change-me ADMIN_NICKNAME=alice npm run dev
```

Development URLs:

- Web: `http://localhost:5173`
- WebSocket server: `ws://localhost:3001/ws`
- Health check: `http://localhost:3001/health`

For LAN or public IP development through Vite, open `http://<server-ip>:5173`. The client connects its WebSocket to `ws://<server-ip>:3001/ws` by default in development.

Encrypted uploaded files are stored under `/tmp/files` by default. You can override this with `FILE_STORE_DIR=/some/path`. The stored files are ciphertext chunks and encrypted metadata, not plaintext files.

Channel and admin configuration:

```bash
CHANNEL_SHARED_SECRET=change-me ADMIN_NICKNAME=alice npm run dev -w apps/server
```

`CHANNEL_SHARED_SECRET` is convenient for development because the server derives the expected auth proof at startup. For deployments where you do not want the server environment to contain the shared secret, provide `CHANNEL_AUTH_TOKEN` instead. It must equal the client-derived PBKDF2 auth proof for the chosen shared secret.

Admin endpoints:

```bash
curl -H "x-nickname: alice" -H "x-channel-auth: <derived-proof>" http://localhost:3001/admin/files
```

There is no HTTP delete endpoint. Delete encrypted files directly on the server, for example:

```bash
rm -rf /tmp/files/<fileId>
```

## Build

```bash
npm run build
```

## Start

```bash
npm run start
```

`npm run start` starts the built server. After `npm run build`, the server also serves the built frontend from `apps/web/dist` when run from the repository root, so a single origin can host the page, file APIs, and `/ws` WebSocket.

```bash
npm run build
CHANNEL_SHARED_SECRET=change-me ADMIN_NICKNAME=alice npm run start
```

## HTTPS Deployment

Public deployments should use HTTPS. Plain `http://<public-ip>` now works through the JavaScript crypto fallback, but it cannot provide the same frontend integrity guarantees as HTTPS.

Recommended production shape:

- Put the app behind a reverse proxy such as Caddy, Nginx, Cloudflare, or another TLS terminator.
- Use a real domain name with a trusted TLS certificate.
- Proxy WebSocket upgrades for `/ws` to the Node server.

The Node server can also serve HTTPS directly if you provide certificate files:

```bash
npm run build
TLS_CERT_PATH=/path/to/fullchain.pem \
TLS_KEY_PATH=/path/to/privkey.pem \
PORT=3443 \
npm run start
```

If you must use a public IP directly, the certificate still has to be trusted by the browser and valid for that IP address. Most public TLS workflows are domain-based, so using a domain is the practical path.

## WebSocket Configuration

In development the client connects to the current hostname on port `3001`, for example:

```text
ws://localhost:3001/ws
ws://192.168.1.10:3001/ws
```

In production it uses the current host:

```ts
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const url = `${protocol}//${location.host}/ws`;
```

For split frontend/backend deployments, set:

```bash
VITE_WS_URL=wss://example.com/ws
```

## Local Acceptance Checks

1. Start with `CHANNEL_SHARED_SECRET=change-me ADMIN_NICKNAME=alice npm run dev`.
2. Open two browser windows at `http://localhost:5173` or `http://<server-ip>:5173`.
3. Enter the same shared secret in both windows.
4. Send messages both ways and confirm they decrypt.
5. Confirm server logs show connection and ciphertext metadata, not plaintext.
6. Refresh one window and confirm plaintext messages disappear.
7. Try a different shared secret and confirm the client cannot enter the channel.
8. Confirm online count changes when windows join or leave.
9. Upload a file under 20 MB and confirm the other window can download and decrypt it.
10. Use the configured admin nickname to list encrypted file objects, then delete local ciphertext directories under `/tmp/files` if needed.

## Non-Goals

This project intentionally does not implement multi-channel chat, registration, member login, private messages, database persistence, server-side search, plaintext moderation, or server-side chat history.
