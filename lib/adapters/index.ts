import type { Adapter, Protocol } from "@/lib/core/types";
import { kaminoAdapter } from "./kamino";
import { jupiterAdapter } from "./jupiter";
import { driftAdapter } from "./drift";
import { marginfiAdapter } from "./marginfi";
import { phoenixAdapter } from "./phoenix";
import { titanAdapter } from "./titan";
import { dflowAdapter } from "./dflow";
import { stakeAdapter } from "./stake";
import { swapAdapter } from "./swap";
import { walletAdapter } from "./wallet";

export const ADAPTERS: Adapter[] = [
  kaminoAdapter, jupiterAdapter, driftAdapter, marginfiAdapter, phoenixAdapter,
  titanAdapter, dflowAdapter, stakeAdapter, swapAdapter, walletAdapter,
];

export const adapterFor = (p: Protocol) => ADAPTERS.find((a) => a.protocol === p);

export const allTools = () => ADAPTERS.flatMap((a) => (a.tools ?? []).map((t) => ({ ...t, adapter: a })));
export const toolById = (id: string) => allTools().find((t) => t.id === id);
