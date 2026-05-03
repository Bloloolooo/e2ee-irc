# Single Channel E2EE IRC

An experimental single-channel browser-based end-to-end encrypted IRC-like chat.

The server is a WebSocket relay. It accepts connections, validates ciphertext envelopes, applies basic rate limits, tracks online count, and broadcasts ciphertext to connected browsers. Message plaintext is encrypted and decrypted only in the browser.

## Security Notes

- The server does not receive the shared secret.
- The server does not derive or store the AES key.
- The server does not decrypt messages.
- Plaintext only exists briefly in browser memory.
- Plaintext chat history is not persisted locally or on the server.
- Refreshing the page clears the in-memory plaintext messages and requires the shared secret again.
- If the shared secret leaks, message confidentiality fails.
- If the server serves malicious frontend JavaScript, browser-based E2EE can be bypassed.
- This is an experimental security project and should not be used directly for high-risk production communication.

The MVP uses PBKDF2-SHA-256 with 250,000 iterations and fixed salt `single-channel-e2ee-irc-v1` to derive an AES-GCM 256-bit key from the user-entered shared secret. Each message uses a fresh random 12-byte IV.

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

## Build

```bash
npm run build
```

## Start

```bash
npm run start
```

`npm run start` starts the built server. In a production deployment, build the web app and serve `apps/web/dist` with your static host or reverse proxy WebSocket requests to `/ws`.

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

## Non-Goals

This MVP intentionally does not implement multi-channel chat, registration, login, private messages, database persistence, server-side search, plaintext moderation, or server-side chat history.
