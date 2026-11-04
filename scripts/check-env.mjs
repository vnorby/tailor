// Runs before `npm run dev` / `npm start`: says which keys are set and what's missing, so a
// fresh clone fails with instructions instead of confusing errors later. Prints names only.
import { existsSync, readFileSync } from "node:fs";

const env = { ...process.env };
for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const required = [
  ["ANTHROPIC_API_KEY", "Claude: the agent, home layout, themes, explanations (console.anthropic.com)"],
  ["HELIUS_API_KEY", "Solana RPC, token balances and history (helius.dev, free tier works)"],
];
const optional = [
  ["JUPITER_API_KEY", "higher Jupiter rate limits (falls back to the free lite-api)"],
  ["TOKENS_XYZ_API_KEY", "tokens.xyz asset registry: tokenized stocks, verified checkmarks, curated lists"],
  ["TITAN_API_KEY", "Titan as an extra swap route"],
  ["DFLOW_API_KEY", "DFlow production swaps and prediction-market positions"],
  ["MOONPAY_PUBLISHABLE_KEY", "buy-with-card on-ramp (with MOONPAY_SECRET_KEY)"],
  ["DATABASE_URL", "Postgres for saved layouts (otherwise kept in memory until restart)"],
];

const missing = required.filter(([k]) => !env[k]);
console.log("\nTailor environment");
for (const [k, why] of required) console.log(`  ${env[k] ? "✓" : "✗"} ${k}${env[k] ? "" : `  — required: ${why}`}`);
for (const [k, why] of optional) console.log(`  ${env[k] ? "✓" : "·"} ${k}${env[k] ? "" : `  — optional: ${why}`}`);
if (env.EXTENSION_IDS === "*") console.log("\n  ! EXTENSION_IDS=* lets any installed extension use this server and your API keys.");
if (missing.length) {
  console.error(`\nMissing ${missing.map(([k]) => k).join(", ")}. Copy .env.example to .env.local and fill them in.\n`);
  process.exit(1);
}
console.log("");
