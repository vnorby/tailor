/**
 * Unlock with Touch ID / a passkey via the WebAuthn PRF extension.
 *
 * Setup: after the password is re-entered, the background releases the vault key; the
 * passkey's PRF output (a secret only the authenticator can produce, after user
 * verification) derives a wrapping key that encrypts it. Unlock: the passkey reproduces
 * the PRF output, the vault key is unwrapped and handed to the background, which checks
 * it by decrypting the vault. The password itself is never stored.
 */
import { call, type WalletState } from "~/shared/messages";
import { b64 } from "~/shared/tx";

interface Record_ { credentialId: string; salt: string; iv: string; wrapped: string }

const RP_NAME = "Tailor";
const enc = new TextEncoder();

async function wrappingKey(prf: ArrayBuffer, salt: Uint8Array) {
  const base = await crypto.subtle.importKey("raw", prf, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: enc.encode("tailor-vault-unlock-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

export async function passkeyRecord(): Promise<Record_ | null> {
  const { passkey } = await chrome.storage.local.get("passkey");
  return (passkey as Record_ | undefined) ?? null;
}

export const passkeysAvailable = () => typeof PublicKeyCredential !== "undefined";

export async function enablePasskey(password: string): Promise<void> {
  const vaultKey = await call<string>({ type: "exportVaultKey", password });
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: RP_NAME, id: chrome.runtime.id },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "Tailor wallet", displayName: "Tailor wallet" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey setup was cancelled.");
  let prf = (cred.getClientExtensionResults() as PrfResults).prf;
  if (!prf?.enabled && !prf?.results?.first) throw new Error("This device's passkeys don't support the secure unlock Tailor needs (WebAuthn PRF).");
  // Some authenticators only return PRF output on get(), not create().
  let out = prf.results?.first;
  if (!out) { out = await evaluate(new Uint8Array(cred.rawId), salt); }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wrappingKey(out, salt), b64.dec(vaultKey) as BufferSource);
  await chrome.storage.local.set({ passkey: { credentialId: b64.enc(new Uint8Array(cred.rawId)), salt: b64.enc(salt), iv: b64.enc(iv), wrapped: b64.enc(new Uint8Array(wrapped)) } satisfies Record_ });
  prf = undefined;
}

async function evaluate(credentialId: Uint8Array, salt: Uint8Array): Promise<ArrayBuffer> {
  const a = (await navigator.credentials.get({
    publicKey: {
      rpId: chrome.runtime.id, challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: "required",
      allowCredentials: [{ type: "public-key", id: credentialId as BufferSource }],
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const out = (a?.getClientExtensionResults() as PrfResults | undefined)?.prf?.results?.first;
  if (!out) throw new Error("The passkey didn't return its unlock secret.");
  return out;
}

export async function unlockWithPasskey(): Promise<WalletState> {
  const rec = await passkeyRecord();
  if (!rec) throw new Error("Passkey unlock isn't set up.");
  const salt = b64.dec(rec.salt);
  let out: ArrayBuffer;
  try { out = await evaluate(b64.dec(rec.credentialId), salt); }
  catch (e) {
    if ((e as Error).name === "NotAllowedError") throw new Error("Passkey unlock was cancelled or this passkey isn't available here. Use your password.");
    throw e;
  }
  let raw: ArrayBuffer;
  try { raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.dec(rec.iv) as BufferSource }, await wrappingKey(out, salt), b64.dec(rec.wrapped) as BufferSource); }
  catch { throw new Error("That passkey doesn't match. Use your password."); }
  return call<WalletState>({ type: "unlockWithKey", key: b64.enc(new Uint8Array(raw)) });
}

export async function disablePasskey() { await chrome.storage.local.remove("passkey"); }
