import { useState } from "react";
import type { AccountMeta, WalletState } from "~/shared/messages";
import { ActionProvider } from "@/components/ActionSheet";
import { GenCard, GenProvider } from "@/components/genui/Render";
import { usePage } from "@/components/genui/usePage";
import { PROTOCOLS } from "@/lib/ui/protocols";
import { ago } from "@/lib/ui/format";
import { AccountSwitcher, extensionExecutor, Logo, mount, Unlock, useWalletState } from "../common";

const SUGGESTIONS = ["What needs my attention?", "Clean up my wallet", "Show my yields side by side", "Send 0.1 SOL to…"];

function Panel() {
  const { state, active, refresh } = useWalletState();
  if (!state) return null;
  if (!state.initialized) return (
    <Center><Logo size={44} /><div className="tape w-full" /><button className="btn btn-primary" onClick={() => chrome.tabs.create({ url: "onboarding.html" })}>Set up Tailor</button></Center>
  );
  if (!state.unlocked) return <Center><Unlock onUnlocked={() => void refresh()} /></Center>;
  if (!active) return null;
  return <Wallet key={active.id} state={state} active={active} refresh={refresh} />;
}

function Wallet({ state, active, refresh }: { state: WalletState; active: AccountMeta; refresh(): Promise<void> }) {
  const page = usePage(state.apiBase, active.address);
  const [prompt, setPrompt] = useState("");
  const ask = async (t: string) => { setPrompt(""); await page.ask(t); };

  return (
    <ActionProvider executor={extensionExecutor(state, active)} onDone={() => void page.load(true)}>
      <div className="min-h-screen flex flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between px-3 py-2.5 bg-cloth/90 backdrop-blur border-b border-line/60">
          <AccountSwitcher state={state} active={active} onChanged={() => void refresh()} />
          <button className="btn !py-1.5" onClick={() => void page.load(true)} disabled={page.loading || page.generating}>{page.loading ? "Reading…" : "Refresh"}</button>
        </header>

        <div className="px-4 pb-40">
          <p className="pt-5 num text-[11.5px] text-dim">{active.kind === "watch" ? "Watch-only · " : ""}{page.snap ? `read ${ago(page.snap.fetchedAt)}` : "reading the chain…"}</p>
          <h1 className="font-serif text-[30px] leading-[1.06] mt-1.5 text-balance min-h-[1.06em]">
            {page.headline ?? (page.error ? "Couldn't read this wallet." : page.snap ? "Cutting your page…" : "Taking measurements…")}
          </h1>
          <div className={`tape mt-4 ${page.generating ? "animate-pulse" : ""}`} />
          {page.error && <p className="mt-4 text-danger text-[13px]">{page.error}</p>}

          {page.snap && (
            <GenProvider snap={page.snap} tools={page.tools}>
              {page.snap.errors.length > 0 && <p className="mt-3 text-[11.5px] text-faint">Couldn&apos;t read: {page.snap.errors.map((e) => PROTOCOLS[e.protocol]?.name ?? e.protocol).join(", ")}.</p>}
              <main className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                {page.cards.map((c, i) => <GenCard key={i} card={c} />)}
                {page.generating && <div className="card h-32 md:col-span-2 animate-pulse flex items-center justify-center text-[12.5px] text-faint">Designing…</div>}
              </main>
              {page.prefs.instructions.length > 0 && !page.generating && (
                <p className="mt-6 text-[11.5px] text-faint">Fitted to: {page.prefs.instructions.map((s, i) => <span key={i} className="mr-2">“{s}”</span>)}<button className="underline" onClick={() => void page.ask(undefined, true)}>reset</button></p>
              )}
            </GenProvider>
          )}
          {!page.snap && !page.error && <div className="mt-4 flex flex-col gap-3">{[0, 1, 2].map((i) => <div key={i} className="card h-36 animate-pulse" />)}</div>}
        </div>

        <div className="fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-cloth via-cloth/95 to-transparent pt-8 pb-3 px-3">
          {page.reply && <p className="mb-2 text-[12.5px] text-chalk/90 bg-panel border border-line rounded-xl px-3 py-2 rise">{page.reply}</p>}
          {!page.reply && page.snap && !prompt && !page.generating && (
            <div className="mb-2 flex gap-1.5 overflow-x-auto no-scrollbar">
              {SUGGESTIONS.map((s) => <button key={s} className="btn !py-1 text-[12px] whitespace-nowrap text-dim" onClick={() => (s.endsWith("…") ? setPrompt(s.slice(0, -1)) : void ask(s))}>{s}</button>)}
            </div>
          )}
          <form className="flex gap-2 card !rounded-2xl p-1.5 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)]" onSubmit={(e) => { e.preventDefault(); if (prompt.trim()) void ask(prompt.trim()); }}>
            <input className="flex-1 min-w-0 bg-transparent px-2.5 text-[14px] outline-none placeholder:text-faint" placeholder={page.generating ? "Working…" : "Ask for anything…"} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={!page.snap || page.generating} />
            <button className="btn btn-primary" disabled={!page.snap || page.generating || !prompt.trim()}>Go</button>
          </form>
        </div>
      </div>
    </ActionProvider>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-8">{children}</div>;
}

mount(<Panel />);
