# Security

Tailor is experimental and has **not been audited**. It handles real keys and real funds on
Solana mainnet. Use a dedicated wallet with small amounts.

## Reporting a vulnerability

Please report privately through GitHub's **Security → Report a vulnerability** on this
repository rather than opening a public issue. Include steps to reproduce and the impact.

## Design

- **Keys stay in the extension.** The seed is encrypted with PBKDF2 (600k iterations) +
  AES-GCM; the unlocked session key lives in `chrome.storage.session` and is cleared on lock
  and auto-lock. Optional unlock via passkey (WebAuthn PRF) and signing via Ledger.
- **The server is trusted to build transactions, not to sign them.** Every transaction is
  simulated and its balance changes shown in the extension before signing, with an AI
  explanation and an independent intent check. Run your own server; don't point the
  extension at one you don't control.
- **dApp connections** use the Wallet Standard. The origin comes from Chrome, never from the
  page. Approvals open in a separate window.
- **Generated UI** (the AI-drawn cards) renders through a fixed component kit; custom code
  runs in an MV3 sandbox page with no extension or network access, and cannot use the
  clipboard (copying only happens through a visible, trusted field).
- **Page reading** (optional) runs in Chrome's isolated content-script world, which pages
  can't see or spoof, and only while the wallet is open.

## Known limitations

- No audit, no bug bounty.
- The server has no authentication beyond the localhost bind and the extension-origin pin.
  Do not deploy it publicly as-is.
- Simulation reflects chain state at review time; a transaction can still behave
  differently if state changes before it lands.
- AI explanations can be wrong. The simulated balance changes are the source of truth.
