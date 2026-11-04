/**
 * Background service worker: the only place keys exist.
 *
 * Two channels with different trust:
 *  - runtime.sendMessage from extension pages (popup, side panel, approval, onboarding):
 *    full wallet API. Rejected unless the sender is this extension's own origin.
 *  - runtime ports named "dapp" from the content script: the Wallet Standard surface.
 *    The origin comes from Chrome (sender.origin), never from the page, and every
 *    signature requires an explicit approval in an extension window.
 */
import bs58 from "bs58";
import * as vault from "./vault";
import { applySignature, b64 } from "~/shared/tx";
import { verifyDeviceSigned } from "~/shared/verify";
import { sign } from "~/vault/derive";
import type { DappEvent, DappRequest, DappResponse, PendingRequest, UiRequest, UiResponse } from "~/shared/messages";

const EXT_ORIGIN = `chrome-extension://${chrome.runtime.id}`;

// ---------- RPC via the Tailor backend (keeps provider keys off the client) ----------

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const { apiBase } = await vault.getMeta();
  const r = await fetch(`${apiBase}/api/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
  const j = (await r.json()) as { result?: T; error?: string };
  if (!r.ok || j.error) throw new Error(j.error ?? `RPC ${method} failed (${r.status})`);
  return j.result as T;
}

async function sendRaw(signedB64: string): Promise<string> {
  return rpc<string>("sendTransaction", [signedB64, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]);
}

// ---------- signing ----------

async function signTxs(address: string, txs: string[]): Promise<string[]> {
  const kp = await vault.keypairFor(address);
  return txs.map((t) => b64.enc(applySignature(b64.dec(t), kp.publicKey, (m) => sign(m, kp.secretKey))));
}

// ---------- approvals ----------

interface Decision { approve: boolean; signed?: string[] }
const pending = new Map<string, PendingRequest & { resolve(d: Decision): void; windowId?: number }>();

async function requestApproval(req: Omit<PendingRequest, "id" | "createdAt">): Promise<Decision> {
  const id = crypto.randomUUID();
  return new Promise<Decision>((resolve) => {
    const entry: PendingRequest & { resolve(d: Decision): void; windowId?: number } = { ...req, id, createdAt: Date.now(), resolve };
    pending.set(id, entry);
    void chrome.windows.create({ url: `approve.html?id=${id}`, type: "popup", width: 380, height: 660, focused: true })
      .then((w) => { entry.windowId = w?.id; })
      .catch(() => { pending.delete(id); resolve({ approve: false }); });
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, p] of pending) if (p.windowId === windowId) { pending.delete(id); p.resolve({ approve: false }); }
});

function decide(id: string, approve: boolean, signed?: string[]) {
  const p = pending.get(id);
  if (!p) throw new Error("This request expired.");
  pending.delete(id);
  p.resolve({ approve, signed });
  if (p.windowId != null) void chrome.windows.remove(p.windowId).catch(() => {});
}

// ---------- dApp connections ----------

const ports = new Set<chrome.runtime.Port>();

async function isConnected(origin: string) { return !!(await vault.getMeta()).sites[origin]; }

async function signingAccount() {
  const a = await vault.activeAccount();
  if (!a) throw new Error("No account.");
  if (a.kind === "watch") throw new Error("The active account is watch-only. Switch to an account that can sign.");
  return a;
}

async function broadcastAccounts() {
  const active = await vault.activeAccount();
  const meta = await vault.getMeta();
  for (const port of ports) {
    const origin = port.sender?.origin;
    if (!origin || !meta.sites[origin]) continue;
    const ev: DappEvent = { event: "change", accounts: active && active.kind !== "watch" ? [{ address: active.address }] : [] };
    port.postMessage(ev);
  }
}

function siwsMessage(input: Record<string, unknown>, address: string, origin: string): { text: string; warnings: string[] } {
  const host = new URL(origin).host;
  const domain = typeof input.domain === "string" ? input.domain : host;
  const warnings = domain !== host ? [`This site (${host}) is asking you to sign in to a different domain (${domain}). This is a common phishing pattern.`] : [];
  let text = `${domain} wants you to sign in with your Solana account:\n${address}`;
  if (typeof input.statement === "string" && input.statement) text += `\n\n${input.statement}`;
  const fields: string[] = [];
  const add = (label: string, key: string) => { if (typeof input[key] === "string" && input[key]) fields.push(`${label}: ${input[key]}`); };
  add("URI", "uri"); add("Version", "version"); add("Chain ID", "chainId"); add("Nonce", "nonce");
  fields.push(`Issued At: ${typeof input.issuedAt === "string" ? input.issuedAt : new Date().toISOString()}`);
  add("Expiration Time", "expirationTime"); add("Not Before", "notBefore"); add("Request ID", "requestId");
  if (Array.isArray(input.resources) && input.resources.length) fields.push(`Resources:\n${input.resources.map((r) => `- ${r}`).join("\n")}`);
  return { text: `${text}\n\n${fields.join("\n")}`, warnings };
}

async function handleDapp(origin: string, req: DappRequest): Promise<unknown> {
  if (!/^https?:\/\//.test(origin)) throw new Error("Unsupported origin.");
  const unlockedBefore = (await vault.state()).unlocked;
  switch (req.method) {
    case "accounts": {
      if (!(await isConnected(origin)) || !unlockedBefore) return [];
      const a = await vault.activeAccount();
      return a && a.kind !== "watch" ? [{ address: a.address }] : [];
    }
    case "connect": {
      if (await isConnected(origin)) { const a = await signingAccount(); return [{ address: a.address }]; }
      if (req.params.silent) return [];
      const a = await signingAccount().catch(() => null);
      const { approve } = await requestApproval({ origin, method: "connect", account: a?.address ?? "", payload: [], warnings: [] });
      if (!approve) throw new Error("User rejected the request.");
      const acct = await signingAccount();
      const meta = await vault.getMeta();
      meta.sites[origin] = { connectedAt: Date.now() };
      await vault.setMeta(meta);
      return [{ address: acct.address }];
    }
    case "disconnect": {
      const meta = await vault.getMeta();
      delete meta.sites[origin];
      await vault.setMeta(meta);
      return null;
    }
    case "signTransaction":
    case "signAndSendTransaction": {
      if (!(await isConnected(origin))) throw new Error("Connect first.");
      const acct = await signingAccount();
      const address = String(req.params.account ?? acct.address);
      if (address !== acct.address) throw new Error("That account isn't the active account in Tailor.");
      const txs = (req.params.transactions as string[] | undefined) ?? [];
      if (!txs.length || txs.length > 20) throw new Error("Invalid transactions.");
      const d = await requestApproval({ origin, method: req.method, account: address, payload: txs, warnings: [] });
      if (!d.approve) throw new Error("User rejected the request.");
      const signed = acct.kind === "ledger" ? verifyDeviceSigned(address, txs, d.signed) : await signTxs(address, txs);
      if (req.method === "signTransaction") return signed;
      const sigs: string[] = [];
      for (const s of signed) sigs.push(await sendRaw(s));
      return sigs;
    }
    case "signMessage": {
      if (!(await isConnected(origin))) throw new Error("Connect first.");
      const acct = await signingAccount();
      if (acct.kind === "ledger") throw new Error("Message signing isn't supported for Ledger accounts in Tailor yet.");
      const msg = String(req.params.message ?? "");
      const bytes = b64.dec(msg);
      let text: string | undefined;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* binary message */ }
      // A message that parses as a transaction could be a disguised signature request.
      const looksLikeTx = !text && bytes.length > 64 && (bytes[0] & 0x80 || bytes[0] <= 3);
      const warnings = looksLikeTx ? ["This message looks like a transaction. Signing it could authorize a transfer."] : [];
      const { approve } = await requestApproval({ origin, method: "signMessage", account: acct.address, payload: [msg], messageText: text, warnings });
      if (!approve) throw new Error("User rejected the request.");
      const kp = await vault.keypairFor(acct.address);
      return b64.enc(sign(bytes, kp.secretKey));
    }
    case "signIn": {
      const acct = await signingAccount();
      if (acct.kind === "ledger") throw new Error("Sign-in with a Ledger account isn't supported in Tailor yet.");
      const { text, warnings } = siwsMessage(req.params.input as Record<string, unknown> ?? {}, acct.address, origin);
      const { approve } = await requestApproval({ origin, method: "signIn", account: acct.address, payload: [], messageText: text, warnings });
      if (!approve) throw new Error("User rejected the request.");
      const meta = await vault.getMeta();
      meta.sites[origin] = { connectedAt: Date.now() };
      await vault.setMeta(meta);
      const kp = await vault.keypairFor(acct.address);
      const bytes = new TextEncoder().encode(text);
      return { address: acct.address, signedMessage: b64.enc(bytes), signature: b64.enc(sign(bytes, kp.secretKey)) };
    }
  }
  throw new Error("Unsupported method.");
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "dapp" || !port.sender?.origin || port.sender.id !== chrome.runtime.id) { port.disconnect(); return; }
  const origin = port.sender.origin;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (req: DappRequest) => {
    let res: DappResponse;
    try { res = { id: req.id, result: await handleDapp(origin, req) }; }
    catch (e) { res = { id: req.id, error: e instanceof Error ? e.message : String(e) }; }
    try { port.postMessage(res); } catch { /* tab went away */ }
  });
});

// ---------- extension pages ----------

async function handleUi(req: UiRequest): Promise<unknown> {
  switch (req.type) {
    case "state": return vault.state();
    case "create": await vault.create(req.password, req.mnemonic); return vault.state();
    case "import": await vault.create(req.password, req.mnemonic ?? "", req.privateKey); return vault.state();
    case "unlock": await vault.unlock(req.password); await broadcastAccounts(); return vault.state();
    case "lock": await vault.lock(); return vault.state();
    case "addAccount": { const a = await vault.addDerived(req.name); await broadcastAccounts(); return a; }
    case "importKey": { const a = await vault.importKey(req.privateKey, req.name); await broadcastAccounts(); return a; }
    case "addWatch": return vault.addWatch(req.address, req.name);
    case "addLedger": { const a = await vault.addLedger(req.accounts); await broadcastAccounts(); return a; }
    case "renameAccount": { const m = await vault.getMeta(); const a = m.accounts.find((x) => x.id === req.id); if (a) a.name = req.name.slice(0, 32); await vault.setMeta(m); return null; }
    case "removeAccount": await vault.removeAccount(req.id); await broadcastAccounts(); return vault.state();
    case "setActive": { const m = await vault.getMeta(); if (m.accounts.some((a) => a.id === req.id)) m.activeId = req.id; await vault.setMeta(m); await broadcastAccounts(); return vault.state(); }
    case "reveal": return vault.reveal(req.password, req.what, req.id);
    case "setAutoLock": { const m = await vault.getMeta(); m.autoLockMinutes = Math.min(24 * 60, Math.max(1, Math.round(req.minutes))); await vault.setMeta(m); await vault.bumpAutoLock(); return null; }
    case "setApiBase": { const m = await vault.getMeta(); m.apiBase = req.url.replace(/\/$/, ""); await vault.setMeta(m); return null; }
    case "signOwn": { const a = await signingAccount(); if (a.kind === "ledger") throw new Error("Ledger accounts sign on the device."); return signTxs(a.address, req.txs); }
    case "sendSigned": return sendRaw(req.tx);
    case "getPending": { const p = pending.get(req.id); if (!p) throw new Error("This request expired."); const { resolve: _r, windowId: _w, ...pub } = p; return pub; }
    case "decide": decide(req.id, req.approve, req.signed); return null;
    case "connectedSites": return Object.entries((await vault.getMeta()).sites).map(([origin, v]) => ({ origin, ...v }));
    case "disconnectSite": { const m = await vault.getMeta(); delete m.sites[req.origin]; await vault.setMeta(m); return null; }
  }
}

chrome.runtime.onMessage.addListener((req: UiRequest, sender, sendResponse) => {
  // Only this extension's own pages may use the wallet API — never content scripts or web pages.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(EXT_ORIGIN + "/")) {
    sendResponse({ ok: false, error: "Forbidden" } satisfies UiResponse);
    return false;
  }
  (async () => {
    try {
      if (req.type !== "state" && req.type !== "getPending") await vault.bumpAutoLock().catch(() => {});
      sendResponse({ ok: true, data: await handleUi(req) } satisfies UiResponse);
    } catch (e) { sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies UiResponse); }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "autolock") { await vault.lock(); await broadcastAccounts(); }
});

chrome.runtime.onInstalled.addListener(async (d) => {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  if (d.reason === "install") void chrome.tabs.create({ url: "onboarding.html" });
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });
});
chrome.runtime.onStartup.addListener(() => { void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); });
