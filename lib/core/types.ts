/**
 * The contract between protocol adapters, the layout composer and the UI.
 * Everything here is JSON-serializable: positions travel to the browser and back
 * to /api/action, so adapters must put whatever they need to rebuild a
 * transaction into `raw` (addresses, market ids), never live SDK objects.
 */
import type { Connection } from "@solana/web3.js";

export type Protocol =
  | "wallet" | "kamino" | "jupiter" | "drift" | "marginfi"
  | "phoenix" | "titan" | "dflow" | "stake" | "lst";

export type PositionKind =
  | "lending"     // supply/borrow obligation (Kamino, Marginfi, Drift spot)
  | "vault"       // single-asset or strategy vault (Kamino vaults, JLP)
  | "lp"          // concentrated / AMM liquidity
  | "perp"        // perpetual future (Jupiter, Drift, Phoenix)
  | "order"       // open limit / trigger / DCA order
  | "stake"       // native stake account
  | "prediction"  // prediction-market outcome tokens (DFlow)
  | "other";

export type RiskLevel = "ok" | "watch" | "danger";

export interface Metric { label: string; value: string; tone?: "pos" | "neg" | "warn" | "muted" }

export interface Leg {
  side: "supply" | "borrow" | "long" | "short" | "stake" | "lp" | "hold";
  symbol: string;
  mint?: string;
  amount: number;          // UI units
  valueUsd: number;
  apy?: number;            // decimal, 0.05 = 5%
}

/** An input the user fills in before an action is built (amount to repay, % to close…). */
export interface ActionField {
  name: string;
  label: string;
  kind: "amount" | "percent" | "select" | "price" | "text";
  unit?: string;
  max?: number;            // e.g. full debt, full position size
  default?: string;
  options?: { value: string; label: string }[];
}

export interface Action {
  id: string;              // adapter-scoped, passed back to build()
  label: string;
  intent: "close" | "reduce" | "repay" | "withdraw" | "deposit" | "borrow" | "claim"
        | "cancel" | "stake" | "unstake" | "swap" | "add" | "other";
  danger?: boolean;        // red button + confirm step
  fields?: ActionField[];
}

export interface Risk {
  level: RiskLevel;
  score: number;           // 0–100 urgency; drives layout ordering
  reason?: string;         // "LTV 81% of 85% liquidation threshold"
  healthPct?: number;      // 100 = safest, 0 = liquidatable
  liqPrice?: number;
  markPrice?: number;
}

export interface Position {
  id: string;              // `${protocol}:${stable-id}`
  protocol: Protocol;
  kind: PositionKind;
  title: string;           // "SOL / USDC Multiply"
  subtitle?: string;       // "Main market · 3.2x"
  valueUsd: number;        // net equity (supply − borrow, collateral + uPnL…)
  pnlUsd?: number;
  legs: Leg[];
  metrics: Metric[];       // free-form extra stats shown on the card
  risk: Risk;
  actions: Action[];
  url?: string;            // open in the protocol's own app
  raw?: Record<string, unknown>;
  updatedAt: number;
}

export interface Token {
  mint: string;
  symbol: string;
  name?: string;
  icon?: string;
  amount: number;          // UI units
  decimals: number;
  priceUsd?: number;
  valueUsd?: number;
  spam?: boolean;          // likely airdrop/scam token (only returned when explicitly requested)
}

export interface Ctx {
  connection: Connection;
  /** USD prices by mint (Jupiter price API, cached). Missing mints are omitted. */
  prices(mints: string[]): Promise<Record<string, number>>;
  tokens: Token[];         // the wallet's fungible balances, already priced
}

export interface BuiltAction {
  txs: string[];           // base64 serialized UNSIGNED transactions, in send order
  summary: string;         // human sentence shown before signing
  warnings?: string[];
}

/** A stand-alone tool that isn't tied to an existing position: swap, stake, deposit… */
export interface ToolDef {
  id: string;              // globally unique, e.g. "swap", "stake-sol", "kamino-deposit"
  protocol: Protocol;
  label: string;
  description: string;     // shown to the layout model so it knows when to offer it
  fields: ActionField[];
}

export interface Adapter {
  protocol: Protocol;
  name: string;
  /** Read every position this owner has. Must not throw for "no account"; return []. */
  positions(owner: string, ctx: Ctx): Promise<Position[]>;
  /** Build unsigned txs for one of the position's actions. */
  build?(owner: string, position: Position, actionId: string, params: Record<string, string>, ctx: Ctx): Promise<BuiltAction>;
  tools?: ToolDef[];
  buildTool?(owner: string, toolId: string, params: Record<string, string>, ctx: Ctx): Promise<BuiltAction>;
}

/** What the wallet mostly does, from recent transaction history. */
export interface Activity {
  txCount: number;
  bySource: Record<string, number>;   // KAMINO: 14, JUPITER: 40 …
  byType: Record<string, number>;     // SWAP: 30, …
  lastActiveAt?: number;
}

export interface Snapshot {
  owner: string;
  netWorthUsd: number;
  tokens: Token[];
  positions: Position[];
  activity: Activity;
  errors: { protocol: Protocol; message: string }[];
  fetchedAt: number;
}

export interface Prefs {
  instructions: string[];  // standing user instructions applied to every layout
}

/**
 * Swap routing: Jupiter, Titan and DFlow each implement this; the shared "swap"
 * tool asks all of them and builds the best quote. Amounts are atomic units.
 */
export interface SwapQuote {
  provider: "jupiter" | "titan" | "dflow";
  inMint: string; outMint: string;
  inAmount: string; outAmount: string;
  priceImpactPct?: number;
  route?: string;           // short label, e.g. "Meteora → Orca"
  /** Build the unsigned tx for this exact quote. */
  build(): Promise<string>;
}

export interface SwapProvider {
  name: SwapQuote["provider"];
  quote(owner: string, inMint: string, outMint: string, amount: string, slippageBps: number): Promise<SwapQuote | null>;
}
