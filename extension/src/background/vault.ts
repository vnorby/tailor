/**
 * Vault lifecycle in the background worker.
 *
 * chrome.storage.local  — `vault` (sealed secrets) and `meta` (public: account list,
 *                          active account, settings, connected sites). No secrets.
 * chrome.storage.session — the AES key while unlocked, so a service-worker restart
 *                          doesn't lock the wallet. Session storage lives in memory
 *                          only and is unreadable by content scripts (TRUSTED_CONTEXTS).
 * Decrypted secrets are held in this module's memory and nowhere else.
 */
import { deriveAccount, isValidMnemonic, keypairFromBase58, normalizeMnemonic, type Keypair } from "~/vault/derive";
import { deriveKey, exportKey, importKey as importAesKey, newSalt, open, seal, type Sealed } from "~/vault/crypto";
import { b64 } from "~/shared/tx";
import type { AccountMeta, WalletState } from "~/shared/messages";
import bs58 from "bs58";

interface Secrets { mnemonic?: string; imported: Record<string, string /* base58 secret */> }
interface Meta {
  accounts: AccountMeta[];
  activeId: string | null;
  autoLockMinutes: number;
  apiBase: string;
  sites: Record<string, { connectedAt: number }>;
  nextIndex: number;
}

const DEFAULT_API = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:3210";
const defaultMeta = (): Meta => ({ accounts: [], activeId: null, autoLockMinutes: 15, apiBase: DEFAULT_API, sites: {}, nextIndex: 0 });

let secrets: Secrets | null = null;
let aesKey: CryptoKey | null = null;
const keyCache = new Map<string, Keypair>();

export async function getMeta(): Promise<Meta> {
  const { meta } = await chrome.storage.local.get("meta");
  return { ...defaultMeta(), ...(meta as Partial<Meta> | undefined) };
}
export async function setMeta(m: Meta) { await chrome.storage.local.set({ meta: m }); }

async function getSealed(): Promise<(Sealed & { kdf: Sealed["kdf"] }) | null> {
  const { vault } = await chrome.storage.local.get("vault");
  return (vault as Sealed | undefined) ?? null;
}

async function persist() {
  if (!secrets || !aesKey) throw new Error("Locked");
  const sealed = await getSealed();
  if (!sealed) throw new Error("No vault");
  await chrome.storage.local.set({ vault: await seal(secrets, aesKey, b64.dec(sealed.kdf.salt), sealed.kdf.iterations) });
}

async function startSession(key: CryptoKey) {
  aesKey = key;
  await chrome.storage.session.set({ k: await exportKey(key) });
  await bumpAutoLock();
}

export async function bumpAutoLock() {
  const m = await getMeta();
  await chrome.alarms.create("autolock", { delayInMinutes: Math.max(1, m.autoLockMinutes) });
}

/** After a service-worker restart, re-open the vault with the session key if the wallet was unlocked. */
export async function restore(): Promise<boolean> {
  if (secrets) return true;
  const { k } = await chrome.storage.session.get("k");
  const sealed = await getSealed();
  if (!k || !sealed) return false;
  try { aesKey = await importAesKey(k as string); secrets = await open<Secrets>(sealed, aesKey); return true; }
  catch { await lock(); return false; }
}

export async function state(): Promise<WalletState> {
  const [sealed, m] = await Promise.all([getSealed(), getMeta()]);
  const unlocked = await restore();
  return { initialized: !!sealed, unlocked, accounts: m.accounts, activeId: m.activeId, autoLockMinutes: m.autoLockMinutes, apiBase: m.apiBase };
}

function checkPassword(pw: string) {
  if (pw.length < 8) throw new Error("Use a password of at least 8 characters.");
}

export async function create(password: string, mnemonic: string, privateKey?: string) {
  if (await getSealed()) throw new Error("A wallet already exists. Remove it first.");
  checkPassword(password);
  const salt = newSalt();
  const key = await deriveKey(password, salt);
  const m = defaultMeta();
  secrets = { imported: {} };
  if (mnemonic) {
    if (!isValidMnemonic(mnemonic)) throw new Error("That recovery phrase isn't valid.");
    secrets.mnemonic = normalizeMnemonic(mnemonic);
    const kp = deriveAccount(secrets.mnemonic, 0);
    m.accounts.push({ id: crypto.randomUUID(), name: "Account 1", address: kp.address, kind: "derived", index: 0 });
    m.nextIndex = 1;
  } else if (privateKey) {
    const kp = keypairFromBase58(privateKey);
    const id = crypto.randomUUID();
    secrets.imported[id] = bs58.encode(kp.secretKey);
    m.accounts.push({ id, name: "Imported 1", address: kp.address, kind: "imported" });
  } else throw new Error("Provide a recovery phrase or private key.");
  m.activeId = m.accounts[0].id;
  await chrome.storage.local.set({ vault: await seal(secrets, key, salt), meta: m });
  await startSession(key);
}

export async function unlock(password: string) {
  const sealed = await getSealed();
  if (!sealed) throw new Error("No wallet yet.");
  const key = await deriveKey(password, b64.dec(sealed.kdf.salt), sealed.kdf.iterations);
  try { secrets = await open<Secrets>(sealed, key); } catch { throw new Error("Wrong password."); }
  await startSession(key);
}

export async function lock() {
  secrets = null; aesKey = null; keyCache.clear();
  await chrome.storage.session.remove("k");
  await chrome.alarms.clear("autolock");
}

async function requireUnlocked() {
  if (!(await restore()) || !secrets) throw new Error("Wallet is locked.");
  return secrets;
}

/** Keypair for an address we control. Never leaves the background worker. */
export async function keypairFor(address: string): Promise<Keypair> {
  const s = await requireUnlocked();
  const cached = keyCache.get(address);
  if (cached) return cached;
  const acct = (await getMeta()).accounts.find((a) => a.address === address);
  if (!acct || acct.kind === "watch") throw new Error("This account can't sign (watch-only or unknown).");
  if (acct.kind === "ledger") throw new Error("This is a Ledger account: it signs on the device.");
  const kp = acct.kind === "derived" ? deriveAccount(s.mnemonic!, acct.index!) : keypairFromBase58(s.imported[acct.id]);
  if (kp.address !== address) throw new Error("Key mismatch.");
  keyCache.set(address, kp);
  return kp;
}

export async function addDerived(name?: string) {
  const s = await requireUnlocked();
  if (!s.mnemonic) throw new Error("This wallet was imported from a private key; add accounts by importing more keys.");
  const m = await getMeta();
  const index = m.nextIndex;
  const kp = deriveAccount(s.mnemonic, index);
  const acct: AccountMeta = { id: crypto.randomUUID(), name: name || `Account ${m.accounts.filter((a) => a.kind === "derived").length + 1}`, address: kp.address, kind: "derived", index };
  m.accounts.push(acct); m.nextIndex = index + 1; m.activeId = acct.id;
  await setMeta(m);
  return acct;
}

export async function importKey(privateKey: string, name?: string) {
  const s = await requireUnlocked();
  const kp = keypairFromBase58(privateKey);
  const m = await getMeta();
  if (m.accounts.some((a) => a.address === kp.address && a.kind !== "watch")) throw new Error("That account is already in your wallet.");
  const acct: AccountMeta = { id: crypto.randomUUID(), name: name || `Imported ${m.accounts.filter((a) => a.kind === "imported").length + 1}`, address: kp.address, kind: "imported" };
  s.imported[acct.id] = bs58.encode(kp.secretKey);
  await persist();
  m.accounts.push(acct); m.activeId = acct.id;
  await setMeta(m);
  return acct;
}

export async function addWatch(address: string, name?: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) || bs58.decode(address).length !== 32) throw new Error("Not a valid Solana address.");
  const m = await getMeta();
  const acct: AccountMeta = { id: crypto.randomUUID(), name: name || `Watching ${address.slice(0, 4)}`, address, kind: "watch" };
  m.accounts.push(acct); m.activeId = acct.id;
  await setMeta(m);
  return acct;
}

/** Ledger accounts store only their address and device path; signing happens on the device. */
export async function addLedger(accounts: { address: string; path: string }[]) {
  const m = await getMeta();
  let last: AccountMeta | null = null;
  for (const a of accounts.slice(0, 10)) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.address) || bs58.decode(a.address).length !== 32 || !/^44'\/501'(\/\d+'){1,2}$/.test(a.path)) throw new Error("Invalid Ledger account.");
    if (m.accounts.some((x) => x.address === a.address && x.kind === "ledger")) continue;
    last = { id: crypto.randomUUID(), name: `Ledger ${m.accounts.filter((x) => x.kind === "ledger").length + 1}`, address: a.address, kind: "ledger", path: a.path };
    m.accounts.push(last);
  }
  if (last) m.activeId = last.id;
  await setMeta(m);
  return last;
}

export async function removeAccount(id: string) {
  const m = await getMeta();
  if (m.accounts.length <= 1) throw new Error("You can't remove your only account.");
  const acct = m.accounts.find((a) => a.id === id);
  if (!acct) return;
  if (acct.kind === "imported") { const s = await requireUnlocked(); delete s.imported[id]; await persist(); }
  keyCache.delete(acct.address);
  m.accounts = m.accounts.filter((a) => a.id !== id);
  if (m.activeId === id) m.activeId = m.accounts[0].id;
  await setMeta(m);
}

/** Show secrets only after re-entering the password, even while unlocked. */
export async function reveal(password: string, what: "mnemonic" | "privateKey", id?: string): Promise<string> {
  const sealed = await getSealed();
  if (!sealed) throw new Error("No wallet.");
  const key = await deriveKey(password, b64.dec(sealed.kdf.salt), sealed.kdf.iterations);
  let s: Secrets;
  try { s = await open<Secrets>(sealed, key); } catch { throw new Error("Wrong password."); }
  if (what === "mnemonic") { if (!s.mnemonic) throw new Error("This wallet has no recovery phrase."); return s.mnemonic; }
  const acct = (await getMeta()).accounts.find((a) => a.id === id);
  if (!acct || acct.kind === "watch" || acct.kind === "ledger") throw new Error("No private key for this account.");
  const kp = acct.kind === "derived" ? deriveAccount(s.mnemonic!, acct.index!) : keypairFromBase58(s.imported[acct.id]);
  return bs58.encode(new Uint8Array([...kp.secretKey, ...kp.publicKey]));
}

export async function activeAccount(): Promise<AccountMeta | null> {
  const m = await getMeta();
  return m.accounts.find((a) => a.id === m.activeId) ?? null;
}

/** The vault key, released only after re-entering the password (used to set up passkey unlock). */
export async function exportVaultKey(password: string): Promise<string> {
  const sealed = await getSealed();
  if (!sealed) throw new Error("No wallet.");
  const key = await deriveKey(password, b64.dec(sealed.kdf.salt), sealed.kdf.iterations);
  try { await open<Secrets>(sealed, key); } catch { throw new Error("Wrong password."); }
  return exportKey(key);
}

/** Unlock with a raw vault key (recovered via passkey). The vault itself proves the key is right. */
export async function unlockWithKey(raw: string) {
  const sealed = await getSealed();
  if (!sealed) throw new Error("No wallet yet.");
  let key: CryptoKey;
  try { key = await importAesKey(raw); secrets = await open<Secrets>(sealed, key); } catch { throw new Error("That passkey no longer unlocks this wallet. Use your password."); }
  await startSession(key);
}
