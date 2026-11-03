"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Layout, Prefs, Snapshot, ToolDef } from "@/lib/core/types";
import { WidgetView } from "@/components/widgets/Widgets";
import { ActionProvider } from "@/components/ActionSheet";
import { WalletPicker } from "@/components/WalletPicker";
import { useWallet } from "@/lib/ui/useWallet";
import { ago, short } from "@/lib/ui/format";
import { PROTOCOLS } from "@/lib/ui/protocols";

interface Data { snapshot: Snapshot; layout: Layout; prefs: Prefs; tools: ToolDef[]; reply?: string }

const SUGGESTIONS = ["Put my riskiest position first", "Hide anything under $20", "Add a swap box up top", "Make it minimal"];

export function Dashboard({ owner }: { owner: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [thinking, setThinking] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const { account } = useWallet();
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (fresh = false) => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/wallet?owner=${owner}${fresh ? "&fresh=1" : ""}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      setData(j);
      if (j.reply && fresh) setReply(j.reply);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [owner]);

  useEffect(() => { void load(); }, [load]);

  async function ask(text: string, reset = false) {
    if (!text.trim() && !reset) return;
    setThinking(true); setReply(null);
    try {
      const r = await fetch("/api/layout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, prompt: text, reset }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Failed");
      setData((d) => (d ? { ...d, layout: j.layout, prefs: j.prefs } : d));
      setReply(j.reply); setPrompt("");
    } catch (e) { setReply(e instanceof Error ? e.message : String(e)); }
    finally { setThinking(false); }
  }

  const viewOnly = account?.address !== owner;

  return (
    <ActionProvider owner={owner} onDone={() => load(true)}>
      <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 pb-40">
        <nav className="flex items-center justify-between py-4">
          <Link href="/" className="font-serif text-[26px] leading-none">Tailor</Link>
          <div className="flex items-center gap-2">
            <button className="btn" onClick={() => load(true)} disabled={loading}>{loading ? "Reading…" : "Refresh"}</button>
            <WalletPicker compact />
          </div>
        </nav>

        <header className="pt-6 pb-2">
          <p className="num text-[12px] text-dim">
            {short(owner)}{viewOnly && data ? " · view only — connect this wallet to act" : ""}
            {data && ` · read ${ago(data.snapshot.fetchedAt)}`}
          </p>
          <h1 className="font-serif text-[clamp(30px,4.6vw,52px)] leading-[1.05] mt-2 max-w-[22ch] text-balance">
            {data?.layout.headline ?? (error ? "Couldn't read this wallet." : "Taking measurements…")}
          </h1>
          <div className="tape mt-5" />
        </header>

        {error && <p className="mt-6 text-danger">{error}</p>}
        {!data && !error && <Skeleton />}

        {data && (
          <>
            {data.snapshot.errors.length > 0 && (
              <p className="mt-4 text-[12px] text-faint">Couldn&apos;t read: {data.snapshot.errors.map((e) => PROTOCOLS[e.protocol]?.name ?? e.protocol).join(", ")}. Those positions may be missing.</p>
            )}
            <main className={`mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 transition-opacity ${thinking ? "opacity-50" : ""}`}>
              {data.layout.widgets.map((w) => <WidgetView key={`${w.id}-${data.layout.generatedAt}`} w={w} snap={data.snapshot} tools={data.tools} />)}
            </main>
            {data.prefs.instructions.length > 0 && (
              <section className="mt-8 text-[12px] text-faint">
                <span className="uppercase tracking-[0.12em]">Fitted to:</span>{" "}
                {data.prefs.instructions.map((s, i) => <span key={i} className="inline-block mr-3">“{s}”</span>)}
                <button className="underline hover:text-chalk" onClick={() => ask("", true)}>reset</button>
              </section>
            )}
          </>
        )}
      </div>

      {/* prompt bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-cloth via-cloth/95 to-transparent pt-10 pb-4 px-4">
        <div className="mx-auto max-w-[720px]">
          {reply && <p className="mb-2 text-[13px] text-chalk/90 bg-panel border border-line rounded-xl px-3 py-2 rise">{reply}</p>}
          {!reply && data && !prompt && (
            <div className="mb-2 flex gap-1.5 overflow-x-auto no-scrollbar">
              {SUGGESTIONS.map((s) => <button key={s} className="btn !py-1 text-[12px] whitespace-nowrap text-dim" onClick={() => ask(s)} disabled={thinking}>{s}</button>)}
            </div>
          )}
          <form className="flex gap-2 card !rounded-2xl p-1.5 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]" onSubmit={(e) => { e.preventDefault(); void ask(prompt); }}>
            <input ref={inputRef} className="flex-1 bg-transparent px-3 text-[15px] outline-none placeholder:text-faint" placeholder={thinking ? "Re-cutting your layout…" : "Tell Tailor how to change this page…"} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={!data || thinking} />
            <button className="btn btn-primary" disabled={!data || thinking || !prompt.trim()}>{thinking ? "…" : "Alter"}</button>
          </form>
        </div>
      </div>
    </ActionProvider>
  );
}

function Skeleton() {
  return (
    <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {[2, 2, 1, 1, 2, 2].map((s, i) => <div key={i} className={`card h-44 animate-pulse ${s === 2 ? "md:col-span-2" : ""}`} />)}
    </div>
  );
}
