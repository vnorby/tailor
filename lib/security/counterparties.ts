/**
 * Address-poisoning protection. Scammers send dust (or zero-value token transfers)
 * from a vanity address that shares the first and last few characters with one of
 * your real counterparties, hoping you'll copy it from your history next time.
 *
 * We read the owner's recent transfers (Helius enhanced transactions API, same
 * source as lib/core/solana.ts activity()) and compare a recipient against them.
 */

const KEY = () => process.env.HELIUS_API_KEY ?? "";
const TTL = 2 * 60_000;
const PAGES = 3;
/** Incoming transfers below this are treated as dust (typical of poisoning). */
const DUST_LAMPORTS = 10_000;

export interface Counterparties {
  sentTo: Map<string, number>;          // address → number of outgoing transfers
  receivedFrom: Map<string, { count: number; dustOnly: boolean }>;
  scanned: number;                      // transactions looked at
}

interface EnhancedTx {
  signature: string;
  nativeTransfers?: { fromUserAccount: string; toUserAccount: string; amount: number }[];
  tokenTransfers?: { fromUserAccount: string; toUserAccount: string; tokenAmount: number; mint: string }[];
}

const cache = new Map<string, { at: number; data: Counterparties }>();

export async function counterparties(owner: string): Promise<Counterparties> {
  const hit = cache.get(owner);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data: Counterparties = { sentTo: new Map(), receivedFrom: new Map(), scanned: 0 };
  let before: string | undefined;
  for (let page = 0; page < PAGES; page++) {
    const r = await fetch(`https://api.helius.xyz/v0/addresses/${owner}/transactions?api-key=${KEY()}&limit=100${before ? `&before=${before}` : ""}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!r.ok) { if (page === 0) throw new Error(`History unavailable (${r.status})`); break; }
    const txs = (await r.json()) as EnhancedTx[];
    if (!Array.isArray(txs) || !txs.length) break;
    for (const t of txs) {
      data.scanned++;
      const legs = [
        ...(t.nativeTransfers ?? []).map((n) => ({ from: n.fromUserAccount, to: n.toUserAccount, dust: n.amount < DUST_LAMPORTS })),
        ...(t.tokenTransfers ?? []).map((n) => ({ from: n.fromUserAccount, to: n.toUserAccount, dust: !(n.tokenAmount > 0.001) })),
      ];
      for (const l of legs) {
        if (!l.from || !l.to || l.from === l.to) continue;
        if (l.from === owner) data.sentTo.set(l.to, (data.sentTo.get(l.to) ?? 0) + 1);
        else if (l.to === owner) {
          const cur = data.receivedFrom.get(l.from);
          data.receivedFrom.set(l.from, { count: (cur?.count ?? 0) + 1, dustOnly: (cur?.dustOnly ?? true) && l.dust });
        }
      }
    }
    if (txs.length < 100) break;
    before = txs[txs.length - 1].signature;
  }
  cache.set(owner, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return data;
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
/** Same first 4 and last 4 characters: what people actually check by eye. */
export const looksAlike = (a: string, b: string) => a !== b && a.slice(0, 4) === b.slice(0, 4) && a.slice(-4) === b.slice(-4);

export interface RecipientCheck {
  warnings: string[];   // likely poisoning — shown as warnings
  info: string[];       // e.g. "first time sending to this address"
  firstTime?: boolean;
}

/** Compare a send recipient against the owner's history. Never throws. */
export async function checkRecipient(owner: string, to: string): Promise<RecipientCheck> {
  const out: RecipientCheck = { warnings: [], info: [] };
  if (looksAlike(to, owner)) out.warnings.push(`This address looks like your own wallet (${short(owner)}) but isn't. It's likely a poisoned look-alike — check every character.`);
  let cp: Counterparties;
  try { cp = await counterparties(owner); } catch {
    out.info.push("Couldn't check this address against your history.");
    return out;
  }
  const sentBefore = cp.sentTo.has(to);
  const lookalikeSent = [...cp.sentTo.keys()].find((a) => looksAlike(a, to));
  const lookalikeRecv = [...cp.receivedFrom.keys()].find((a) => looksAlike(a, to) && a !== lookalikeSent);
  const recv = cp.receivedFrom.get(to);

  if (lookalikeSent && !sentBefore) {
    out.warnings.push(`Possible address poisoning: this address matches the first and last 4 characters of ${lookalikeSent.slice(0, 8)}…${lookalikeSent.slice(-8)}, which you've sent to before, but it's a different address.${recv?.dustOnly ? " It has also sent you dust — a classic poisoning setup." : ""} Compare the full address before sending.`);
  } else if (lookalikeRecv && !sentBefore) {
    out.warnings.push(`This address matches the first and last 4 characters of another address in your history (${lookalikeRecv.slice(0, 8)}…${lookalikeRecv.slice(-8)}). One of them is likely a poisoned look-alike — verify the full address.`);
  } else if (recv?.dustOnly && !sentBefore && recv.count > 0) {
    out.warnings.push("This address has only ever sent you dust. Scammers do this so their address shows up in your history — make sure you didn't copy it from there.");
  }
  if (!sentBefore) {
    out.firstTime = true;
    out.info.push(`First time sending to this address${cp.scanned ? ` (in your last ${cp.scanned} transactions)` : ""}.`);
  }
  return out;
}
