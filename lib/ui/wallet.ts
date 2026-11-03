"use client";

import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { StandardConnectFeature } from "@wallet-standard/features";
import type { SolanaSignTransactionFeature } from "@solana/wallet-standard-features";

// Wallet Standard: Phantom, Solflare, Backpack and others register themselves; no adapter list to maintain.
export type SolWallet = Wallet & { features: StandardConnectFeature & SolanaSignTransactionFeature };

// Wallets we list even when they aren't installed, with where to get them.
export const KNOWN_WALLETS = [
  { name: "Phantom", match: /phantom/i, get: "https://phantom.com/download" },
  { name: "Solflare", match: /solflare/i, get: "https://solflare.com/download" },
  { name: "Jupiter", match: /jupiter/i, get: "https://jup.ag/wallet" },
  { name: "Backpack", match: /backpack/i, get: "https://backpack.app/downloads" },
] as const;

// MetaMask now registers for Solana too; we leave it out on purpose.
const EXCLUDED = /metamask/i;

export function solanaWallets(): SolWallet[] {
  return getWallets().get().filter(
    (w): w is SolWallet =>
      !EXCLUDED.test(w.name) && w.chains.some((c) => c.startsWith("solana:")) && "standard:connect" in w.features && "solana:signTransaction" in w.features,
  );
}

export function onWalletsChange(cb: () => void) {
  const api = getWallets();
  const offA = api.on("register", cb);
  const offB = api.on("unregister", cb);
  return () => { offA(); offB(); };
}

export async function connect(w: SolWallet): Promise<WalletAccount> {
  const { accounts } = await w.features["standard:connect"].connect();
  const acct = accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
  if (!acct) throw new Error("The wallet didn't share an account.");
  return acct;
}

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));

// The wallet shows the user exactly what the transaction does before they approve it.
export async function signTx(w: SolWallet, account: WalletAccount, base64Tx: string): Promise<string> {
  const [out] = await w.features["solana:signTransaction"].signTransaction({ account, transaction: fromB64(base64Tx), chain: "solana:mainnet" });
  return toB64(out.signedTransaction);
}
