/**
 * Token usage and list-price cost of every Claude call, one log line each:
 *   [usage] {"label":"agent","model":"claude-opus-5-5","in":…,"out":…,"usd":…}
 * The basis for metering, budgets and per-user caps if Tailor is ever hosted.
 */
type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; server_tool_use?: { web_search_requests?: number } | null };

// $ per million tokens (input, output, cache read); cache writes are 1.25× input. Web search $10 per 1,000.
const PRICES: Record<string, [number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
};

export function logUsage(label: string, model: string, u: Usage | null | undefined): void {
  if (!u) return;
  const [pi, po, pr] = PRICES[model] ?? [0, 0, 0];
  const read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0, searches = u.server_tool_use?.web_search_requests ?? 0;
  const usd = ((u.input_tokens ?? 0) * pi + write * pi * 1.25 + read * pr + (u.output_tokens ?? 0) * po) / 1e6 + searches * 0.01;
  console.log(`[usage] ${JSON.stringify({ label, model, in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cacheRead: read, cacheWrite: write, searches, usd: Number(usd.toFixed(5)) })}`);
}
