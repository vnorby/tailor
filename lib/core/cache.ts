import { snapshot, type Progress } from "./snapshot";
import type { Snapshot } from "./types";

const TTL = 20_000;
const cache = new Map<string, { at: number; p: Promise<Snapshot> }>();

/** Snapshot with a short in-process cache so layout/prompt calls don't re-read the chain. */
export function getSnapshot(owner: string, fresh = false, onProgress?: Progress): Promise<Snapshot> {
  const c = cache.get(owner);
  if (!fresh && c && Date.now() - c.at < TTL) return c.p;
  const p = snapshot(owner, onProgress);
  cache.set(owner, { at: Date.now(), p });
  p.catch(() => cache.delete(owner));
  return p;
}

export const invalidate = (owner: string) => cache.delete(owner);
