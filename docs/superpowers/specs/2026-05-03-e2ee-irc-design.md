# Single Channel E2EE IRC Design

## Scope

Build an MVP single-channel browser chat where every participant manually enters a nickname and shared secret. The shared secret stays in browser memory, is used to derive an AES-GCM key with WebCrypto, and is never sent to the server. The server is only a WebSocket relay for ciphertext envelopes and presence events.

## Architecture

- `apps/web`: Vite, React, TypeScript, WebCrypto, and WebSocket.
- `apps/server`: Node.js, TypeScript, Express, and `ws`.
- Root npm workspaces run development, build, and start commands across both apps.

The frontend owns all plaintext handling. The backend accepts connections on `/ws`, sends a welcome message, broadcasts presence changes, validates ciphertext envelope shape and size, rate-limits each connection, and broadcasts valid ciphertext to all connected clients.

## Security Model

The server may see IP addresses, connection count, message timing, sender nickname metadata, ciphertext size, IV, and ciphertext. It must not receive the shared secret, AES key, plaintext body, or decrypted chat history. Plaintext messages are held only in React memory and are lost on refresh, leave, or local clear.

PBKDF2-SHA-256 with 250,000 iterations derives an AES-GCM 256-bit key from the user-provided shared secret and fixed MVP salt `single-channel-e2ee-irc-v1`. Each encrypted message uses a fresh 12-byte random IV.

## UX

The first screen is a join form with nickname and password-style shared secret input plus a warning that the secret only lives in memory. After joining, the chat screen shows connection status, online count, nickname, an in-memory message list, a message composer, and controls to clear local messages or leave.

System messages cover connection, disconnection, reconnect attempts, decryption failure, message length failures, and send/encrypt errors. Failed decryptions never expose ciphertext in the UI.

## Testing

Verification will include TypeScript builds for both apps. Local functional checks should cover two browser windows with the same secret, different-secret decrypt failure, refresh clearing local plaintext, online count changes, and confirming server logs do not print complete message bodies.
