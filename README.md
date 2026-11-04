# Tailor

A generative, self-custodial Solana wallet for Chrome. Instead of one fixed screen, Claude
builds your wallet around what you actually do: your positions on Kamino, Jupiter, Drift,
marginfi, Phoenix and more, each with real actions; a look you describe in words; and an
ask bar that can answer questions, draw views, and build transactions on any protocol.

> **Experimental software. Not audited.** It runs on Solana mainnet with real funds. Use a
> fresh wallet holding only what you're willing to lose, and read [SECURITY.md](SECURITY.md).

## How it works

```
 Chrome extension                 Your local server (this repo)          Services
 ─────────────────                ─────────────────────────────          ────────
 seed + keys (encrypted)   ──▶    builds + simulates transactions  ──▶   Solana RPC (Helius)
 signs locally                    reads positions                        Jupiter, protocol APIs
 shows every tx for review ◀──    Claude: layout, agent, explainer ──▶   Anthropic API
```

- **The extension** holds the wallet. The seed is encrypted on your device (PBKDF2 +
  AES-GCM) and never leaves it. All signing happens in the extension (or on a Ledger).
- **The server** runs on your machine with **your** API keys. It reads the chain, builds
  unsigned transactions, simulates them, and runs Claude. It never sees your keys.
- Nothing is hosted for you: each person runs their own server with their own keys.

## Setup

Requirements: Node 22+, Chrome (or another Chromium browser), and three API keys:

| Key | What it's for | Cost |
|---|---|---|
| `ANTHROPIC_API_KEY` ([console.anthropic.com](https://console.anthropic.com)) | Claude: the agent, layout, themes, transaction explanations | Pay as you go |
| `HELIUS_API_KEY` ([helius.dev](https://helius.dev)) | Solana RPC, balances, transaction history | Free tier is enough |
| `JUPITER_API_KEY` ([portal.jup.ag](https://portal.jup.ag)) | Prices, token data, swap routing | Free tier is enough |

```bash
git clone <this repo> tailor && cd tailor
npm install
cp .env.example .env.local      # then fill in the three keys above
npm run extension               # builds the extension into extension/dist
npm run dev                     # starts the server on http://127.0.0.1:3210
```

Then in Chrome: open `chrome://extensions`, turn on **Developer mode**, click **Load
unpacked** and pick `extension/dist`. Click the Tailor icon to create or import a wallet.

`npm run dev` checks your keys first and tells you what each missing one would unlock.

Optional keys add features; everything else works without them:

| Optional | Adds | Without it |
|---|---|---|
| `TOKENS_XYZ_API_KEY` ([free key](https://www.tokens.xyz/assets-api)) | "Registered" checkmarks, richer stock/ETF/metal lists | Jupiter's verified list and checkmarks |
| `TITAN_API_KEY` | Titan as an extra swap route | Jupiter + DFlow routes |
| `DFLOW_API_KEY` | DFlow production swaps, prediction-market positions | DFlow's rate-limited test API; no DFlow positions |
| `MOONPAY_PUBLISHABLE_KEY` + `MOONPAY_SECRET_KEY` | Buy with card | Other funding options (exchange, bridge, QR) |
| `DATABASE_URL` | Saved layouts survive restarts | Kept in memory |
| `SOLANA_RPC_URL` | Your own RPC for transactions | Helius |

Prediction markets (Polymarket odds) and Phoenix perps need no key. Trading on Phoenix
requires a Phoenix account activated on [app.phoenix.trade](https://app.phoenix.trade)
(it's invite-only).

After pulling changes: `npm run extension`, then click reload on Tailor in
`chrome://extensions`.

## What gets sent where

| Data | Goes to | When |
|---|---|---|
| Your wallet address, balances, positions | Helius, Jupiter, the protocols' APIs | Whenever the wallet loads |
| Your questions + a summary of your wallet | Anthropic (via your server) | When you ask something, or the home is rebuilt |
| Transactions to review | Anthropic (explanation + independent check) | When a dApp asks you to sign |
| Domains of sites that ask to connect | Your server's phishing check | On connect / sign requests |
| Visible text of the page you're on | Anthropic (via your server) | Only while Tailor is open, if **Page suggestions** is on (Settings) |

Your seed phrase and private keys are never sent anywhere. Pages with a password field are
never read, and query strings are stripped from URLs.

## Safety model, briefly

- Every transaction, from dApps or from Tailor itself, is simulated and shown with its exact
  balance changes before you sign. An AI explanation and a separate, independent intent check
  are added on top; the AI can raise a risk level but never lower the code's warnings.
- Phishing domains, address poisoning, durable-nonce and owner-change transactions are flagged.
- The server only listens on `127.0.0.1` and only accepts requests from the Tailor extension
  (pinned by the fixed ID in `extension/public/manifest.json`) or its own pages. Don't expose
  it to the internet: it has no user accounts and spends your API credits.

## Development

- `lib/` server logic: `core/` (chain, simulation), `adapters/` (one per protocol, see
  [ADAPTERS.md](ADAPTERS.md)), `agent/` (the ask-bar agent and its tools), `genui/` (the
  generated UI kit), `security/`.
- `extension/` the Chrome extension (Vite, MV3): `background/` vault + dApp bridge, `ui/`.
- `npm run eval` runs the answer-quality eval in `evals/` against your dev server (costs API
  credits). Results land in `evals/results/`.

## License

[MIT](LICENSE)
