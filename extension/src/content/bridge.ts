/**
 * Isolated-world content script: relays Wallet Standard requests from the page's
 * provider to the background over a runtime port, and pushes account changes back.
 * Chrome attaches the true origin to the port; nothing the page says about itself is trusted.
 */
import { PAGE_CHANNEL, type DappRequest } from "~/shared/messages";

let port: chrome.runtime.Port | null = null;
// After an extension update a fresh bridge is injected next to this (now dead) one; the newest owns the page.
const ME = Math.random().toString(36).slice(2);
document.documentElement.dataset.tailorBridge = ME;
const superseded = () => document.documentElement.dataset.tailorBridge !== ME;

function getPort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: "dapp" });
  port.onMessage.addListener((msg) => {
    // The wallet asking what this page is about: answered here, never forwarded to the page.
    if (msg?.kind === "readPage") { try { port?.postMessage({ kind: "page", id: msg.id, page: readPage() }); } catch { /* port closed */ } return; }
    window.postMessage({ channel: PAGE_CHANNEL, dir: "to-page", msg }, window.location.origin);
  });
  // The background can restart; reconnect so the wallet still knows this tab's site.
  port.onDisconnect.addListener(() => { port = null; setTimeout(() => { try { getPort(); } catch { /* extension reloaded */ } }, 1000); });
  return port;
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window || e.data?.channel !== PAGE_CHANNEL || e.data.dir !== "to-cs") return;
  if (superseded()) return;
  const req = e.data.req as DappRequest;
  if (!req || typeof req.id !== "string" || typeof req.method !== "string") return;
  try { getPort().postMessage(req); }
  catch { port = null; try { getPort().postMessage(req); } catch (err) { window.postMessage({ channel: PAGE_CHANNEL, dir: "to-page", msg: { id: req.id, error: "Tailor was updated. Reload this page." } }, window.location.origin); } }
});

/**
 * A compact read of what the user is looking at, for suggestions: title, the visible text
 * (tweets/articles first), any selection, and tickers / addresses mentioned anywhere.
 * Pages with a password field are skipped, and query strings are left out of the URL.
 */
function readPage() {
  if (document.querySelector("input[type=password]")) return null;
  const inView = (el: Element) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.height > 0; };
  // Innermost blocks only (a tweet inside <main> is read once), visible ones first.
  const found = [...document.querySelectorAll("article, main, [role=main]")].filter(inView);
  const blocks = found.filter((b) => !found.some((o) => o !== b && b.contains(o)));
  const clean = (t: string) => t.replace(/\s+/g, " ").trim();
  const visible = clean((blocks.length ? blocks : [document.body]).map((b) => (b as HTMLElement).innerText).join(" \n "));
  const all = document.body?.innerText ?? "";
  const uniq = (xs: string[]) => [...new Set(xs)].slice(0, 12);
  return {
    url: location.origin + location.pathname,
    title: document.title.slice(0, 200),
    selection: clean(getSelection()?.toString() ?? "").slice(0, 1000),
    text: visible.slice(0, 5000),
    cashtags: uniq((all.match(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g) ?? []).map((x) => x.slice(1).toUpperCase())),
    addresses: uniq(all.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) ?? []),
  };
}

// Open a port eagerly so account-change events reach already-connected sites.
getPort();
