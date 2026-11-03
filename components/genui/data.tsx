"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Snapshot, ToolDef } from "@/lib/core/types";
import { globalFacts, positionFacts } from "@/lib/genui/facts";
import type { Scope } from "@/lib/genui/expr";

export interface GenEnv { snap: Snapshot; tools: ToolDef[]; global: Scope; scopes: Map<string, Scope> }
const EnvCtx = createContext<GenEnv | null>(null);

export const useGenData = () => {
  const e = useContext(EnvCtx);
  if (!e) throw new Error("useGenData outside GenProvider");
  return e;
};

/** Live data + per-position formula scopes for everything rendered from a generated page. */
export function GenProvider({ snap, tools, children }: { snap: Snapshot; tools: ToolDef[]; children: ReactNode }) {
  const env = useMemo<GenEnv>(() => {
    const global = globalFacts(snap);
    return { snap, tools, global, scopes: new Map(snap.positions.map((p) => [p.id, { ...global, ...positionFacts(p) }])) };
  }, [snap, tools]);
  return <EnvCtx.Provider value={env}>{children}</EnvCtx.Provider>;
}
