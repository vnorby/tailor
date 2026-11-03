// STUB — replaced by the real Drift adapter.
import type { Adapter } from "@/lib/core/types";

export const driftAdapter: Adapter = {
  protocol: "drift",
  name: "Drift",
  async positions() { return []; },
};
