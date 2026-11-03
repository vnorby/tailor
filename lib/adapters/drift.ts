/**
 * Drift adapter — READ-ONLY.
 *
 * As of Nov 2026 the Drift v2 program (dRiftyHA…) rejects every user instruction with
 * Anchor `InstructionFallbackNotFound` (cancel_orders, update_user_name, deposits, … all fail in
 * simulation and on-chain; no successful Drift instruction in 70+ days). The ~207k User accounts are
 * still on-chain with their balances, so we show what each wallet has frozen there, but offer no
 * actions: nothing can be closed, withdrawn or cancelled through the program.
 *
 * Reads: one filtered getProgramAccounts (User discriminator + authority) → every sub-account,
 * then one getMultipleAccountsInfo for the perp/spot markets they touch. No DriftClient subscription.
 *
 * User accounts match the SDK IDL (4376 bytes), but the frozen on-chain Spot/PerpMarket accounts use an
 * older layout than the installed SDK (776 / 1216 bytes vs 808 / 1240), so the few market fields we need
 * are read at offsets verified against mainnet (USDC/SOL/mSOL spot, SOL/BTC perp) instead of the SDK decoder.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder, Program, type Idl } from "@coral-xyz/anchor";
import bs58 from "bs58";
import { DRIFT_PROGRAM_ID, decodeName, getPerpMarketPublicKeySync, getSpotMarketPublicKeySync, type UserAccount } from "@drift-labs/sdk";
import driftIdl from "@drift-labs/sdk/src/idl/drift.json";
import type { Adapter, Ctx, Leg, Position } from "@/lib/core/types";
import { connection as sharedConnection, num, pct, usd } from "@/lib/core/solana";

const PID = new PublicKey(DRIFT_PROGRAM_ID);
const APP_URL = "https://app.drift.trade";
const HALTED = "Drift's program no longer accepts trading or withdrawal instructions — this position is frozen on-chain";

// camelCased coder (matches the SDK's account types) — anchor only camelCases via Program.
let coder: BorshAccountsCoder | null = null;
const accounts = (conn: Connection) =>
  (coder ??= new Program(driftIdl as Idl, { connection: conn } as never).coder.accounts as BorshAccountsCoder);
const USER_DISC = new BorshAccountsCoder(driftIdl as Idl).accountDiscriminator("User");

const PRICE = 1e6, BASE = 1e9, QUOTE = 1e6, W = 1e4;

interface SpotMkt { mint: string; name: string; decimals: number; lastPrice: number; depInterest: number; borInterest: number; maintAssetW: number; maintLiabW: number }
interface PerpMkt { name: string; lastPrice: number; mmr: number }
const u128 = (b: Buffer, o: number) => Number(b.readBigUInt64LE(o)) + Number(b.readBigUInt64LE(o + 8)) * 2 ** 64;
const clean = (s: string) => s.replace(/\0/g, "").trim();
const name32 = (b: Buffer, o: number) => clean(decodeName([...b.subarray(o, o + 32)]));
function parseSpot(b: Buffer): SpotMkt | null {
  if (b.length !== 776) return null; // only the layout we verified
  return {
    mint: new PublicKey(b.subarray(72, 104)).toBase58(), name: name32(b, 136),
    lastPrice: Number(b.readBigInt64LE(168)) / PRICE,
    depInterest: u128(b, 464) / 1e10, borInterest: u128(b, 480) / 1e10,
    maintAssetW: b.readUInt32LE(644) / W, maintLiabW: b.readUInt32LE(652) / W, decimals: b.readUInt32LE(680),
  };
}
function parsePerp(b: Buffer): PerpMkt | null {
  if (b.length !== 1216) return null;
  return { name: name32(b, 1000), lastPrice: Number(b.readBigInt64LE(72)) / PRICE, mmr: b.readUInt32LE(1140) / W };
}
const bn = (x: { toString(): string }) => Number(x.toString());
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

async function positions(owner: string, ctx: Ctx): Promise<Position[]> {
  const conn = ctx.connection ?? sharedConnection();
  const res = await conn.getProgramAccounts(PID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(USER_DISC) } }, { memcmp: { offset: 8, bytes: owner } }],
  });
  if (!res.length) return [];
  const users = res.map((r) => ({ pk: r.pubkey.toBase58(), u: accounts(conn).decode("user", r.account.data) as UserAccount }));

  const perpIdx = new Set<number>(), spotIdx = new Set<number>();
  for (const { u } of users) {
    for (const p of u.perpPositions) if (!p.baseAssetAmount.isZero() || !p.quoteAssetAmount.isZero()) perpIdx.add(p.marketIndex);
    for (const s of u.spotPositions) if (!s.scaledBalance.isZero()) spotIdx.add(s.marketIndex);
    for (const o of u.orders) if (has(o.status, "open")) (has(o.marketType, "perp") ? perpIdx : spotIdx).add(o.marketIndex);
  }
  const pIdx = [...perpIdx], sIdx = [...spotIdx];
  const ais = await conn.getMultipleAccountsInfo([
    ...pIdx.map((i) => getPerpMarketPublicKeySync(PID, i)), ...sIdx.map((i) => getSpotMarketPublicKeySync(PID, i)),
  ]);
  const perps = new Map<number, PerpMkt>(), spots = new Map<number, SpotMkt>();
  pIdx.forEach((i, k) => { const m = ais[k] && parsePerp(ais[k]!.data); if (m) perps.set(i, m); });
  sIdx.forEach((i, k) => { const ai = ais[pIdx.length + k]; const m = ai && parseSpot(ai.data); if (m) spots.set(i, m); });

  const mints = [...spots.values()].map((m) => m.mint);
  const px = await ctx.prices(mints).catch(() => ({} as Record<string, number>));
  const spotPrice = (m: SpotMkt) => px[m.mint] ?? m.lastPrice;
  const perpMark = (m: PerpMkt) => m.lastPrice; // last price the halted program recorded

  const out: Position[] = [];
  for (const { pk, u } of users) {
    const sub = `${clean(decodeName(u.name as unknown as number[])) || "Main"} · sub-account ${u.subAccountId}`;

    // --- collateral (maintenance-weighted) for health / liq price ---
    const legs: Leg[] = [];
    let supplyUsd = 0, borrowUsd = 0, tc = 0;
    for (const s of u.spotPositions) {
      if (s.scaledBalance.isZero()) continue;
      const m = spots.get(s.marketIndex); if (!m) continue;
      const deposit = has(s.balanceType, "deposit");
      const amt = (bn(s.scaledBalance) / 1e9) * (deposit ? m.depInterest : m.borInterest);
      const price = spotPrice(m), v = amt * price;
      if (amt < 1e-9 || (price && v < 0.001)) continue; // dust
      legs.push({ side: deposit ? "supply" : "borrow", symbol: m.name, mint: m.mint, amount: amt, valueUsd: v });
      if (deposit) { supplyUsd += v; tc += v * m.maintAssetW; }
      else { borrowUsd += v; tc -= v * m.maintLiabW; }
    }
    const perpRows = u.perpPositions.filter((p) => !p.baseAssetAmount.isZero() || !p.quoteAssetAmount.isZero()).flatMap((p) => {
      const m = perps.get(p.marketIndex); if (!m) return [];
      const base = bn(p.baseAssetAmount) / BASE, mark = perpMark(m);
      const upnl = base * mark + bn(p.quoteAssetAmount) / QUOTE;
      const entry = base !== 0 ? Math.abs(bn(p.quoteEntryAmount) / QUOTE / base) : 0;
      return [{ p, m, base, mark, upnl, entry, mmr: m.mmr, name: m.name }];
    });
    tc += perpRows.reduce((s, r) => s + r.upnl, 0);
    const mr = perpRows.reduce((s, r) => s + Math.abs(r.base) * r.mark * r.mmr, 0); // borrows are netted into tc via liability weight
    const health = tc > 0 ? Math.max(0, ((tc - mr) / tc) * 100) : 0;

    // --- perps: one Position each ---
    for (const r of perpRows) {
      const side = r.base >= 0 ? "long" : "short";
      const denom = r.base - Math.abs(r.base) * r.mmr;
      const liq = denom !== 0 ? r.mark - (tc - mr) / denom : 0;
      const liqPrice = liq > 0 && r.base !== 0 ? liq : 0;
      const notional = Math.abs(r.base) * r.mark;
      const dist = liqPrice && r.mark ? Math.abs(r.mark - liqPrice) / r.mark : undefined;
      out.push({
        id: `drift:${pk}:perp:${r.p.marketIndex}`, protocol: "drift", kind: "perp",
        title: `${r.name} ${side}`, subtitle: `${sub} · frozen`,
        valueUsd: r.upnl, pnlUsd: r.upnl,
        legs: [{ side, symbol: r.name.replace(/-PERP$/, ""), amount: Math.abs(r.base), valueUsd: notional }],
        metrics: [
          { label: "Size", value: `${num(Math.abs(r.base))} (${usd(notional)})` },
          { label: "Entry", value: usd(r.entry, r.entry < 1 ? 4 : 2) },
          { label: "Last mark", value: usd(r.mark, r.mark < 1 ? 4 : 2) },
          { label: "uPnL", value: usd(r.upnl), tone: r.upnl >= 0 ? "pos" : "neg" },
        ],
        risk: {
          level: "watch", score: 45, healthPct: health, liqPrice, markPrice: r.mark,
          reason: `${HALTED}${dist != null ? ` (${pct(dist, 0)} from est. liquidation price at the last mark)` : ""}.`,
        },
        actions: [], url: APP_URL,
        raw: { user: pk, subAccountId: u.subAccountId, marketIndex: r.p.marketIndex, entryPrice: r.entry, baseAmount: r.base, halted: true },
        updatedAt: Date.now(),
      });
    }

    // --- spot deposits/borrows: one lending Position per sub-account ---
    if (legs.length && supplyUsd + borrowUsd >= 0.01) {
      const borrows = legs.filter((l) => l.side === "borrow");
      out.push({
        id: `drift:${pk}:spot`, protocol: "drift", kind: "lending",
        title: borrows.length ? `${legs.filter((l) => l.side === "supply").map((l) => l.symbol).join(" + ") || "—"} → ${borrows.map((l) => l.symbol).join(" + ")}` : `${legs.map((l) => l.symbol).join(" + ")} deposits`,
        subtitle: `${sub} · frozen`,
        valueUsd: supplyUsd - borrowUsd, legs,
        metrics: [
          { label: "Deposits", value: usd(supplyUsd) },
          ...(borrowUsd ? [{ label: "Borrowed", value: usd(borrowUsd) }] : []),
          ...(perpRows.length || borrowUsd ? [{ label: "Health", value: `${health.toFixed(0)}%` }] : []),
          { label: "Status", value: "Withdrawals unavailable", tone: "warn" as const },
        ],
        risk: { level: "watch", score: 40, healthPct: borrowUsd || perpRows.length ? health : undefined, reason: `${HALTED}.` },
        actions: [], url: APP_URL,
        raw: { user: pk, subAccountId: u.subAccountId, halted: true },
        updatedAt: Date.now(),
      });
    }

    // --- open orders (also frozen) ---
    for (const o of u.orders) {
      if (!has(o.status, "open")) continue;
      const isPerp = has(o.marketType, "perp");
      const name = (isPerp ? perps.get(o.marketIndex)?.name : spots.get(o.marketIndex)?.name) ?? "";
      const whole = bn(o.baseAssetAmount) > 1e18; // u64::MAX = "entire position" trigger
      const size = bn(o.baseAssetAmount) / (isPerp ? BASE : 10 ** (spots.get(o.marketIndex)?.decimals ?? 9));
      const price = bn(o.price) / PRICE;
      const type = Object.keys(o.orderType)[0];
      const dir = has(o.direction, "long") ? "Buy" : "Sell";
      out.push({
        id: `drift:${pk}:order:${o.orderId}`, protocol: "drift", kind: "order",
        title: `${dir} ${whole ? "entire position" : num(size)} ${name || `market ${o.marketIndex}`}`, subtitle: `${type} order${price ? ` @ ${usd(price, price < 1 ? 4 : 2)}` : ""} · ${sub}`,
        valueUsd: 0, legs: [], metrics: [{ label: "Status", value: "Frozen", tone: "warn" }],
        risk: { level: "ok", score: 10, reason: "Open order on a halted program; it can't fill or be cancelled." },
        actions: [], url: APP_URL, raw: { user: pk, orderId: o.orderId, halted: true }, updatedAt: Date.now(),
      });
    }
  }
  return out;
}

export const driftAdapter: Adapter = { protocol: "drift", name: "Drift", positions };
