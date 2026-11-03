/**
 * Main-world content script: registers Tailor as a Wallet Standard wallet, so any
 * Solana dApp using the wallet adapter discovers it automatically.
 */
import { registerWallet } from "@wallet-standard/wallet";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { PAGE_CHANNEL, type DappEvent, type DappResponse } from "~/shared/messages";
import { ICON } from "~/shared/icon";
import bs58 from "bs58";

const CHAINS = ["solana:mainnet"] as const;
const FEATURES = ["solana:signTransaction", "solana:signAndSendTransaction", "solana:signMessage", "solana:signIn"] as const;

const toB64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

class Account implements WalletAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains = CHAINS;
  readonly features = FEATURES;
  constructor(address: string) { this.address = address; this.publicKey = bs58.decode(address); }
}

const waiting = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
const listeners = new Set<(p: { accounts: readonly WalletAccount[] }) => void>();

function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    window.postMessage({ channel: PAGE_CHANNEL, dir: "to-cs", req: { id, method, params } }, window.location.origin);
  });
}

class TailorWallet implements Wallet {
  readonly version = "1.0.0" as const;
  readonly name = "Tailor";
  readonly icon = ICON;
  readonly chains = CHAINS;
  #accounts: Account[] = [];
  get accounts() { return this.#accounts; }

  setAccounts(list: { address: string }[]) {
    const next = list.map((a) => new Account(a.address));
    if (next.map((a) => a.address).join() === this.#accounts.map((a) => a.address).join()) return;
    this.#accounts = next;
    for (const l of listeners) l({ accounts: this.#accounts });
  }

  readonly features = {
    "standard:connect": {
      version: "1.0.0",
      connect: async (input?: { silent?: boolean }) => {
        this.setAccounts(await request<{ address: string }[]>("connect", { silent: !!input?.silent }));
        return { accounts: this.#accounts };
      },
    },
    "standard:disconnect": {
      version: "1.0.0",
      disconnect: async () => { await request("disconnect"); this.setAccounts([]); },
    },
    "standard:events": {
      version: "1.0.0",
      on: (event: "change", listener: (p: { accounts: readonly WalletAccount[] }) => void) => {
        if (event !== "change") return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    "solana:signTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signTransaction: async (...inputs: { account: WalletAccount; transaction: Uint8Array }[]) => {
        const out = await request<string[]>("signTransaction", { account: inputs[0]?.account.address, transactions: inputs.map((i) => toB64(i.transaction)) });
        return out.map((t) => ({ signedTransaction: fromB64(t) }));
      },
    },
    "solana:signAndSendTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      signAndSendTransaction: async (...inputs: { account: WalletAccount; transaction: Uint8Array }[]) => {
        const sigs = await request<string[]>("signAndSendTransaction", { account: inputs[0]?.account.address, transactions: inputs.map((i) => toB64(i.transaction)) });
        return sigs.map((s) => ({ signature: bs58.decode(s) }));
      },
    },
    "solana:signMessage": {
      version: "1.0.0",
      signMessage: async (...inputs: { account: WalletAccount; message: Uint8Array }[]) => {
        const out = [];
        for (const i of inputs) {
          const sig = await request<string>("signMessage", { account: i.account.address, message: toB64(i.message) });
          out.push({ signedMessage: i.message, signature: fromB64(sig) });
        }
        return out;
      },
    },
    "solana:signIn": {
      version: "1.0.0",
      signIn: async (...inputs: Record<string, unknown>[]) => {
        const out = [];
        for (const input of inputs.length ? inputs : [{}]) {
          const r = await request<{ address: string; signedMessage: string; signature: string }>("signIn", { input });
          this.setAccounts([{ address: r.address }]);
          out.push({ account: this.#accounts[0], signedMessage: fromB64(r.signedMessage), signature: fromB64(r.signature), signatureType: "ed25519" as const });
        }
        return out;
      },
    },
  };
}

const wallet = new TailorWallet();

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window || e.data?.channel !== PAGE_CHANNEL || e.data.dir !== "to-page") return;
  const msg = e.data.msg as DappResponse | DappEvent;
  if ("event" in msg) { if (msg.event === "change") wallet.setAccounts(msg.accounts); return; }
  const w = waiting.get(msg.id);
  if (!w) return;
  waiting.delete(msg.id);
  if (msg.error) w.reject(new Error(msg.error)); else w.resolve(msg.result);
});

registerWallet(wallet);
