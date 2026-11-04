/** Typed messages between extension pages (popup, side panel, approval, onboarding) and the background worker. */

export interface AccountMeta {
  id: string;
  name: string;
  address: string;
  kind: "derived" | "imported" | "watch" | "ledger";
  index?: number;           // derivation index for "derived"
  path?: string;            // derivation path on the device for "ledger"
}

export interface WalletState {
  initialized: boolean;     // a vault exists
  unlocked: boolean;
  accounts: AccountMeta[];
  activeId: string | null;
  autoLockMinutes: number;
  apiBase: string;
}

export type DappMethod = "connect" | "signTransaction" | "signAndSendTransaction" | "signMessage" | "signIn";

export interface PendingRequest {
  id: string;
  origin: string;
  method: DappMethod;
  account: string;          // address the dApp wants to use
  // signTransaction / signAndSend: base64 txs; signMessage: base64 bytes; signIn: the SIWS message text
  payload: string[];
  messageText?: string;     // decoded UTF-8 for signMessage / signIn
  warnings: string[];       // origin mismatch, etc.
  createdAt: number;
}

export type UiRequest =
  | { type: "state" }
  | { type: "create"; password: string; mnemonic: string }
  | { type: "import"; password: string; mnemonic?: string; privateKey?: string }
  | { type: "unlock"; password: string }
  | { type: "unlockWithKey"; key: string }
  | { type: "exportVaultKey"; password: string }
  | { type: "lock" }
  | { type: "addAccount"; name?: string }
  | { type: "importKey"; privateKey: string; name?: string }
  | { type: "addWatch"; address: string; name?: string }
  | { type: "addLedger"; accounts: { address: string; path: string }[] }
  | { type: "renameAccount"; id: string; name: string }
  | { type: "removeAccount"; id: string }
  | { type: "setActive"; id: string }
  | { type: "reveal"; password: string; what: "mnemonic" | "privateKey"; id?: string }
  | { type: "setAutoLock"; minutes: number }
  | { type: "setApiBase"; url: string }
  | { type: "signOwn"; txs: string[] }                 // UI-initiated txs, already reviewed in the trusted sheet
  | { type: "sendSigned"; tx: string }
  | { type: "getPending"; id: string }
  | { type: "decide"; id: string; approve: boolean; signed?: string[] }   // signed: Ledger-signed txs from the approval window
  | { type: "setAlerts"; on: boolean }
  | { type: "checkAlerts" }
  | { type: "connectedSites" }
  | { type: "disconnectSite"; origin: string };

export type UiResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export async function call<T = unknown>(req: UiRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as UiResponse<T> | undefined;
  if (!res) throw new Error("Wallet background isn't responding. Reload the extension.");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

// dApp bridge (page ⇄ content script ⇄ background)
export const PAGE_CHANNEL = "tailor-wallet-v1";
export interface DappRequest { id: string; method: DappMethod | "disconnect" | "accounts"; params: Record<string, unknown> }
export type DappResponse = { id: string; result?: unknown; error?: string };
export type DappEvent = { event: "change"; accounts: { address: string }[] };
