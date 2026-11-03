"use client";

import { useState } from "react";
import { useWallet } from "@/lib/ui/useWallet";
import { KNOWN_WALLETS } from "@/lib/ui/wallet";
import { short } from "@/lib/ui/format";

/** Connect button that expands into the installed Wallet Standard wallets. */
export function WalletPicker({ onConnected, compact }: { onConnected?(address: string): void; compact?: boolean }) {
  const { wallets, account, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (account) {
    return (
      <button className="btn" onClick={disconnect} title="Disconnect">
        <span className="size-1.5 rounded-full bg-pos" /> <span className="num">{short(account.address)}</span>
      </button>
    );
  }

  const missing = KNOWN_WALLETS.filter((k) => !wallets.some((w) => k.match.test(w.name)));
  return (
    <div className="relative">
      <button className={`btn ${compact ? "" : "btn-primary"}`} onClick={() => setOpen((o) => !o)}>Connect wallet</button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-60 card p-2 flex flex-col gap-1">
          {wallets.map((w) => (
            <button key={w.name} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-panel-2 text-left text-sm" onClick={async () => {
              setErr(null);
              try { const a = await connect(w); setOpen(false); onConnected?.(a); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
            }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={w.icon} alt="" className="size-5 rounded" /> {w.name}
            </button>
          ))}
          {missing.map((k) => <a key={k.name} className="rounded-lg px-2 py-2 text-sm text-faint hover:bg-panel-2" href={k.get} target="_blank" rel="noreferrer">Get {k.name} ↗</a>)}
          {err && <p className="px-2 text-[12px] text-danger">{err}</p>}
        </div>
      )}
    </div>
  );
}
