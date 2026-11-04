import { useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import { ArrowsLeftRight, Bank, CaretRight, Copy, CreditCard, Key, QrCode, Check } from "@phosphor-icons/react";
import { call } from "~/shared/messages";

type Panel = null | "exchange" | "card" | "bridge" | "request" | "import";

const BRIDGES = [
  { name: "Mayan", url: "https://swap.mayan.finance/" },
  { name: "deBridge", url: "https://app.debridge.finance/?outputChain=7565164" },
];

/** Ways to get money into an empty wallet, most common first. */
export function Funding({ address, apiBase, compact }: { address: string; apiBase: string; compact?: boolean }) {
  const [panel, setPanel] = useState<Panel>(null);
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { fetch(`${apiBase}/api/onramp`).then((r) => r.json()).then((j) => setProviders(j.providers ?? [])).catch(() => {}); }, [apiBase]);

  const options: { id: Panel; icon: ReactNode; title: string; sub: string; hidden?: boolean }[] = [
    { id: "exchange", icon: <Bank size={18} weight="fill" />, title: "From an exchange", sub: "Coinbase, Binance, Kraken…" },
    { id: "card", icon: <CreditCard size={18} weight="fill" />, title: "Buy with card", sub: providers.map((p) => p.name).join(", "), hidden: !providers.length },
    { id: "bridge", icon: <ArrowsLeftRight size={18} weight="bold" />, title: "From another chain", sub: "Ethereum, Base, Arbitrum, BTC…" },
    { id: "request", icon: <QrCode size={18} weight="fill" />, title: "Request from someone", sub: "Solana Pay link" },
    { id: "import", icon: <Key size={18} weight="fill" />, title: "Import a wallet", sub: "Private key" },
  ];

  if (panel) return (
    <div className="px-4 rise">
      <button className="mb-3 text-[12.5px] text-dim hover:text-chalk" onClick={() => setPanel(null)}>← All options</button>
      {panel === "exchange" && <Exchange address={address} />}
      {panel === "card" && <Card address={address} apiBase={apiBase} providers={providers} />}
      {panel === "bridge" && <Bridge address={address} />}
      {panel === "request" && <Request address={address} />}
      {panel === "import" && <Import />}
    </div>
  );

  return (
    <section className={`px-4 ${compact ? "mt-4" : "mt-6"} rise`}>
      <h2 className="font-serif text-[26px] leading-tight px-1">Add funds</h2>
      <p className="px-1 mt-1 text-[13px] text-dim">Your wallet is empty.</p>
      <ul className="mt-3 card overflow-hidden divide-y divide-line">
        {options.filter((o) => !o.hidden).map((o) => (
          <li key={o.id}>
            <button className="w-full flex items-center gap-3 px-3.5 py-3 text-left hover:bg-panel-2 transition-colors" onClick={() => setPanel(o.id)}>
              <span className="size-9 rounded-full bg-tape text-on-tape flex items-center justify-center shrink-0">{o.icon}</span>
              <span className="flex-1 min-w-0"><span className="block text-[14px] font-medium">{o.title}</span><span className="block text-[12px] text-dim truncate">{o.sub}</span></span>
              <CaretRight size={14} className="text-faint" />
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 px-1 text-[11.5px] text-faint">Your wallet sets itself up when funds land.</p>
    </section>
  );
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  return { copied, copy: (s: string) => { void navigator.clipboard.writeText(s); setCopied(true); setTimeout(() => setCopied(false), 2000); } };
}

function AddressBox({ address, qrValue }: { address: string; qrValue?: string }) {
  const [qr, setQr] = useState("");
  const { copied, copy } = useCopy();
  useEffect(() => { void QRCode.toDataURL(qrValue ?? address, { margin: 1, width: 200, color: { dark: "#000000", light: "#ffffff" } }).then(setQr); }, [address, qrValue]);
  return (
    <div className="card p-4 flex flex-col items-center gap-3">
      {qr && <img src={qr} alt="QR code" className="rounded-[calc(var(--t-radius)*.6)]" width={170} height={170} />}
      <p className="num text-[12px] text-center break-all text-dim">{address}</p>
      <button className="btn btn-primary w-full justify-center" onClick={() => copy(address)}>{copied ? <Check size={15} weight="bold" /> : <Copy size={15} weight="bold" />}{copied ? "Copied" : "Copy address"}</button>
    </div>
  );
}

function Exchange({ address }: { address: string }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[16px] font-medium">Withdraw from an exchange</h3>
      <ol className="text-[13px] text-chalk/85 flex flex-col gap-1.5 list-decimal pl-5">
        <li>On the exchange, tap Withdraw.</li>
        <li>Pick <b>SOL</b> or <b>USDC</b> on <b>Solana</b>.</li>
        <li>Paste this address.</li>
      </ol>
      <AddressBox address={address} />
      <p className="text-[11.5px] text-warn">Solana network only. Other networks can lose funds.</p>
    </div>
  );
}

function Card({ address, apiBase, providers }: { address: string; apiBase: string; providers: { id: string; name: string }[] }) {
  const [err, setErr] = useState<string | null>(null);
  const open = async (id: string) => {
    setErr(null);
    try { const r = await fetch(`${apiBase}/api/onramp?provider=${id}&address=${address}`); const j = await r.json(); if (!r.ok) throw new Error(j.error); await chrome.tabs.create({ url: j.url }); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[16px] font-medium">Buy with card</h3>
      <p className="text-[13px] text-dim">Your address is filled in for you.</p>
      {providers.map((p) => <button key={p.id} className="btn btn-primary justify-center !py-2.5" onClick={() => open(p.id)}>Continue with {p.name}</button>)}
      {err && <p className="text-[12.5px] text-danger">{err}</p>}
    </div>
  );
}

function Bridge({ address }: { address: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[16px] font-medium">Bridge from another chain</h3>
      <p className="text-[13px] text-dim">We copy your address. Pick Solana, paste it as recipient.</p>
      {BRIDGES.map((b) => (
        <button key={b.name} className="btn justify-between !py-2.5" onClick={() => { copy(address); void chrome.tabs.create({ url: b.url }); }}>
          <span>Open {b.name}</span><CaretRight size={14} />
        </button>
      ))}
      {copied && <p className="text-[12px] text-pos">Copied. Paste as recipient.</p>}
    </div>
  );
}

function Request({ address }: { address: string }) {
  const [amount, setAmount] = useState("");
  const { copied, copy } = useCopy();
  const n = Number(amount);
  const link = `solana:${address}${n > 0 ? `?amount=${n}` : ""}`;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[16px] font-medium">Request SOL</h3>
      <p className="text-[13px] text-dim">Any Solana wallet can scan or open this.</p>
      <label className="flex flex-col gap-1 text-[12px] text-dim">Amount (optional)
        <div className="relative"><input className="input num" inputMode="decimal" placeholder="0.5" value={amount} onChange={(e) => setAmount(e.target.value)} /><span className="absolute right-3 top-1/2 -translate-y-1/2 text-faint text-[12px]">SOL</span></div>
      </label>
      <AddressBox address={address} qrValue={link} />
      <button className="btn justify-center" onClick={() => copy(link)}>{copied ? "Link copied" : "Copy payment link"}</button>
    </div>
  );
}

function Import() {
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="flex flex-col gap-3" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try { await call({ type: "importKey", privateKey: key.trim() }); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); setBusy(false); }
    }}>
      <h3 className="text-[16px] font-medium">Import a wallet</h3>
      <p className="text-[13px] text-dim">Paste a private key from Phantom, Solflare or Backpack. Encrypted on this device.</p>
      <input className="input num !text-[12px]" type="password" placeholder="Private key (base58)" value={key} onChange={(e) => setKey(e.target.value)} />
      {err && <p className="text-[12.5px] text-danger">{err}</p>}
      <button className="btn btn-primary justify-center" disabled={!key.trim() || busy}>{busy ? "Importing…" : "Import"}</button>
    </form>
  );
}
