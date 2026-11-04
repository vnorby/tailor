import { useEffect, useState } from "react";
import { ShieldWarning, WarningOctagon } from "@phosphor-icons/react";

export interface DomainCheck { host?: string; verdict: "ok" | "suspicious" | "malicious"; reasons: string[]; trusted?: boolean }

/** Phishing check for the requesting site. "loading" until answered; null if the check itself failed. */
export function useDomainCheck(apiBase: string | undefined, origin: string | undefined): DomainCheck | null | "loading" {
  const [res, setRes] = useState<DomainCheck | null | "loading">("loading");
  useEffect(() => {
    if (!apiBase || !origin) return;
    let live = true;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000); // a slow check shouldn't block the request forever
    fetch(`${apiBase}/api/security/domain?origin=${encodeURIComponent(origin)}`, { signal: ac.signal })
      .then((r) => (r.ok ? (r.json() as Promise<DomainCheck>) : null))
      .then((j) => { if (live) setRes(j && (j.verdict === "ok" || j.verdict === "suspicious" || j.verdict === "malicious") ? j : null); })
      .catch(() => { if (live) setRes(null); })
      .finally(() => clearTimeout(timer));
    return () => { live = false; clearTimeout(timer); ac.abort(); };
  }, [apiBase, origin]);
  return res;
}

/** Full-window red stop page for known/likely phishing sites. */
export function MaliciousInterstitial({ host, reasons, onReject, onContinue }: { host: string; reasons: string[]; onReject(): void; onContinue(): void }) {
  const [ack, setAck] = useState(false);
  return (
    <main className="min-h-screen flex flex-col gap-4 p-5 bg-danger/15 border-4 border-danger/70">
      <div className="flex flex-col items-center text-center gap-2 pt-4">
        <WarningOctagon size={56} weight="fill" className="text-danger" />
        <h1 className="text-[20px] font-semibold text-danger">Dangerous site</h1>
        <p className="text-[14px] break-all"><span className="font-semibold">{host}</span> is likely a phishing or wallet-draining site.</p>
      </div>
      <ul className="rounded-lg bg-danger/12 text-danger px-3 py-2.5 text-[13px] flex flex-col gap-1.5 list-disc pl-6">
        {reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>
      <p className="text-[13px] text-chalk/85">Approving could let this site take everything in your wallet. If you got here from a DM, an ad, a &quot;claim&quot; link or a search result, close it.</p>
      <button className="btn btn-primary justify-center !py-3 text-[15px]" onClick={onReject}>Reject and close</button>
      <label className="mt-auto flex items-start gap-2 text-[12.5px] text-dim cursor-pointer select-none">
        <input type="checkbox" className="mt-0.5 accent-[var(--color-danger)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I understand the risk. I&apos;m sure this is the real site and I want to review the request anyway.</span>
      </label>
      <button className="btn btn-danger justify-center" disabled={!ack} onClick={onContinue}>Review request anyway</button>
    </main>
  );
}

/** Inline banner: red for an acknowledged malicious site, amber for suspicious, quiet note if unchecked. */
export function SiteBanner({ check }: { check: DomainCheck | null | "loading" }) {
  if (check === "loading") return <p className="text-[12px] text-faint">Checking this site…</p>;
  if (check === null) return <p className="text-[12px] text-faint">Couldn&apos;t check this site against phishing lists.</p>;
  if (check.verdict === "ok") return null;
  const bad = check.verdict === "malicious";
  return (
    <div className={`rounded-lg px-3 py-2 text-[13px] flex gap-2 ${bad ? "bg-danger/12 text-danger" : "bg-warn/12 text-warn"}`}>
      <ShieldWarning size={18} weight="fill" className="shrink-0 mt-0.5" />
      <div className="flex flex-col gap-1">
        <span className="font-semibold">{bad ? "Flagged as a dangerous site" : "This site looks suspicious"}</span>
        {check.reasons.map((r) => <span key={r}>{r}</span>)}
      </div>
    </div>
  );
}
