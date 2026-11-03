export const usd = (n: number | undefined, compact = false) => {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (compact && a >= 1e6) return `${n < 0 ? "−" : ""}$${(a / 1e6).toFixed(2)}M`;
  if (compact && a >= 1e4) return `${n < 0 ? "−" : ""}$${(a / 1e3).toFixed(1)}k`;
  const dp = a >= 1000 ? 0 : a >= 0.01 || a === 0 ? 2 : 4;
  return `${n < 0 ? "−" : ""}$${a.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
};
export const amt = (n: number, dp = 4) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : dp });
export const pct = (n: number | undefined, dp = 1) => (n == null ? "—" : `${(n * 100).toFixed(dp)}%`);
export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
export const ago = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
