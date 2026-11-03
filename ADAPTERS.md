# Writing a protocol adapter

Tailor is a generative Solana wallet: paste an address → we read every DeFi position →
Claude composes a personalized dashboard of protocol-specific widgets with real action
buttons (close, repay, withdraw, cancel…). This file is the brief for adapter authors.

## Contract
- Read `lib/core/types.ts` (the contract) and `lib/core/solana.ts` (helpers) first.
- Export `xxxAdapter: Adapter` from `lib/adapters/<protocol>.ts`. Helpers may live in
  `lib/adapters/<protocol>/`. Do **not** edit `lib/core/*`, `lib/adapters/index.ts`,
  `swap.ts`, or another protocol's files. If the contract truly needs a change, describe it
  in your report instead.
- `positions(owner, ctx)` returns normalized `Position`s. Never throw for "this wallet has no
  account" — return `[]`. Keep it fast (< 10 s; the snapshot times out at 15 s); batch RPC
  calls (`getMultipleAccountsInfo`), prefer official REST APIs where they exist.
- `id` is `"<protocol>:<stable id>"` (obligation/position/order pubkey). Put everything
  `build()` needs into `raw` (JSON only — strings/numbers, no PublicKey/BN/class objects).
- If a position represents tokens sitting in the wallet (LSTs, JLP, vault share tokens),
  set `raw.claimsMints = [mint]` so the token list doesn't double-count them.
- `risk`: use `riskFromHealth()` for anything liquidatable (health 100 = safe, 0 = liquidated)
  with a plain-English `reason` ("LTV 78% vs 85% liquidation", "12% from liquidation price").
  Non-liquidatable positions: `{ level: "ok", score: <0–20 based on size/attention needed> }`.
  Expiring/claimable/filled things that need attention: `watch`, score 40–60.
- `metrics`: 2–5 short stats the card should show (APY, leverage, entry, PnL…).
- `actions`: real ones only. `danger: true` for close/liquidating moves. Use `fields` for
  amounts (`max` = full amount in UI units) — `build()` gets the values as strings in `params`.
- `build()` returns **unsigned** base64 transactions (v0) in send order + a one-sentence
  `summary`. Use `buildTx()` / `lookupTables()` from `lib/core/solana.ts` for web3.js
  instructions; if an SDK/API hands you a ready transaction, return its base64 directly.
  The fee payer / signer is always `owner`. Never require any other signer (no keypairs).
- Optional `tools` + `buildTool()` for actions not tied to a position (e.g. deposit/stake).
  Tool ids must be globally unique and prefixed with the protocol (`kamino-deposit`).
- Swap providers (Jupiter/Titan/DFlow) implement `SwapProvider` (types.ts) and export it as
  `jupiterSwap` / `titanSwap` / `dflowSwap`; `quote()` returns `null` on no route/error.
  The tx must be sendable through a normal RPC `sendTransaction` (our `/api/send`).

## Rules
- **Never sign or send transactions. Never generate, load or ask for private keys.**
- Do **not** run `npm install` / add dependencies — several people are editing this tree at once
  and concurrent installs corrupt `node_modules`. Already installed: `@solana/web3.js`,
  `@solana/kit`, `@solana/spl-token`, `@solana/spl-stake-pool`, `@kamino-finance/klend-sdk`,
  `@kamino-finance/kliquidity-sdk`, `@drift-labs/sdk`, `@mrgnlabs/marginfi-client-v2`,
  `@ellipsis-labs/rise`, `@titanexchange/sdk-ts`, `bs58`, `zod`. If something else is truly
  required, use the protocol's REST API or raw instructions instead, or say so in your report.
- Read installed SDK sources/typings under `node_modules/` rather than guessing APIs; SDK
  versions are recent and may differ from what you remember.
- Env: `.env.local` has `HELIUS_API_KEY` (RPC + DAS + enhanced txs) and `JUPITER_API_KEY`.
  Need another key? Say so; make the adapter degrade gracefully (return `[]` / `null`).

## Verify (required)
1. `npx tsc --noEmit -p .` passes for your files (ignore errors in files you don't own).
2. Find 1–3 **real mainnet wallets** that hold the positions you support (protocol APIs,
   leaderboards, `getProgramAccounts`, recent program txs via Helius). Write a scratch script
   in the scratchpad dir and run it with
   `npx tsx --env-file=.env.local --tsconfig tsconfig.json <script>` from the repo root.
   Check `positions()` output is correct and sane, then call `build()` for the main actions
   and pass each tx to `simulate()` from `lib/core/solana.ts` (sigVerify is off, so you can
   simulate as any owner). A close/repay that simulates OK on a real wallet is the bar.
3. Report: what's supported (positions, actions, tools), the wallets + simulation results,
   anything that doesn't work yet and why. Keep it concise.
