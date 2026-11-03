import { rpcUrl } from "@/lib/core/solana";

/**
 * RPC relay for the extension so the provider key never ships in client code.
 * Only the read/send methods a wallet needs are allowed.
 */
const ALLOWED = new Set([
  "getBalance", "getLatestBlockhash", "sendTransaction", "simulateTransaction", "getSignatureStatuses",
  "getAccountInfo", "getMultipleAccounts", "getTokenAccountsByOwner", "getTokenAccountBalance",
  "getMinimumBalanceForRentExemption", "getFeeForMessage", "getSlot", "getTransaction", "getSignaturesForAddress",
]);

export async function POST(req: Request) {
  const { method, params } = (await req.json().catch(() => ({}))) as { method?: string; params?: unknown[] };
  if (!method || !ALLOWED.has(method)) return Response.json({ error: "Method not allowed." }, { status: 400 });
  const r = await fetch(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }), cache: "no-store" });
  const j = (await r.json().catch(() => null)) as { result?: unknown; error?: { message: string } } | null;
  if (!j) return Response.json({ error: `RPC ${r.status}` }, { status: 502 });
  if (j.error) return Response.json({ error: j.error.message }, { status: 400 });
  return Response.json({ result: j.result });
}
