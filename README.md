# Single Channel E2EE IRC

An experimental single-channel browser-based end-to-end encrypted IRC-like chat.

The server is a WebSocket relay plus a small encrypted file object store. It accepts connections, validates ciphertext envelopes, applies basic rate limits, tracks online count, broadcasts ciphertext to connected browsers, and stores encrypted file chunks. Message plaintext and file plaintext are encrypted and decrypted only in the browser.

## Security Notes

- The server does not receive the shared secret.
- The server does not derive or store the AES key.
- The server does not decrypt messages.
- Plaintext only exists briefly in browser memory.
- Plaintext chat history is not persisted locally or on the server.
- Refreshing the page clears the in-memory plaintext messages and requires the shared secret again.
- Uploaded files are encrypted before upload; the server stores only encrypted chunks and encrypted metadata.
- File downloads are decrypted in the browser. The downloaded plaintext file may be saved by the browser to the user's device.
- Admin APIs manage encrypted file objects only; admin access does not grant plaintext access unless the admin also knows the shared secret.
- If the shared secret leaks, message confidentiality fails.
- If the server serves malicious frontend JavaScript, browser-based E2EE can be bypassed.
- This is an experimental security project and should not be used directly for high-risk production communication.

The MVP uses PBKDF2-SHA-256 with 250,000 iterations and fixed salt `single-channel-e2ee-irc-v1` to derive an AES-GCM 256-bit key from the user-entered shared secret. Each message uses a fresh random 12-byte IV.

File transfer uses envelope encryption. The browser generates random per-file key material, wraps it with the shared-secret-derived channel key, imports it as an AES-GCM file key, and encrypts metadata and chunks with fresh IVs.

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

Run both apps:

```bash
npm run dev
```

Development URLs:

- Web: `http://localhost:5173`
- WebSocket server: `ws://localhost:3001/ws`
- Health check: `http://localhost:3001/health`

WebCrypto requires a secure browser context. For local development, open the app with `http://localhost:5173`. For LAN or public access, use HTTPS. Browsers may block `crypto.subtle` on plain HTTP origins such as `http://192.168.x.x:5173` or `http://<public-ip>`, and the app cannot safely bypass that browser restriction.

Encrypted uploaded files are stored under `apps/server/data/files` when running the server workspace, or under `data/files` when running the built server from the repository root. The `data` directory is ignored by git.

Optional admin token:

```bash
ADMIN_TOKEN=change-me npm run dev -w apps/server
```

Admin endpoints:

```bash
curl -H "Authorization: Bearer change-me" http://localhost:3001/admin/files
curl -X DELETE -H "Authorization: Bearer change-me" http://localhost:3001/admin/files/<fileId>
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

## HTTPS Deployment

Browser E2EE requires `crypto.subtle`, which means public deployments must use HTTPS. Plain `http://<public-ip>` will fail in browsers that enforce secure-context rules.

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

In development the client connects to:

```text
ws://localhost:3001/ws
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

1. Open two browser windows at `http://localhost:5173`.
2. Enter the same shared secret in both windows.
3. Send messages both ways and confirm they decrypt.
4. Confirm server logs show connection and ciphertext metadata, not plaintext.
5. Refresh one window and confirm plaintext messages disappear.
6. Rejoin one window with a different shared secret and confirm decrypt failure system messages appear.
7. Confirm online count changes when windows join or leave.
8. Upload a file under 20 MB and confirm the other window can download and decrypt it.
9. Rejoin one window with a different shared secret and confirm file credential decryption fails.
10. Use the admin API to list and delete encrypted file objects.

## Non-Goals

This project intentionally does not implement multi-channel chat, registration, member login, private messages, database persistence, server-side search, plaintext moderation, or server-side chat history.
