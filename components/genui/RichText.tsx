"use client";

import { useState } from "react";

// Base58 runs long enough to be an address (32–44) or a signature (87–88).
const ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g;

/** Text where any address or signature becomes a tap-to-copy chip that wraps instead of overflowing. */
export function RichText({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(ADDR)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<AddressChip key={m.index} value={m[0]} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export function AddressChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      className="num inline rounded-md bg-panel-2 px-1.5 py-0.5 text-[0.9em] text-left [overflow-wrap:anywhere] hover:bg-line transition-colors"
      onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1400); }}
    >
      {value}<span className="ml-1.5 text-[0.85em] text-faint">{copied ? "copied" : "copy"}</span>
    </button>
  );
}
