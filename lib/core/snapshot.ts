import { ADAPTERS } from "@/lib/adapters";
import { activity, connection, prices, walletTokens } from "./solana";
import type { Ctx, Position, Snapshot } from "./types";

const ADAPTER_TIMEOUT = 15_000;

const withTimeout = <T,>(p: Promise<T>, ms: number, label: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);

export async function makeCtx(owner: string): Promise<Ctx> {
  return { connection: connection(), prices, tokens: await walletTokens(owner) };
}

/** Everything about a wallet: balances, every adapter's positions, recent activity. */
export type Progress = (e: { name: string; positions: number; ms: number; error?: string }) => void;

export async function snapshot(owner: string, report?: Progress): Promise<Snapshot> {
  // Progress goes to whoever started the read; it must never be able to break the read itself
  // (the snapshot is cached and shared with other requests).
  const onProgress: Progress = (e) => { try { report?.(e); } catch { /* listener went away */ } };
  const [ctx, act] = await Promise.all([makeCtx(owner), activity(owner).catch(() => ({ txCount: 0, bySource: {}, byType: {} }))]);
  const errors: Snapshot["errors"] = [];
  onProgress?.({ name: "Wallet", positions: ctx.tokens.length, ms: 0 });
  const results = await Promise.all(ADAPTERS.map(async (a) => {
    const t0 = Date.now();
    try { const ps = await withTimeout(a.positions(owner, ctx), ADAPTER_TIMEOUT, a.name); onProgress?.({ name: a.name, positions: ps.length, ms: Date.now() - t0 }); return ps; }
    catch (e) { const message = e instanceof Error ? e.message : String(e); errors.push({ protocol: a.protocol, message }); onProgress?.({ name: a.name, positions: 0, ms: Date.now() - t0, error: message }); return [] as Position[]; }
  }));
  const positions = results.flat();
  // Tokens that are themselves positions (LSTs, JLP, vault shares) are shown on their card, not double-counted.
  const claimed = new Set(positions.flatMap((p) => (p.raw?.claimsMints as string[] | undefined) ?? []));
  const tokens = ctx.tokens.filter((t) => !claimed.has(t.mint));
  const netWorthUsd = tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0) + positions.reduce((s, p) => s + (p.kind === "order" ? 0 : p.valueUsd), 0);
  return { owner, netWorthUsd, tokens, positions, activity: act, errors, fetchedAt: Date.now() };
}
