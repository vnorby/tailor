/**
 * Ledger over WebHID, from extension pages (service workers can't use WebHID).
 * The key never leaves the device: we send it the transaction message, it shows
 * the details on its screen, and returns a signature only if the user approves there.
 */
import "./polyfill";
import TransportWebHID from "@ledgerhq/hw-transport-webhid";
import Solana from "@ledgerhq/hw-app-solana";
import bs58 from "bs58";
import { applySignature, b64, parseTx } from "~/shared/tx";

export const ledgerSupported = () => typeof navigator !== "undefined" && "hid" in navigator;

/** Phantom uses 44'/501'/i'/0'; Solflare and older wallets 44'/501'/i'. */
export const LEDGER_PATHS = [
  { id: "phantom", label: "Phantom / Backpack (44'/501'/n'/0')", path: (i: number) => `44'/501'/${i}'/0'` },
  { id: "solflare", label: "Solflare (44'/501'/n')", path: (i: number) => `44'/501'/${i}'` },
] as const;

let app: Solana | null = null;

/** Reuse an already-permitted device, or prompt (must be called from a user gesture). */
async function getApp(prompt: boolean): Promise<Solana> {
  if (app) return app;
  let transport = await TransportWebHID.openConnected().catch(() => null);
  if (!transport && prompt) transport = await TransportWebHID.request();
  if (!transport) throw new Error("Connect your Ledger, unlock it and open the Solana app.");
  transport.on("disconnect", () => { app = null; });
  app = new Solana(transport);
  return app;
}

function friendly(e: unknown): Error {
  const m = e instanceof Error ? e.message : String(e);
  if (/0x6985|denied|rejected/i.test(m)) return new Error("Rejected on your Ledger.");
  if (/0x6a81|0x6e01|0x6d00|CLA_NOT_SUPPORTED|app.*not.*open/i.test(m)) return new Error("Open the Solana app on your Ledger.");
  if (/0x6808|blind/i.test(m)) return new Error("This transaction needs blind signing. Enable it in the Solana app settings on your Ledger, then try again.");
  if (/locked|0x5515/i.test(m)) return new Error("Unlock your Ledger.");
  if (/reading 'open'|NotFoundError|No device selected|no device|access denied/i.test(m)) return new Error("No Ledger selected. Plug it in, unlock it, open the Solana app, and choose it in the browser prompt.");
  return new Error(`Ledger: ${m}`);
}

export async function ledgerAccounts(scheme: (typeof LEDGER_PATHS)[number], count = 5, prompt = true) {
  try {
    const a = await getApp(prompt);
    const out: { address: string; path: string }[] = [];
    for (let i = 0; i < count; i++) {
      const path = scheme.path(i);
      const { address } = await a.getAddress(path);
      out.push({ address: bs58.encode(address), path });
    }
    return out;
  } catch (e) { throw friendly(e); }
}

/** Sign base64 transactions with the Ledger account at `path`; returns signed base64 txs. */
export async function ledgerSignTxs(address: string, path: string, txs: string[]): Promise<string[]> {
  try {
    const a = await getApp(true);
    const pub = bs58.decode(address);
    const out: string[] = [];
    for (const t of txs) {
      const bytes = b64.dec(t);
      const { signature } = await a.signTransaction(path, Buffer.from(parseTx(bytes).message));
      out.push(b64.enc(applySignature(bytes, pub, () => new Uint8Array(signature))));
    }
    return out;
  } catch (e) { throw friendly(e); }
}

export async function ledgerSignMessage(path: string, message: Uint8Array): Promise<string> {
  try {
    const a = await getApp(true);
    const { signature } = await a.signOffchainMessage(path, Buffer.from(message));
    return b64.enc(new Uint8Array(signature));
  } catch (e) { throw friendly(e); }
}
