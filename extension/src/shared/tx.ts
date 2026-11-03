/**
 * Minimal Solana wire-format handling for signing — no web3.js in the extension.
 * Transaction = shortvec(sigCount) ‖ sig[64]×n ‖ message. The first
 * `numRequiredSignatures` static account keys of the message are the signers,
 * in the same order as the signature slots.
 */

function readShortVec(b: Uint8Array, o: number): [number, number] {
  let len = 0, size = 0;
  for (;;) {
    const elem = b[o + size];
    len |= (elem & 0x7f) << (size * 7);
    size++;
    if ((elem & 0x80) === 0) break;
    if (size > 3) throw new Error("bad shortvec");
  }
  return [len, size];
}

export interface ParsedTx {
  sigCount: number;
  sigStart: number;         // byte offset of signature 0
  message: Uint8Array;      // the bytes that get signed
  version: "legacy" | 0;
  signers: Uint8Array[];    // required signer pubkeys, in signature order
  feePayer: Uint8Array;
}

export function parseTx(tx: Uint8Array): ParsedTx {
  const [sigCount, n] = readShortVec(tx, 0);
  const sigStart = n;
  const msgStart = sigStart + sigCount * 64;
  const message = tx.slice(msgStart);
  let o = 0;
  let version: ParsedTx["version"] = "legacy";
  if (message[0] & 0x80) { version = (message[0] & 0x7f) as 0; o = 1; }
  const numRequired = message[o];
  o += 3;
  const [keyCount, kn] = readShortVec(message, o);
  o += kn;
  if (numRequired > keyCount || numRequired !== sigCount) throw new Error("Malformed transaction (signer count mismatch).");
  const signers: Uint8Array[] = [];
  for (let i = 0; i < numRequired; i++) signers.push(message.slice(o + i * 32, o + (i + 1) * 32));
  return { sigCount, sigStart, message, version, signers, feePayer: signers[0] };
}

const eqBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Insert our signature into the slot that belongs to `pubkey`. Throws if we aren't a signer. */
export function applySignature(tx: Uint8Array, pubkey: Uint8Array, signer: (msg: Uint8Array) => Uint8Array): Uint8Array {
  const p = parseTx(tx);
  const idx = p.signers.findIndex((s) => eqBytes(s, pubkey));
  if (idx < 0) throw new Error("This transaction doesn't need your signature.");
  const out = tx.slice();
  out.set(signer(p.message), p.sigStart + idx * 64);
  return out;
}

export const b64 = {
  enc: (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join("")),
  dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
