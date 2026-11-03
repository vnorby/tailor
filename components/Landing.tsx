"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { WalletPicker } from "./WalletPicker";

export function Landing() {
  const router = useRouter();
  const [addr, setAddr] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const go = (a: string) => {
    const s = a.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) { setErr("That doesn't look like a Solana address."); return; }
    router.push(`/w/${s}`);
  };
  return (
    <main className="mx-auto w-full max-w-[880px] px-4 sm:px-6 flex-1 flex flex-col justify-center py-16">
      <p className="text-[11px] uppercase tracking-[0.18em] text-dim">Tailor · generative wallet for Solana</p>
      <h1 className="font-serif text-[clamp(48px,9vw,104px)] leading-[0.95] mt-4">A wallet <em className="text-tape">cut to fit.</em></h1>
      <div className="tape mt-8 max-w-[560px]" />
      <p className="mt-6 max-w-[52ch] text-[17px] text-chalk/80 leading-relaxed">
        Paste an address. Tailor reads every position you hold across Kamino, Jupiter, Drift, marginfi, Phoenix, DFlow and staking, then cuts a dashboard around what you actually do and what needs you now. The buttons are real. Ask it to change anything.
      </p>
      <form className="mt-8 flex flex-col sm:flex-row gap-2 max-w-[640px]" onSubmit={(e) => { e.preventDefault(); go(addr); }}>
        <input className="input !py-3 !text-[15px] num" placeholder="Wallet address" value={addr} onChange={(e) => { setAddr(e.target.value); setErr(null); }} autoFocus />
        <button className="btn btn-primary !py-3 !px-5 justify-center">Take measurements</button>
      </form>
      {err && <p className="mt-2 text-[13px] text-danger">{err}</p>}
      <div className="mt-4 flex items-center gap-3 text-[13px] text-dim">
        <span>or</span>
        <WalletPicker compact onConnected={go} />
      </div>
    </main>
  );
}
