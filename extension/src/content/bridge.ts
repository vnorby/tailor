/**
 * Isolated-world content script: relays Wallet Standard requests from the page's
 * provider to the background over a runtime port, and pushes account changes back.
 * Chrome attaches the true origin to the port; nothing the page says about itself is trusted.
 */
import { PAGE_CHANNEL, type DappRequest } from "~/shared/messages";

let port: chrome.runtime.Port | null = null;

function getPort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: "dapp" });
  port.onMessage.addListener((msg) => window.postMessage({ channel: PAGE_CHANNEL, dir: "to-page", msg }, window.location.origin));
  port.onDisconnect.addListener(() => { port = null; });
  return port;
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window || e.data?.channel !== PAGE_CHANNEL || e.data.dir !== "to-cs") return;
  const req = e.data.req as DappRequest;
  if (!req || typeof req.id !== "string" || typeof req.method !== "string") return;
  try { getPort().postMessage(req); }
  catch { port = null; try { getPort().postMessage(req); } catch (err) { window.postMessage({ channel: PAGE_CHANNEL, dir: "to-page", msg: { id: req.id, error: "Tailor was updated. Reload this page." } }, window.location.origin); } }
});

// Open a port eagerly so account-change events reach already-connected sites.
getPort();
