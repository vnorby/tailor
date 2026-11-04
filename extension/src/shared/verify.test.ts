// Plays the Ledger in software to check the background's acceptance rules for device signatures.
import { verifyDeviceSigned } from "./verify";
import { applySignature, b64 } from "./tx";
import { deriveAccount, sign } from "~/vault/derive";
const me = deriveAccount("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", 0);
const other = deriveAccount("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", 1);
const msg = Uint8Array.from([1, 0, 1, 2, ...me.publicKey, ...new Uint8Array(32), ...new Uint8Array(32).fill(7), 1, 1, 2, 0, 0, 12, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
const tx = Uint8Array.from([1, ...new Uint8Array(64), ...msg]);
const original = b64.enc(tx);
const device = (kp: typeof me, bytes: Uint8Array) => b64.enc(applySignature(bytes, me.publicKey, (m) => sign(m, kp.secretKey)));
let fail = 0;
const expect = (name: string, fn: () => unknown, shouldThrow: boolean) => {
  let threw = false, msgx = "";
  try { fn(); } catch (e) { threw = true; msgx = (e as Error).message; }
  const ok = threw === shouldThrow; if (!ok) fail++;
  console.log(ok ? "PASS" : "FAIL", name, msgx ? `(${msgx})` : "");
};
expect("valid device signature accepted", () => verifyDeviceSigned(me.address, [original], [device(me, tx)]), false);
expect("signature by a different key rejected", () => verifyDeviceSigned(me.address, [original], [device(other, tx)]), true);
const tampered = tx.slice(); tampered[tampered.length - 1] = 9; // amount changed after approval
expect("tampered transaction rejected", () => verifyDeviceSigned(me.address, [original], [device(me, tampered)]), true);
expect("missing signature rejected", () => verifyDeviceSigned(me.address, [original], []), true);
expect("unsigned (zero) signature rejected", () => verifyDeviceSigned(me.address, [original], [original]), true);
process.exit(fail ? 1 : 0);
