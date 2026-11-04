import { adapterFor, toolById } from "@/lib/adapters";
import { makeCtx } from "./snapshot";
import { simulate, type SimResult } from "./solana";
import type { BuiltAction, Protocol } from "./types";

export interface Prepared extends BuiltAction { simulations: SimResult[]; verification?: { matches: boolean; note: string } }

/**
 * Re-read the position server-side (never trust client copies), build the action,
 * and simulate. Later txs in a sequence may depend on earlier ones landing, so only
 * the first is required to pass; the rest are reported.
 */
export async function prepareAction(owner: string, positionId: string, actionId: string, params: Record<string, string>): Promise<Prepared> {
  const protocol = positionId.split(":")[0] as Protocol;
  const adapter = adapterFor(protocol);
  if (!adapter?.build) throw new Error(`No actions available for ${protocol}.`);
  const ctx = await makeCtx(owner);
  const position = (await adapter.positions(owner, ctx)).find((p) => p.id === positionId);
  if (!position) throw new Error("That position no longer exists. Refresh the page.");
  if (!position.actions.some((a) => a.id === actionId)) throw new Error("That action isn't available for this position.");
  const built = await adapter.build(owner, position, actionId, params, ctx);
  return withSimulation(built);
}

export async function prepareTool(owner: string, toolId: string, params: Record<string, string>): Promise<Prepared> {
  const tool = toolById(toolId);
  if (!tool?.adapter.buildTool) throw new Error(`Unknown tool ${toolId}.`);
  const ctx = await makeCtx(owner);
  return withSimulation(await tool.adapter.buildTool(owner, toolId, params, ctx));
}

export async function withSimulation(built: BuiltAction): Promise<Prepared> {
  if (!built.txs.length) throw new Error("Nothing to do.");
  const simulations = await Promise.all(built.txs.map((tx) => simulate(tx).catch((e) => ({ ok: false, error: String(e) }))));
  return { ...built, simulations };
}
