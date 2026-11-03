import { useState } from "react";
import { call } from "~/shared/messages";
import { isValidMnemonic, newMnemonic } from "~/vault/derive";
import { Logo, mount } from "../common";

type Step = "welcome" | "password" | "phrase" | "import" | "done";

function Onboarding() {
  const [step, setStep] = useState<Step>("welcome");
  const [flow, setFlow] = useState<"create" | "import">("create");
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [mnemonic] = useState(() => newMnemonic(12));
  const [revealed, setRevealed] = useState(false);
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const words = mnemonic.split(" ");

  const pwOk = pw.length >= 8 && pw === pw2;

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
      setStep("done");
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-[460px] flex flex-col gap-5">
        <Logo size={48} />
        <div className="tape" />

        {step === "welcome" && (
          <>
            <h1 className="font-serif text-[40px] leading-[1.02]">A wallet <em className="text-tape">cut to fit.</em></h1>
            <p className="text-chalk/80 text-[15px] leading-relaxed">Tailor reads everything you hold across Solana DeFi and builds your wallet around what you actually do. Ask it for anything.</p>
            <div className="flex flex-col gap-2 mt-2">
              <button className="btn btn-primary justify-center !py-3" onClick={() => { setFlow("create"); setStep("password"); }}>Create a new wallet</button>
              <button className="btn justify-center !py-3" onClick={() => { setFlow("import"); setStep("import"); }}>I already have a wallet</button>
            </div>
          </>
        )}

        {step === "import" && (
          <>
            <h2 className="font-serif text-[30px]">Import your wallet</h2>
            <p className="text-dim text-[14px]">Paste your 12 or 24-word recovery phrase, or a private key. Phrases from Phantom, Solflare and Backpack import to the same accounts.</p>
            <textarea className="input num !text-[13px] h-28 resize-none" placeholder="recovery phrase or private key" value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus spellCheck={false} />
            <button className="btn btn-primary justify-center" disabled={!secret.trim()} onClick={() => setStep("password")}>Continue</button>
            <button className="text-[13px] text-dim hover:text-chalk" onClick={() => setStep("welcome")}>Back</button>
          </>
        )}

        {step === "password" && (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (pwOk) { if (flow === "create") setStep("phrase"); else void finish(); } }}>
            <h2 className="font-serif text-[30px]">Set a password</h2>
            <p className="text-dim text-[14px]">It unlocks Tailor on this device. It can&apos;t recover your wallet — only your recovery phrase can.</p>
            <input className="input" type="password" autoFocus placeholder="Password (8+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} />
            <input className="input" type="password" placeholder="Confirm password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            {pw2 && pw !== pw2 && <p className="text-[13px] text-warn">Passwords don&apos;t match.</p>}
            {err && <p className="text-[13px] text-danger">{err}</p>}
            <button className="btn btn-primary justify-center" disabled={!pwOk || busy}>{busy ? "Encrypting…" : "Continue"}</button>
          </form>
        )}

        {step === "phrase" && (
          <>
            <h2 className="font-serif text-[30px]">Your recovery phrase</h2>
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
            <h2 className="font-serif text-[34px]">You&apos;re all set.</h2>
            <p className="text-chalk/80 text-[15px]">Pin Tailor to your toolbar (the puzzle icon → pin). Click it for quick actions, or open the side panel for your full, generated wallet.</p>
            <button className="btn btn-primary justify-center" onClick={async () => { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id! }); }}>Open my wallet</button>
          </>
        )}
      </div>
    </main>
  );
}

mount(<Onboarding />);
