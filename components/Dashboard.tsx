"use client";

import { useState } from "react";
import Link from "next/link";
import { GenCard, GenProvider } from "@/components/genui/Render";
import { ActionProvider, type Executor } from "@/components/ActionSheet";
import { usePage } from "@/components/genui/usePage";
import { WalletPicker } from "@/components/WalletPicker";
import { useWallet } from "@/lib/ui/useWallet";
import { ago, short } from "@/lib/ui/format";
import { PROTOCOLS } from "@/lib/ui/protocols";

const SUGGESTIONS = ["What should I do about my riskiest position?", "Hide anything under $20", "Show my yields side by side", "Draw my portfolio as something fun"];

export function Dashboard({ owner }: { owner: string }) {
  const { snap, tools, headline, cards, prefs, error, loading, generating, reply, load, ask } = usePage("", owner);
  const [prompt, setPrompt] = useState("");
  const { account, sign } = useWallet();
  const generate = async (text?: string, reset = false) => { await ask(text, reset); setPrompt(""); };
  const executor: Executor = {
    apiBase: "", owner, canSign: account?.address === owner,
    signHint: <><p className="text-[13px] text-dim">{account ? `Connected wallet ${short(account.address)} isn't ${short(owner)}. Switch accounts in your wallet to sign.` : `Connect ${short(owner)} to sign.`}</p><WalletPicker /></>,
    sign: async (txs) => { const out: string[] = []; for (const t of txs) out.push(await sign(t)); return out; },
  };

  const viewOnly = account?.address !== owner;

  return (
    <ActionProvider executor={executor} onDone={() => load(true)}>
      <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 pb-44">
        <nav className="flex items-center justify-between py-4">
          <Link href="/" className="font-serif text-[26px] leading-none">Tailor</Link>
          <div className="flex items-center gap-2">
            <button className="btn" onClick={() => load(true)} disabled={loading || generating}>{loading ? "Reading…" : "Refresh"}</button>
            <WalletPicker compact />
          </div>
        </nav>

        <header className="pt-6 pb-2">
          <p className="num text-[12px] text-dim">
            {short(owner)}{viewOnly && snap ? " · view only — connect this wallet to act" : ""}
            {snap && ` · read ${ago(snap.fetchedAt)}`}
          </p>
          <h1 className="font-serif text-[clamp(30px,4.6vw,52px)] leading-[1.05] mt-2 max-w-[24ch] text-balance min-h-[1.05em]">
            {headline ?? (error ? "Couldn't read this wallet." : snap ? "Cutting your page…" : "Taking measurements…")}
          </h1>
          <div className={`tape mt-5 ${generating ? "animate-pulse" : ""}`} />
        </header>

        {error && <p className="mt-6 text-danger">{error}</p>}

        {snap && (
          <GenProvider snap={snap} tools={tools}>
            {snap.errors.length > 0 && (
              <p className="mt-4 text-[12px] text-faint">Couldn&apos;t read: {snap.errors.map((e) => PROTOCOLS[e.protocol]?.name ?? e.protocol).join(", ")}. Those positions may be missing.</p>
            )}
            <main className={`mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4`}>
              {cards.map((c, i) => <GenCard key={i} card={c} />)}
              {generating && <div className="card h-40 md:col-span-2 animate-pulse flex items-center justify-center text-[13px] text-faint">Designing…</div>}
            </main>
            {prefs.instructions.length > 0 && !generating && (
              <section className="mt-8 text-[12px] text-faint">
                <span className="uppercase tracking-[0.12em]">Fitted to:</span>{" "}
                {prefs.instructions.map((s, i) => <span key={i} className="inline-block mr-3">“{s}”</span>)}
                <button className="underline hover:text-chalk" onClick={() => generate(undefined, true)}>reset</button>
              </section>
            )}
          </GenProvider>
        )}
        {!snap && !error && <Skeleton />}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-cloth via-cloth/95 to-transparent pt-10 pb-4 px-4">
        <div className="mx-auto max-w-[720px]">
          {reply && <p className="mb-2 text-[13px] text-chalk/90 bg-panel border border-line rounded-xl px-3 py-2 rise">{reply}</p>}
          {!reply && snap && !prompt && !generating && (
            <div className="mb-2 flex gap-1.5 overflow-x-auto no-scrollbar">
              {SUGGESTIONS.map((s) => <button key={s} className="btn !py-1 text-[12px] whitespace-nowrap text-dim" onClick={() => generate(s)}>{s}</button>)}
            </div>
          )}
          <form className="flex gap-2 card !rounded-2xl p-1.5 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]" onSubmit={(e) => { e.preventDefault(); if (prompt.trim()) void generate(prompt.trim()); }}>
            <input className="flex-1 bg-transparent px-3 text-[15px] outline-none placeholder:text-faint" placeholder={generating ? "Designing your page…" : "Ask for anything — a view, a change, an action…"} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={!snap || generating} />
            <button className="btn btn-primary" disabled={!snap || generating || !prompt.trim()}>{generating ? "…" : "Alter"}</button>
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
