/**
 * Key derivation compatible with Phantom, Solflare and Backpack:
 * BIP39 mnemonic → seed → SLIP-0010 ed25519 → m/44'/501'/{index}'/0'.
 * Pure functions; secrets never leave the caller.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import bs58 from "bs58";

const HARDENED = 0x80000000;
const enc = new TextEncoder();

export const newMnemonic = (words: 12 | 24 = 12) => generateMnemonic(wordlist, words === 24 ? 256 : 128);
export const isValidMnemonic = (m: string) => validateMnemonic(normalizeMnemonic(m), wordlist);
export const normalizeMnemonic = (m: string) => m.trim().toLowerCase().split(/\s+/).join(" ");

/** SLIP-0010 for ed25519 (hardened-only). Returns the 32-byte private key for the path. */
export function slip10(seed: Uint8Array, path: number[]): Uint8Array {
  let I = hmac(sha512, enc.encode("ed25519 seed"), seed);
  let key = I.slice(0, 32), chain = I.slice(32);
  for (const index of path) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, (index | HARDENED) >>> 0, false);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32); chain = I.slice(32);
  }
  return key;
}

export const solanaPath = (index: number) => [44, 501, index, 0];

export interface Keypair { publicKey: Uint8Array; secretKey: Uint8Array /* 32-byte seed */; address: string }

export function keypairFromSeed32(secret: Uint8Array): Keypair {
  const publicKey = ed25519.getPublicKey(secret);
  return { publicKey, secretKey: secret, address: bs58.encode(publicKey) };
}

export function deriveAccount(mnemonic: string, index: number): Keypair {
  const seed = mnemonicToSeedSync(normalizeMnemonic(mnemonic));
  return keypairFromSeed32(slip10(seed, solanaPath(index)));
}

/** Import a base58 private key as exported by Phantom/Solflare (64 bytes: seed‖pubkey) or a 32-byte seed. */
export function keypairFromBase58(secret: string): Keypair {
  const raw = bs58.decode(secret.trim());
  if (raw.length === 64) {
    const kp = keypairFromSeed32(raw.slice(0, 32));
    if (bs58.encode(raw.slice(32)) !== kp.address) throw new Error("Private key and public key don't match.");
    return kp;
  }
  if (raw.length === 32) return keypairFromSeed32(raw);
  throw new Error("That isn't a Solana private key.");
}

export const sign = (message: Uint8Array, secret: Uint8Array) => ed25519.sign(message, secret);
export const verify = (sig: Uint8Array, message: Uint8Array, pub: Uint8Array) => ed25519.verify(sig, message, pub);
