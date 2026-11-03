import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowsLeftRight, Check } from "@phosphor-icons/react";
import { call, type WalletState } from "~/shared/messages";
import { isValidMnemonic, newMnemonic } from "~/vault/derive";
import { mount } from "../common";
import { applyTheme, saveProfile, saveTheme, type Theme } from "../theme";

type Step = "intent" | "style" | "design" | "wallet" | "import" | "password" | "phrase" | "done";

const ACTIVITIES = [
  "Trade memecoins", "Perps & leverage", "Earn yield", "Borrow & lend", "Stake SOL", "Hold long-term",
  "NFTs & collectibles", "Send & pay people", "Prediction markets", "Farm airdrops",
];
const STYLES = ["Quiet & minimal", "Warm paper", "Neon night", "Terminal green", "Soft pastel", "Black & gold", "Bold brutalist", "Ocean calm"];

function Onboarding() {
  const [step, setStep] = useState<Step>("intent");
  const [picked, setPicked] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");
  const [style, setStyle] = useState("");
  const [theme, setTheme] = useState<Theme | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [designing, setDesigning] = useState(false);
  const [tweak, setTweak] = useState("");
  const [flow, setFlow] = useState<"create" | "import">("create");
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [mnemonic] = useState(() => newMnemonic(12));
  const [revealed, setRevealed] = useState(false);
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const apiBase = useRef("http://localhost:3210");
  const [hasWallet, setHasWallet] = useState(false);

  useEffect(() => { call<WalletState>({ type: "state" }).then((s) => { apiBase.current = s.apiBase; setHasWallet(s.initialized); }).catch(() => {}); }, []);

  // Someone who already has a wallet is only restyling: save the look and skip the keys.
  async function keepLook() {
    if (theme) await saveTheme(theme);
    await saveProfile({ activities, style });
    setStep("done");
  }

  const activities = [...picked, ...(freeText.trim() ? [freeText.trim()] : [])];

  async function design(adjust?: string) {
    setStep("design"); setDesigning(true); setNotes([]); setErr(null);
    try {
      const r = await fetch(`${apiBase.current}/api/theme`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ activities, style: adjust ?? style, current: adjust ? theme : null }),
      });
      if (!r.ok || !r.body) throw new Error("Couldn't reach Tailor's server.");
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "status") setNotes((n) => [...n, ev.text]);
          if (ev.type === "theme") { setTheme(ev.theme); applyTheme(ev.theme); }
          if (ev.type === "error") throw new Error(ev.error);
        }
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setDesigning(false); }
  }

  async function finish() {
    setBusy(true); setErr(null);
    try {
      if (flow === "create") await call({ type: "create", password: pw, mnemonic });
      else {
        const s = secret.trim();
        const isPhrase = s.split(/\s+/).length >= 12;
        if (isPhrase && !isValidMnemonic(s)) throw new Error("That recovery phrase isn't valid. Check the spelling and word order.");
        await call(isPhrase ? { type: "import", password: pw, mnemonic: s } : { type: "import", password: pw, privateKey: s });
      }
      if (theme) await saveTheme(theme);
      await saveProfile({ activities, style });
      setStep("done");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const pwOk = pw.length >= 8 && pw === pw2;
  const words = mnemonic.split(" ");

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12">
      <div className={`w-full ${step === "design" ? "max-w-[880px]" : "max-w-[520px]"} flex flex-col gap-6`}>
        <div className="flex items-center justify-between">
          <span className="font-serif text-[28px] leading-none">Tailor</span>
          <Dots step={step} />
        </div>

        {step === "intent" && (
          <>
            <h1 className="font-serif text-[44px] leading-[1.02]">What do you do with a wallet?</h1>
            <div className="flex flex-wrap gap-2">
              {ACTIVITIES.map((a) => {
                const on = picked.includes(a);
                return <button key={a} className={`btn !rounded-full !px-3.5 !py-2 ${on ? "btn-primary" : ""}`} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== a) : [...p, a]))}>{on && <Check size={13} weight="bold" />}{a}</button>;
              })}
            </div>
            <input className="input !py-3" placeholder="Or tell Tailor in your own words…" value={freeText} onChange={(e) => setFreeText(e.target.value)} />
            <button className="btn btn-primary justify-center !py-3" disabled={!activities.length} onClick={() => setStep("style")}>Continue</button>
          </>
        )}

        {step === "style" && (
          <>
            <h1 className="font-serif text-[44px] leading-[1.02]">How should it feel?</h1>
            <textarea className="input !py-3 h-24 resize-none" autoFocus placeholder="Describe a vibe — “a 1970s hi-fi”, “clean like a bank but warmer”, “pink and chaotic”…" value={style} onChange={(e) => setStyle(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              {STYLES.map((s) => <button key={s} className={`btn !rounded-full !px-3.5 !py-2 ${style === s ? "btn-primary" : ""}`} onClick={() => setStyle(s)}>{s}</button>)}
            </div>
            <button className="btn btn-primary justify-center !py-3" disabled={!style.trim()} onClick={() => design()}>Design my wallet</button>
            <button className="text-[13px] text-dim hover:text-chalk" onClick={() => setStep("intent")}>Back</button>
          </>
        )}

        {step === "design" && (
          <div className="grid gap-8 md:grid-cols-[1fr_340px] items-start">
            <div className="flex flex-col gap-5">
              <h1 className="font-serif text-[40px] leading-[1.02]">{designing ? "Designing your wallet…" : theme ? theme.name : "Hmm."}</h1>
              <ul className="flex flex-col gap-2 min-h-[120px]">
                {notes.map((n, i) => <li key={i} className={`text-[15px] rise ${i === notes.length - 1 && designing ? "caret" : "text-chalk/85"}`}><Typed text={n} /></li>)}
                {designing && !notes.length && <li className="text-[15px] text-dim caret">Reading your answers</li>}
              </ul>
              {theme && <Swatches t={theme} />}
              {err && <p className="text-[13px] text-danger">{err}</p>}
              {!designing && (
                <div className="flex flex-col gap-2">
                  <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (tweak.trim()) { const t = tweak; setTweak(""); void design(t); } }}>
                    <input className="input" placeholder="Change something — “warmer”, “less purple”, “rounder”…" value={tweak} onChange={(e) => setTweak(e.target.value)} />
                    <button className="btn" disabled={!tweak.trim()}>Redo</button>
                  </form>
                  <button className="btn btn-primary justify-center !py-3" disabled={!theme} onClick={() => (hasWallet ? void keepLook() : setStep("wallet"))}>Looks good</button>
                </div>
              )}
            </div>
            <Preview t={theme} working={designing} />
          </div>
        )}

        {step === "wallet" && (
          <>
            <h1 className="font-serif text-[44px] leading-[1.02]">Now, your keys.</h1>
            <p className="text-dim text-[15px]">Tailor is self-custodial: your keys are encrypted on this device and never leave it.</p>
            <button className="btn btn-primary justify-center !py-3" onClick={() => { setFlow("create"); setStep("password"); }}>Create a new wallet</button>
            <button className="btn justify-center !py-3" onClick={() => { setFlow("import"); setStep("import"); }}>Import an existing wallet</button>
          </>
        )}

        {step === "import" && (
          <>
            <h1 className="font-serif text-[36px] leading-[1.05]">Import your wallet</h1>
            <p className="text-dim text-[14px]">A 12 or 24-word recovery phrase, or a private key. Phantom, Solflare and Backpack phrases import to the same accounts.</p>
            <textarea className="input num !text-[13px] h-28 resize-none" placeholder="recovery phrase or private key" value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus spellCheck={false} />
            <button className="btn btn-primary justify-center" disabled={!secret.trim()} onClick={() => setStep("password")}>Continue</button>
            <button className="text-[13px] text-dim hover:text-chalk" onClick={() => setStep("wallet")}>Back</button>
          </>
        )}

        {step === "password" && (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (pwOk) { if (flow === "create") setStep("phrase"); else void finish(); } }}>
            <h1 className="font-serif text-[36px] leading-[1.05]">Set a password</h1>
            <p className="text-dim text-[14px]">It unlocks Tailor on this device. It can&apos;t recover your wallet; only your recovery phrase can.</p>
            <input className="input" type="password" autoFocus placeholder="Password (8+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} />
            <input className="input" type="password" placeholder="Confirm password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            {pw2 && pw !== pw2 && <p className="text-[13px] text-warn">Passwords don&apos;t match.</p>}
            {err && <p className="text-[13px] text-danger">{err}</p>}
            <button className="btn btn-primary justify-center" disabled={!pwOk || busy}>{busy ? "Encrypting…" : "Continue"}</button>
          </form>
        )}

        {step === "phrase" && (
          <>
            <h1 className="font-serif text-[36px] leading-[1.05]">Your recovery phrase</h1>
            <p className="text-dim text-[14px]">Write these 12 words down, in order, and keep them offline. Anyone with them controls your wallet. Tailor will never ask for them.</p>
            <div className="relative">
              <ol className={`grid grid-cols-3 gap-2 ${revealed ? "" : "blur-md select-none"}`}>
                {words.map((w, i) => <li key={i} className="card px-2.5 py-2 text-[14px] num"><span className="text-faint mr-1.5">{i + 1}</span>{w}</li>)}
              </ol>
              {!revealed && <button className="absolute inset-0 m-auto h-10 w-44 btn justify-center" onClick={() => setRevealed(true)}>Reveal phrase</button>}
            </div>
            <button className="btn justify-center" disabled={!revealed} onClick={() => navigator.clipboard.writeText(mnemonic)}>Copy to clipboard</button>
            {err && <p className="text-[13px] text-danger">{err}</p>}
            <button className="btn btn-primary justify-center" disabled={!revealed || busy} onClick={() => void finish()}>{busy ? "Creating…" : "I’ve saved it"}</button>
          </>
        )}

        {step === "done" && (
          <>
            <h1 className="font-serif text-[44px] leading-[1.02]">It&apos;s yours.</h1>
            <p className="text-chalk/80 text-[15px]">Pin Tailor to your toolbar (puzzle icon → pin). Open the side panel for the full wallet — it builds itself around what you hold, and you can ask it for anything.</p>
            <button className="btn btn-primary justify-center !py-3" onClick={async () => { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id! }); }}>Open my wallet</button>
          </>
        )}
      </div>
    </main>
  );
}

function Typed({ text }: { text: string }) {
  const [n, setN] = useState(0);
  useEffect(() => { setN(0); const id = setInterval(() => setN((x) => (x >= text.length ? (clearInterval(id), x) : x + 1)), 22); return () => clearInterval(id); }, [text]);
  return <>{text.slice(0, n)}</>;
}

function Dots({ step }: { step: Step }) {
  const order: Step[][] = [["intent"], ["style"], ["design"], ["wallet", "import", "password", "phrase"], ["done"]];
  const at = order.findIndex((g) => g.includes(step));
  return <div className="flex gap-1.5">{order.map((_, i) => <span key={i} className={`h-1.5 rounded-full transition-all ${i === at ? "w-5 bg-tape" : i < at ? "w-1.5 bg-tape/60" : "w-1.5 bg-line"}`} />)}</div>;
}

function Swatches({ t }: { t: Theme }) {
  const sw = [t.bg, t.surface, t.text, t.accent, t.pos, t.neg];
  return (
    <div className="flex items-center gap-2">
      {sw.map((c, i) => <span key={i} className="size-8 rounded-full border border-line rise" style={{ background: c, animationDelay: `${i * 70}ms` }} />)}
      <span className="ml-2 text-[12.5px] text-dim">{t.fontDisplay} · {t.fontSans} · {t.texture !== "none" ? t.texture : "flat"}</span>
    </div>
  );
}

/** A small live wallet that restyles the moment the theme arrives. */
function Preview({ t, working }: { t: Theme | null; working: boolean }) {
  return (
    <div className={`card overflow-hidden transition-opacity ${working && !t ? "opacity-60" : ""}`} style={{ borderRadius: "calc(var(--t-radius) + 8px)" }}>
      <div className="px-5 pt-6 pb-5 text-center">
        <div className="text-[12px] text-dim">Main account</div>
        <div className="font-serif text-[44px] leading-none mt-2">$12,480</div>
        <div className="mt-1.5 num text-[12px] text-pos">+$312.40 today</div>
      </div>
      <div className="flex justify-center gap-4 pb-5">
        {[[<ArrowUp key="u" size={17} weight="bold" />, "Send"], [<ArrowDown key="d" size={17} weight="bold" />, "Receive"], [<ArrowsLeftRight key="s" size={17} weight="bold" />, "Swap"]].map(([icon, label], i) => (
          <div key={i} className="flex flex-col items-center gap-1.5"><span className="size-11 rounded-full bg-tape text-on-tape flex items-center justify-center">{icon}</span><span className="text-[11px] text-dim">{label}</span></div>
        ))}
      </div>
      <div className="mx-3 mb-3 rounded-[calc(var(--t-radius)*.8)] bg-warn/14 text-warn px-3 py-2 text-[12.5px]">SOL loop is 14% from liquidation</div>
      <ul className="px-3 pb-4">
        {[["SOL", "48.20", "$7,104"], ["USDC", "3,210", "$3,210"], ["JUP", "2,400", "$2,166"]].map(([s, a, v]) => (
          <li key={s} className="flex items-center gap-3 px-2 py-2">
            <span className="size-8 rounded-full bg-panel-2" />
            <span className="flex-1"><span className="block text-[14px]">{s}</span><span className="block num text-[11px] text-dim">{a}</span></span>
            <span className="num text-[14px]">{v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

mount(<Onboarding />);
