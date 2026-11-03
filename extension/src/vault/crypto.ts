/**
 * Password-based encryption for the vault: PBKDF2-SHA256 (600k iterations, OWASP
 * 2023+) → AES-256-GCM, via WebCrypto (native, available in the service worker).
 */
import { b64 } from "~/shared/tx";

export interface Sealed { v: 1; kdf: { alg: "PBKDF2-SHA256"; iterations: number; salt: string }; iv: string; ct: string }

const ITERATIONS = 600_000;
const enc = new TextEncoder(), dec = new TextDecoder();

export async function deriveKey(password: string, salt: Uint8Array, iterations = ITERATIONS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function seal(data: unknown, key: CryptoKey, salt: Uint8Array, iterations = ITERATIONS): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data))));
  return { v: 1, kdf: { alg: "PBKDF2-SHA256", iterations, salt: b64.enc(salt) }, iv: b64.enc(iv), ct: b64.enc(ct) };
}

/** Throws on a wrong password (GCM authentication fails). */
export async function open<T>(s: Sealed, key: CryptoKey): Promise<T> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.dec(s.iv) as BufferSource }, key, b64.dec(s.ct) as BufferSource);
  return JSON.parse(dec.decode(pt)) as T;
}

export const newSalt = () => crypto.getRandomValues(new Uint8Array(16));
export const exportKey = async (k: CryptoKey) => b64.enc(new Uint8Array(await crypto.subtle.exportKey("raw", k)));
export const importKey = (raw: string) => crypto.subtle.importKey("raw", b64.dec(raw) as BufferSource, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
