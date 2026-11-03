/**
 * Kamino adapter: Kamino Lend obligations across every market (plain borrows and
 * Multiply/Leverage), Kamino Earn vault shares and Kamino Liquidity strategy shares.
 */
import type { Adapter, Position } from "@/lib/core/types";
import { DEPOSIT_ASSETS, buildDepositTool, buildLend, lendPositions } from "./kamino/lend";
import { buildVault, vaultPositions } from "./kamino/vaults";
import { buildLiquidity, liquidityPositions } from "./kamino/liquidity";

export const kaminoAdapter: Adapter = {
  protocol: "kamino",
  name: "Kamino",

  async positions(owner, ctx) {
    const symbolOf = (mint: string) => ctx.tokens.find((t) => t.mint === mint)?.symbol;
    const settled = await Promise.allSettled([
      lendPositions(owner, ctx),
      vaultPositions(owner, symbolOf),
      liquidityPositions(owner, ctx),
    ]);
    const out: Position[] = [];
    const errs: string[] = [];
    for (const s of settled) s.status === "fulfilled" ? out.push(...s.value) : errs.push(s.reason instanceof Error ? s.reason.message : String(s.reason));
    // Only surface an error if everything failed; partial data beats none.
    if (!out.length && errs.length) throw new Error(errs[0]);
    return out.sort((a, b) => b.risk.score - a.risk.score || b.valueUsd - a.valueUsd);
  },

  async build(owner, position, actionId, params) {
    const type = (position.raw as { type?: string } | undefined)?.type;
    if (type === "obligation") return buildLend(owner, position, actionId, params);
    if (type === "kvault") return buildVault(owner, position, actionId, params);
    if (type === "kliquidity") return buildLiquidity(owner, position);
    throw new Error("Unknown Kamino position type.");
  },

  tools: [{
    id: "kamino-deposit",
    protocol: "kamino",
    label: "Lend on Kamino",
    description: "Supply an asset to Kamino Lend's Main market to earn variable supply APY (withdrawable any time; can later be used as collateral).",
    fields: [
      { name: "asset", label: "Asset", kind: "select", default: "USDC", options: DEPOSIT_ASSETS.map((s) => ({ value: s, label: s })) },
      { name: "amount", label: "Amount", kind: "amount" },
    ],
  }],

  async buildTool(owner, toolId, params) {
    if (toolId !== "kamino-deposit") throw new Error(`Unknown Kamino tool ${toolId}`);
    return buildDepositTool(owner, params);
  },
};
