const KEY_SALT = "single-channel-e2ee-irc-v1";
const AUTH_SALT = "single-channel-e2ee-irc-v1/auth";
const PBKDF2_ITERATIONS = 250_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let nobleCryptoPromise: Promise<NobleCrypto> | null = null;

interface NobleCrypto {
  gcm: (
    key: Uint8Array,
    nonce: Uint8Array
  ) => {
    encrypt(plaintext: Uint8Array): Uint8Array;
    decrypt(ciphertext: Uint8Array): Uint8Array;
  };
  pbkdf2: (
    hash: never,
    password: Uint8Array,
    salt: Uint8Array,
    options: { c: number; dkLen: number }
  ) => Uint8Array;
  sha256: never;
}

export type AppCryptoKey =
  | {
      kind: "webcrypto";
      key: CryptoKey;
    }
  | {
      kind: "js";
      keyBytes: Uint8Array;
    };

export interface DerivedChannelKeys {
  key: AppCryptoKey;
  authProof: string;
}

export class WebCryptoUnavailableError extends Error {
  constructor() {
    super("webcrypto_unavailable");
    this.name = "WebCryptoUnavailableError";
  }
}

export function isWebCryptoAvailable(): boolean {
  return Boolean(globalThis.crypto?.subtle && globalThis.isSecureContext);
}

export async function deriveKeyFromSecret(secret: string): Promise<DerivedChannelKeys> {
  if (!hasRandomValues()) {
    throw new WebCryptoUnavailableError();
  }

  if (!isWebCryptoAvailable()) {
    return deriveKeyWithJsCrypto(secret);
  }

  const subtle = globalThis.crypto.subtle;
  const baseKey = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const authBaseKey = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const [key, authBits] = await Promise.all([
    subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: encoder.encode(KEY_SALT),
        iterations: PBKDF2_ITERATIONS
      },
      baseKey,
      {
        name: "AES-GCM",
        length: 256
      },
      false,
      ["encrypt", "decrypt"]
    ),
    subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: encoder.encode(AUTH_SALT),
        iterations: PBKDF2_ITERATIONS
      },
      authBaseKey,
      256
    )
  ]);

  return {
    key: { kind: "webcrypto", key },
    authProof: bytesToBase64(new Uint8Array(authBits))
  };
}

async function deriveKeyWithJsCrypto(secret: string): Promise<DerivedChannelKeys> {
  const noble = await loadNobleCrypto();
  const secretBytes = encoder.encode(secret);
  return {
    key: {
      kind: "js",
      keyBytes: noble.pbkdf2(noble.sha256, secretBytes, encoder.encode(KEY_SALT), {
        c: PBKDF2_ITERATIONS,
        dkLen: 32
      })
    },
    authProof: bytesToBase64(
      noble.pbkdf2(noble.sha256, secretBytes, encoder.encode(AUTH_SALT), {
        c: PBKDF2_ITERATIONS,
        dkLen: 32
      })
    )
  };
}

export function randomBytes(length: number): Uint8Array {
  if (!hasRandomValues()) {
    throw new WebCryptoUnavailableError();
  }

  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));

  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join("")
  ].join("-");
}

export async function encryptMessage(
  key: AppCryptoKey,
  plaintext: object
): Promise<{ iv: string; ciphertext: string }> {
  const encrypted = await encryptBytes(key, encoder.encode(JSON.stringify(plaintext)));

  return {
    iv: encrypted.iv,
    ciphertext: bytesToBase64(encrypted.ciphertext)
  };
}

export async function encryptBytes(
  key: AppCryptoKey,
  plaintext: Uint8Array
): Promise<{ iv: string; ciphertext: Uint8Array }> {
  const iv = randomBytes(12);

  if (key.kind === "js") {
    const noble = await loadNobleCrypto();
    return {
      iv: bytesToBase64(iv),
      ciphertext: noble.gcm(key.keyBytes, iv).encrypt(plaintext)
    };
  }

  const subtle = getSubtleCrypto();
  const encrypted = await subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key.key,
    toArrayBuffer(plaintext)
  );

  return {
    iv: bytesToBase64(iv),
    ciphertext: new Uint8Array(encrypted)
  };
}

export async function decryptBytes(
  key: AppCryptoKey,
  ivBase64: string,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  const iv = base64ToBytes(ivBase64);

  if (key.kind === "js") {
    const noble = await loadNobleCrypto();
    return noble.gcm(key.keyBytes, iv).decrypt(ciphertext);
  }

  const subtle = getSubtleCrypto();
  const decrypted = await subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key.key,
    toArrayBuffer(ciphertext)
  );

  return new Uint8Array(decrypted);
}

export function importAesGcmKey(rawKey: Uint8Array): AppCryptoKey {
  return {
    kind: "js",
    keyBytes: new Uint8Array(rawKey)
  };
}

export async function decryptMessage<T>(
  key: AppCryptoKey,
  ivBase64: string,
  ciphertextBase64: string
): Promise<T> {
  const decrypted = await decryptBytes(key, ivBase64, base64ToBytes(ciphertextBase64));

  return JSON.parse(decoder.decode(decrypted)) as T;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function getSubtleCrypto(): SubtleCrypto {
  if (!isWebCryptoAvailable()) {
    throw new WebCryptoUnavailableError();
  }

  return globalThis.crypto.subtle;
}

function hasRandomValues(): boolean {
  return typeof globalThis.crypto?.getRandomValues === "function";
}

function loadNobleCrypto(): Promise<NobleCrypto> {
  if (!nobleCryptoPromise) {
    nobleCryptoPromise = Promise.all([
      import("@noble/ciphers/aes.js"),
      import("@noble/hashes/pbkdf2.js"),
      import("@noble/hashes/sha2.js")
    ]).then(([aes, pbkdf2Module, sha2]) => ({
      gcm: aes.gcm,
      pbkdf2: pbkdf2Module.pbkdf2,
      sha256: sha2.sha256
    }) as unknown as NobleCrypto);
  }

  return nobleCryptoPromise;
}
