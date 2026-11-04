import { useEffect, useState } from "react";
import { call, type PendingRequest } from "~/shared/messages";
import { BalanceChanges, type Preview } from "@/components/BalanceChanges";
import { Globe } from "@phosphor-icons/react";
import { ledgerSignTxs } from "~/ledger/ledger";
import { Logo, mount, short, Unlock, useWalletState } from "../common";
import { MaliciousInterstitial, SiteBanner, useDomainCheck } from "../security/SiteCheck";

const VERB: Record<PendingRequest["method"], string> = {
  connect: "wants to connect",
  signTransaction: "wants you to sign a transaction",
  signAndSendTransaction: "wants you to sign and send a transaction",
  signMessage: "wants you to sign a message",
  signIn: "wants you to sign in",
};

function Approve() {
  const id = new URLSearchParams(location.search).get("id") ?? "";
  const { state, refresh } = useWalletState();
  const [req, setReq] = useState<PendingRequest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [previews, setPreviews] = useState<(Preview | null | "loading")[]>([]);
  const [busy, setBusy] = useState(false);
  const site = useDomainCheck(state?.apiBase, req?.origin);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => { call<PendingRequest>({ type: "getPending", id }).then(setReq).catch((e) => setErr(e.message)); }, [id]);

  // Plain-language read of the first transaction, on top of the deterministic preview.
  const [explain, setExplain] = useState<Explanation | null | "loading">(null);
  useEffect(() => {
    if (!req || !(req.method === "signTransaction" || req.method === "signAndSendTransaction") || !state?.apiBase || !req.payload[0]) return;
    setExplain("loading");
    fetch(`${state.apiBase}/api/security/explain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: req.payload[0], owner: req.account, origin: req.origin }) })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null).then((e) => setExplain(e));
  }, [req, state?.apiBase]);

  const isTx = req?.method === "signTransaction" || req?.method === "signAndSendTransaction";
  useEffect(() => {
    if (!req || !isTx || !state?.apiBase) return;
    setPreviews(req.payload.map(() => "loading"));
    req.payload.forEach((tx, i) => {
      fetch(`${state.apiBase}/api/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx, owner: req.account }) })
        .then((r) => (r.ok ? r.json() : r.json().then((j) => ({ ok: false, error: j.error ?? `Preview failed (${r.status})`, feeLamports: 0, changes: [], programs: [], warnings: [] }))))
        .catch(() => null)
        .then((p: Preview | null) => setPreviews((prev) => prev.map((x, j) => (j === i ? p : x))));
    });
  }, [req, isTx, state?.apiBase]);

  const [ledgerPrompt, setLedgerPrompt] = useState(false);
  const [ledgerErr, setLedgerErr] = useState<string | null>(null);
  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      // Ledger accounts sign here, on the device; the background verifies the signatures.
      const acct = state?.accounts.find((a) => a.address === req?.account);
      let signed: string[] | undefined;
      if (approve && acct?.kind === "ledger" && req && (req.method === "signTransaction" || req.method === "signAndSendTransaction")) {
        setLedgerPrompt(true);
        signed = await ledgerSignTxs(acct.address, acct.path!, req.payload);
      }
      await call({ type: "decide", id, approve, signed });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setLedgerPrompt(false); setBusy(false);
      if (/ledger|device|blind/i.test(m)) setLedgerErr(m); else setErr(m);
      return;
    }
    window.close();
  };

  if (err) return <Shell><p className="text-danger text-[14px]">{err}</p><button className="btn justify-center" onClick={() => window.close()}>Close</button></Shell>;
  if (!req || !state) return <Shell><p className="text-dim text-[14px]">Loading…</p></Shell>;

  const host = (() => { try { return new URL(req.origin).host; } catch { return req.origin; } })();
  const malicious = site !== "loading" && site?.verdict === "malicious";
  if (malicious && !acknowledged) return <MaliciousInterstitial host={host} reasons={site.reasons} onReject={() => void decide(false)} onContinue={() => setAcknowledged(true)} />;
  const risky = (site !== "loading" && site !== null && site.verdict !== "ok") || req.warnings.length > 0 || previews.some((p) => p && p !== "loading" && (!p.ok || p.warnings.length > 0)) || (isTx && previews.some((p) => p === null));

  return (
    <Shell>
      <div className="flex items-center gap-3">
        {/* No favicon: fetching it remotely would leak which sites you use, and a made-up mark would mislead. */}
        <Globe size={28} weight="fill" className="text-dim shrink-0" />
        <div className="min-w-0">
          <div className="text-[16px] font-semibold truncate">{host}</div>
          <div className="text-[13px] text-dim">{VERB[req.method]}</div>
        </div>
      </div>
      {req.account && <div className="text-[12px] text-faint">Account <span className="num text-dim">{short(req.account)}</span></div>}

      <SiteBanner check={site} />
      {req.warnings.map((w) => <p key={w} className="rounded-lg bg-danger/12 text-danger px-3 py-2 text-[13px]">⚠ {w}</p>)}

      {!state.unlocked ? (
        <div className="flex flex-col gap-2"><p className="text-[13px] text-dim">Unlock Tailor to review this request.</p><Unlock compact onUnlocked={() => void refresh()} /></div>
      ) : (
        <>
          {req.method === "connect" && (
            <ul className="card p-3 text-[13px] text-chalk/85 flex flex-col gap-1.5">
              <li>✓ See your wallet address and balances</li>
              <li>✓ Ask you to approve transactions</li>
              <li className="text-faint">✗ It can&apos;t move funds without your approval</li>
            </ul>
          )}
          {isTx && explain && <ExplainCard e={explain} />}
          {isTx && previews.map((p, i) => (
            <div key={i} className="flex flex-col gap-1">
              {req.payload.length > 1 && <div className="text-[11px] text-faint">Transaction {i + 1} of {req.payload.length}</div>}
              {p === "loading" ? <div className="card h-24 animate-pulse" /> : p ? <BalanceChanges preview={p} /> : <p className="rounded-lg bg-warn/12 text-warn px-3 py-2 text-[13px]">Couldn&apos;t simulate this transaction. Only approve if you trust {host}.</p>}
            </div>
          ))}
          {(req.method === "signMessage" || req.method === "signIn") && (
            <pre className="card p-3 text-[12.5px] whitespace-pre-wrap break-words max-h-64 overflow-auto num">{req.messageText ?? `(binary data, ${atob(req.payload[0] ?? "").length} bytes)`}</pre>
          )}
          {ledgerPrompt && <p className="rounded-lg bg-panel-2 px-3 py-2 text-[13px]">Confirm on your Ledger. Check that the details on its screen match.</p>}
          {ledgerErr && <p className="rounded-lg bg-warn/12 text-warn px-3 py-2 text-[13px]">{ledgerErr}</p>}
          <div className="mt-auto grid grid-cols-2 gap-2 pt-2">
            <button className="btn justify-center !py-2.5" disabled={busy} onClick={() => decide(false)}>Reject</button>
            <button className={`btn justify-center !py-2.5 ${risky ? "btn-danger" : "btn-primary"}`} disabled={busy || site === "loading" || (malicious && !acknowledged) || previews.some((p) => p === "loading")} onClick={() => decide(true)}>
              {busy ? "…" : req.method === "connect" ? "Connect" : risky ? "Approve anyway" : "Approve"}
            </button>
          </div>
        </>
      )}
    </Shell>
  );
}

interface Explanation { summary: string; risk: "low" | "medium" | "high"; points: string[]; advice: string }

function ExplainCard({ e }: { e: Explanation | "loading" }) {
  if (e === "loading") return <div className="card p-3 text-[13px] text-dim caret">Reading this transaction</div>;
  const tone = e.risk === "high" ? "bg-danger/14 text-danger" : e.risk === "medium" ? "bg-warn/14 text-warn" : "bg-pos/14 text-pos";
  return (
    <section className="card p-3.5 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${tone}`}>{e.risk} risk</span>
        <span className="text-[10.5px] text-faint">Tailor&apos;s read · AI, from the simulation</span>
      </div>
      <p className="text-[14px] leading-snug">{e.summary}</p>
      {e.points.length > 0 && <ul className="flex flex-col gap-1 text-[12.5px] text-chalk/85 list-disc pl-4">{e.points.map((x, i) => <li key={i}>{x}</li>)}</ul>}
      <p className="text-[12.5px] text-dim">{e.advice}</p>
    </section>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="min-h-screen flex flex-col gap-4 p-5"><div className="flex items-center justify-between"><Logo /><span className="text-[11px] text-faint">Request</span></div><div className="tape" />{children}</main>;
}

mount(<Approve />);
