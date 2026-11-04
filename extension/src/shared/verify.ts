import bs58 from "bs58";
import { b64, parseTx } from "./tx";
import { verify } from "~/vault/derive";

/**
 * Accept signatures produced on a Ledger only if each one is a valid signature by
 * `address` over exactly the message of the transaction that was approved.
 */
export function verifyDeviceSigned(address: string, originals: string[], signed: string[] | undefined): string[] {
  if (!signed || signed.length !== originals.length) throw new Error("The Ledger didn't return every signature.");
  const pub = bs58.decode(address);
  return signed.map((s, i) => {
    const a = parseTx(b64.dec(originals[i])), b = parseTx(b64.dec(s));
    if (a.message.length !== b.message.length || !a.message.every((x, j) => x === b.message[j])) throw new Error("The signed transaction doesn't match the one you approved.");
    const idx = b.signers.findIndex((k) => k.every((x, j) => x === pub[j]));
    const sig = b64.dec(s).slice(b.sigStart + idx * 64, b.sigStart + (idx + 1) * 64);
    if (idx < 0 || !verify(sig, b.message, pub)) throw new Error("The Ledger signature didn't verify.");
    return s;
  });
}

