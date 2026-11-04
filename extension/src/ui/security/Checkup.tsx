import { useEffect, useState } from "react";
import { ArrowClockwise, CheckCircle, ShieldCheck, ShieldWarning } from "@phosphor-icons/react";
import type { AccountMeta, WalletState } from "~/shared/messages";
import type { ToolDef } from "@/lib/core/types";
import type { Checkup as CheckupResult, Finding } from "@/lib/security/checkup";
import { ActionProvider, useActions } from "@/components/ActionSheet";
import { extensionExecutor } from "../common";

const TONE: Record<Finding["severity"], string> = { high: "text-danger", medium: "text-warn", low: "text-dim", info: "text-faint" };

/** Security checkup for the active account: approvals, foreign close authorities, frozen accounts, spam. */
export function Checkup({ state, active }: { state: WalletState; active: AccountMeta }) {
  const [nonce, setNonce] = useState(0);
  return (
    <ActionProvider executor={extensionExecutor(state, active)} onDone={() => setNonce((n) => n + 1)}>
      <Panel apiBase={state.apiBase} owner={active.address} nonce={nonce} watch={active.kind === "watch"} />
    </ActionProvider>
  );
}

function Panel({ apiBase, owner, nonce, watch }: { apiBase: string; owner: string; nonce: number; watch: boolean }) {
  const { open } = useActions();
  const [res, setRes] = useState<CheckupResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`${apiBase}/api/security/checkup?owner=${owner}`)
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? `Checkup failed (${r.status})`); return j as CheckupResult; })
      .then((j) => { if (live) { setRes(j); setErr(null); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [apiBase, owner, nonce, reload]);
  const run = () => { setBusy(true); setReload((n) => n + 1); };
  useEffect(() => {
    fetch(`${apiBase}/api/tools`).then((r) => r.json()).then((j: { tools?: ToolDef[] }) => setTools(j.tools ?? [])).catch(() => {});
  }, [apiBase]);

  const fix = (toolId: string) => {
    const tool = tools.find((t) => t.id === toolId);
    if (tool) open({ kind: "tool", tool, params: {} });
  };
  // One "Revoke" per tool (the revoke tool clears every approval at once).
  const fixes = [...new Map((res?.findings ?? []).filter((f) => f.fix).map((f) => [f.fix!.toolId, f.fix!])).values()];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        {res ? (
          <span className={`flex items-center gap-1.5 font-medium ${res.score === "at-risk" ? "text-danger" : res.score === "attention" ? "text-warn" : "text-pos"}`}>
            {res.score === "good" ? <ShieldCheck size={16} weight="fill" /> : <ShieldWarning size={16} weight="fill" />}
            {res.score === "good" ? "No issues found" : res.score === "attention" ? "Needs attention" : "At risk"}
          </span>
        ) : <span className="text-dim">{busy ? "Checking…" : " "}</span>}
        <button className="btn !py-1 !px-2 text-[12px]" disabled={busy} onClick={run} aria-label="Re-run checkup"><ArrowClockwise size={13} weight="bold" className={busy ? "animate-spin" : ""} /></button>
      </div>
      {err && <p className="text-danger text-[12px]">{err}</p>}
      {res && res.findings.length === 0 && (
        <p className="flex items-center gap-1.5 text-dim text-[12px]"><CheckCircle size={14} weight="fill" className="text-pos" />No token approvals, foreign close authorities or frozen accounts across {res.tokenAccounts} token accounts.</p>
      )}
      {res?.findings.map((f) => (
        <div key={f.id} className="card p-2.5 flex flex-col gap-0.5">
          <div className={`text-[12.5px] font-medium ${TONE[f.severity]}`}>{f.title}</div>
          <div className="text-[12px] text-dim leading-snug">{f.detail}</div>
        </div>
      ))}
      {!watch && fixes.map((fx) => (
        <button key={fx.toolId} className={`btn justify-center ${fx.toolId === "revoke-approvals" ? "btn-danger" : ""}`} disabled={!tools.some((t) => t.id === fx.toolId)} onClick={() => fix(fx.toolId)}>
          {fx.toolId === "revoke-approvals" ? `Revoke ${res!.findings.filter((f) => f.fix?.toolId === fx.toolId).length > 1 ? "all approvals" : "approval"}` : fx.label}
        </button>
      ))}
      {res && res.recommendations.length > 0 && (
        <details className="text-[12px] text-dim">
          <summary className="cursor-pointer text-faint">Recommendations</summary>
          <ul className="list-disc pl-5 mt-1 flex flex-col gap-1">{res.recommendations.map((r) => <li key={r}>{r}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
