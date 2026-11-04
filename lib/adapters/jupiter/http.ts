/** Shared HTTP plumbing for the Jupiter adapter: api.jup.ag (keyed) + perps-api.jup.ag. */
import { PublicKey, type Connection } from "@solana/web3.js";
import { jupHeaders } from "@/lib/core/solana";

// Keyed host for higher limits; the free keyless host otherwise.
export const JUP = process.env.JUPITER_API_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag";
export const PERPS = "https://perps-api.jup.ag/v1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON fetch with the API key, a timeout and a short 429 back-off (the free tier
 * allows ~1 rps averaged over 60 s, bursts get throttled). Throws with the API's
 * own error message on non-2xx so build() surfaces something readable.
 */
export async function jfetch<T>(url: string, init: { method?: string; body?: unknown; timeoutMs?: number; retries?: number } = {}): Promise<T> {
  const retries = init.retries ?? (init.body ? 3 : 2); // builds (POST) are worth waiting for
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { ...jupHeaders(), ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? 8000),
    });
    if (r.status === 429 && attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
    const text = await r.text();
    let j: unknown;
    try { j = JSON.parse(text); } catch { j = undefined; }
    if (!r.ok) {
      const o = j as { message?: string; error?: string; errorMessage?: string } | undefined;
      throw new Error(`Jupiter ${r.status}: ${o?.message ?? o?.error ?? o?.errorMessage ?? text.slice(0, 200)}`);
    }
    return j as T;
  }
}

/** Number from a string field that may be absent; NaN-safe. */
export const n = (v: unknown, fallback = 0): number => {
  const x = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(x) ? x : fallback;
};

export const SOL = "So11111111111111111111111111111111111111112";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const ETH = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
export const BTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
export const JLP = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";

export const KNOWN: Record<string, { symbol: string; decimals: number }> = {
  [SOL]: { symbol: "SOL", decimals: 9 },
  [USDC]: { symbol: "USDC", decimals: 6 },
  [USDT]: { symbol: "USDT", decimals: 6 },
  [ETH]: { symbol: "ETH", decimals: 8 },
  [BTC]: { symbol: "BTC", decimals: 8 },
  [JLP]: { symbol: "JLP", decimals: 6 },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", decimals: 6 },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: "JitoSOL", decimals: 9 },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", decimals: 5 },
};

/** Symbols/decimals for mints: wallet tokens → static map → Jupiter Tokens API (one call). */
export async function tokenMeta(mints: string[], walletTokens: { mint: string; symbol: string; decimals: number }[], connection?: Connection): Promise<Record<string, { symbol: string; decimals: number }>> {
  const out: Record<string, { symbol: string; decimals: number }> = {};
  const need: string[] = [];
  for (const m of new Set(mints)) {
    const t = walletTokens.find((x) => x.mint === m);
    if (t) out[m] = { symbol: t.symbol, decimals: t.decimals };
    else if (KNOWN[m]) out[m] = KNOWN[m];
    else need.push(m);
  }
  if (need.length) {
    try {
      const res = await jfetch<{ id: string; symbol: string; decimals: number }[]>(`${JUP}/tokens/v2/search?query=${need.slice(0, 100).join(",")}`, { retries: 1 });
      for (const t of res ?? []) out[t.id] = { symbol: t.symbol, decimals: t.decimals };
    } catch { /* fall back to on-chain decimals below */ }
    const missing = need.filter((m) => !out[m]);
    if (missing.length && connection) {
      // Decimals straight from the mint account (byte 44) so amounts are never wrong.
      const infos = await connection.getMultipleAccountsInfo(missing.map((m) => new PublicKey(m))).catch(() => []);
      missing.forEach((m, i) => { const d = infos[i]?.data; if (d && d.length >= 45) out[m] = { symbol: m.slice(0, 4), decimals: d[44] }; });
    }
    for (const m of need) out[m] ??= { symbol: m.slice(0, 4), decimals: 6 };
  }
  return out;
}
