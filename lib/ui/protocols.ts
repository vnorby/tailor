import type { Protocol } from "@/lib/core/types";

export const PROTOCOLS: Record<Protocol, { name: string; color: string }> = {
  wallet: { name: "Wallet", color: "#d8d2c4" },
  kamino: { name: "Kamino", color: "#4f8cff" },
  jupiter: { name: "Jupiter", color: "#c7f284" },
  drift: { name: "Drift", color: "#9c8cff" },
  marginfi: { name: "marginfi", color: "#e6e6e6" },
  phoenix: { name: "Phoenix", color: "#ff7a45" },
  titan: { name: "Titan", color: "#7fd6ff" },
  dflow: { name: "DFlow", color: "#5ce0b0" },
  stake: { name: "Native stake", color: "#b38cff" },
  lst: { name: "Liquid staking", color: "#b38cff" },
};
