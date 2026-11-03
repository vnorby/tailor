"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Prefs, Snapshot, ToolDef } from "@/lib/core/types";
import type { Card, Page } from "@/lib/genui/spec";

type Ev = { type: "headline"; headline: string } | { type: "card"; card: Card; index: number } | { type: "done"; page: Page; prefs: Prefs; reply: string } | { type: "error"; error: string };

/**
 * Wallet snapshot + generated page for one owner. Loads the cached page when the
 * wallet hasn't changed; otherwise streams a new one card by card. `ask` sends a
 * free-text request that regenerates the page with it applied.
 */
export function usePage(apiBase: string, owner: string | null) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [headline, setHeadline] = useState<string | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [prefs, setPrefs] = useState<Prefs>({ instructions: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const generate = useCallback(async (text?: string, reset = false) => {
    if (!owner) return;
    abort.current?.abort();
    const ac = new AbortController(); abort.current = ac;
    setGenerating(true); setReply(null);
    const fresh: Card[] = [];
    try {
      const r = await fetch(`${apiBase}/api/page`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, prompt: text, reset }), signal: ac.signal });
      if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as Ev;
          if (ev.type === "headline") setHeadline(ev.headline);
          if (ev.type === "card") { if (ev.index < 0) fresh.unshift(ev.card); else fresh.push(ev.card); setCards([...fresh]); }
          if (ev.type === "done") { setCards(ev.page.cards); setHeadline(ev.page.headline); setPrefs(ev.prefs); if (ev.reply) setReply(ev.reply); }
          if (ev.type === "error") throw new Error(ev.error);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setReply(e instanceof Error ? e.message : String(e));
    } finally { if (abort.current === ac) setGenerating(false); }
  }, [apiBase, owner]);

  const load = useCallback(async (fresh = false) => {
    if (!owner) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${apiBase}/api/wallet?owner=${owner}${fresh ? "&fresh=1" : ""}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
      setSnap(j.snapshot); setTools(j.tools); setPrefs(j.prefs);
      if (j.page) { setCards(j.page.cards); setHeadline(j.page.headline); }
      else { setCards([]); setHeadline(null); void generate(); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [apiBase, owner, generate]);

  useEffect(() => {
    setSnap(null); setCards([]); setHeadline(null); setReply(null);
    void load();
    return () => abort.current?.abort();
  }, [load]);

  return { snap, tools, headline, cards, prefs, error, loading, generating, reply, setReply, load, ask: generate };
}
