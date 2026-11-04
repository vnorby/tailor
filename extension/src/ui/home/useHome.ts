import { useCallback, useEffect, useRef, useState } from "react";
import type { Prefs, Snapshot, ToolDef } from "@/lib/core/types";
import type { Home, HomeEvent, Intent, Section } from "@/lib/genui/home";
import type { Card } from "@/lib/genui/spec";
import { applyTheme, loadProfile, loadTheme, saveTheme, type Theme } from "../theme";

export interface Note { text: string; source: "chain" | "ai"; at: number }
export interface Answer { prompt: string; text: string; cards: Card[]; done: boolean; error?: string }
export interface Proposal { txs: string[]; summary: string; warnings?: string[]; simulations: { ok: boolean; error?: string }[] }

/**
 * Streams the wallet home for one account. Everything the server decides arrives as
 * it's decided — chain reads, notes, alert, actions, sections, detail cards — so the
 * UI can show the wallet assembling itself.
 */
export function useHome(apiBase: string, owner: string) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [alert, setAlert] = useState<Home["alert"]>();
  const [actions, setActions] = useState<string[]>(["send", "receive", "swap"]);
  const [sections, setSections] = useState<Section[]>([]);
  const [details, setDetails] = useState<Record<string, Card>>({});
  const [notes, setNotes] = useState<Note[]>([]);
  const [prefs, setPrefs] = useState<Prefs>({ instructions: [] });
  const [reply, setReply] = useState<string | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // The layout on screen, sent with requests so a look-only change keeps it even if the server forgot it.
  const current = useRef<Home | null>(null);

  const run = useCallback(async (opts: { prompt?: string; reset?: boolean; fresh?: boolean } = {}) => {
    abort.current?.abort();
    const ac = new AbortController(); abort.current = ac;
    setWorking(true); setError(null); setReply(null); setNotes([]);
    const isEdit = !!opts.prompt || !!opts.reset;
    // A fresh build replaces the page as it streams; an edit keeps the old page until the new one starts arriving.
    let replaced = !isEdit;
    if (!isEdit) { setSections([]); setAlert(undefined); }
    const freshSections: Section[] = [];
    try {
      const [profile, theme] = await Promise.all([loadProfile(), loadTheme()]);
      const r = await fetch(`${apiBase}/api/home`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, prompt: opts.prompt, reset: opts.reset, fresh: opts.fresh, profile, theme, current: current.current }), signal: ac.signal });
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
          const ev = JSON.parse(line) as HomeEvent | { type: "snapshot"; snapshot: Snapshot; tools: ToolDef[] } | { type: "done"; home: Home; prefs: Prefs; reply: string; cached?: boolean } | { type: "theme"; theme: Theme };
          switch (ev.type) {
            case "snapshot": setSnap(ev.snapshot); setTools(ev.tools); break;
            case "status": setNotes((n) => [...n, { text: ev.text, source: ev.source, at: Date.now() }]); break;
            case "alert": setAlert(ev.alert); break;
            case "actions": setActions(ev.actions); break;
            case "section":
              if (!replaced) { replaced = true; setAlert(undefined); }
              freshSections.push(ev.section); setSections([...freshSections]); break;
            case "detail": setDetails((d) => ({ ...d, [ev.positionId]: ev.card })); break;
            case "intent": setIntent(ev.intent); break;
            // A new look: apply here immediately and save so every Tailor surface restyles.
            case "theme": applyTheme(ev.theme); void saveTheme(ev.theme); break;
            case "done":
              setSections(ev.home.sections); setActions(ev.home.actions); setAlert(ev.home.alert); setDetails(ev.home.details ?? {});
              current.current = ev.home;
              setPrefs(ev.prefs); if (ev.reply) setReply(ev.reply);
              break;
            case "error": throw new Error(ev.error);
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
    } finally { if (abort.current === ac) setWorking(false); }
  }, [apiBase, owner]);

  /** Ask the agent anything. It may answer, draw cards, propose a transaction, rework the home or restyle. */
  const ask = useCallback(async (prompt: string) => {
    abort.current?.abort();
    const ac = new AbortController(); abort.current = ac;
    setWorking(true); setError(null); setReply(null); setNotes([]);
    setAnswer({ prompt, text: "", cards: [], done: false });
    let replaced = false; const freshSections: Section[] = [];
    try {
      const [profile, theme] = await Promise.all([loadProfile(), loadTheme()]);
      const r = await fetch(`${apiBase}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, prompt, profile, theme, current: current.current }), signal: ac.signal });
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
          const ev = JSON.parse(line);
          switch (ev.type) {
            case "status": setNotes((n) => [...n, { text: ev.text, source: "ai", at: Date.now() }]); break;
            case "text": setAnswer((a) => (a ? { ...a, text: a.text + ev.delta } : a)); break;
            case "card": setAnswer((a) => (a ? { ...a, cards: [...a.cards, ev.card] } : a)); break;
            case "proposal": setProposal(ev.prep); break;
            case "theme": applyTheme(ev.theme); void saveTheme(ev.theme); break;
            case "home": {
              const h = ev.ev as HomeEvent;
              if (h.type === "section") { if (!replaced) { replaced = true; setAlert(undefined); } freshSections.push(h.section); setSections([...freshSections]); }
              else if (h.type === "alert") setAlert(h.alert);
              else if (h.type === "actions") setActions(h.actions);
              else if (h.type === "detail") setDetails((d) => ({ ...d, [h.positionId]: h.card }));
              else if (h.type === "done") { setSections(h.home.sections); setActions(h.home.actions); setAlert(h.home.alert); setDetails(h.home.details ?? {}); setPrefs(h.prefs); current.current = h.home; }
              break;
            }
            case "done": setAnswer((a) => (a ? { ...a, text: ev.reply || a.text, done: true } : a)); break;
            case "error": throw new Error(ev.error);
          }
        }
      }
      setAnswer((a) => (a ? { ...a, done: true } : a));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setAnswer((a) => (a ? { ...a, done: true, error: e instanceof Error ? e.message : String(e) } : a));
    } finally { if (abort.current === ac) setWorking(false); }
  }, [apiBase, owner]);

  useEffect(() => { setSnap(null); setSections([]); setDetails({}); void run(); return () => abort.current?.abort(); }, [run]);

  return { snap, tools, alert, actions, sections, details, notes, prefs, reply, setReply, intent, clearIntent: () => setIntent(null), working, error, run, ask, answer, clearAnswer: () => setAnswer(null), proposal, clearProposal: () => setProposal(null) };
}
