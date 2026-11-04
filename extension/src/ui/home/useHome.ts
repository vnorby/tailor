import { useCallback, useEffect, useRef, useState } from "react";
import type { Prefs, Snapshot, ToolDef } from "@/lib/core/types";
import { sectionKey, type Home, type HomeEvent, type Intent, type Section } from "@/lib/genui/home";
import type { Card } from "@/lib/genui/spec";
import { applyTheme, loadProfile, loadTheme, saveTheme, type Theme } from "../theme";

const cacheKey = (owner: string) => `home:${owner}`;
interface Cached { snap: Snapshot; tools: ToolDef[]; home: Home; prefs: Prefs; at: number }
async function readCache(owner: string): Promise<Cached | null> {
  try { const r = await chrome.storage.local.get(cacheKey(owner)); return (r[cacheKey(owner)] as Cached | undefined) ?? null; } catch { return null; }
}
function writeCache(owner: string, c: Cached) { void chrome.storage.local.set({ [cacheKey(owner)]: c }).catch(() => {}); }

// Per-module engagement: how often it was on screen when the wallet opened, and how often it was tapped.
type UsageMap = Record<string, { opens: number; taps: number; lastTap?: number }>;
const usageKey = (owner: string) => `usage:${owner}`;
async function readUsage(owner: string): Promise<UsageMap> {
  try { return ((await chrome.storage.local.get(usageKey(owner)))[usageKey(owner)] as UsageMap | undefined) ?? {}; } catch { return {}; }
}
async function bumpUsage(owner: string, keys: string[], field: "opens" | "taps") {
  const u = await readUsage(owner);
  for (const k of keys) { const e = (u[k] ??= { opens: 0, taps: 0 }); e[field]++; if (field === "taps") e.lastTap = Date.now(); }
  await chrome.storage.local.set({ [usageKey(owner)]: u }).catch(() => {});
}
const usageList = (u: UsageMap) => Object.entries(u).map(([key, v]) => ({ key, opens: v.opens, taps: v.taps, daysSinceTap: v.lastTap ? Math.floor((Date.now() - v.lastTap) / 864e5) : null }));
const label = (s: Section) => sectionKey(s).split(":").slice(1).join(":") || s.kind;

const firstSentence = (t: string) => { const s = t.trim().split(/(?<=[.!?])\s/)[0]; return s.length > 120 ? `${s.slice(0, 117)}…` : s; };

export interface Note { text: string; source: "chain" | "ai"; at: number }
// steps: what the agent is doing, shown inside the answer so progress and result share one place.
// changed: home sections the request added or reworked, so the UI can point at them.
export interface Answer { prompt: string; text: string; cards: Card[]; steps: string[]; done: boolean; error?: string; changed?: number[]; restyled?: boolean }
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
  const counted = useRef(false);

  const run = useCallback(async (opts: { prompt?: string; reset?: boolean; fresh?: boolean } = {}) => {
    abort.current?.abort();
    const ac = new AbortController(); abort.current = ac;
    setWorking(true); setError(null); setReply(null); setNotes([]);
    // Whatever is on screen (cached or previous) stays until replacement content starts arriving.
    let replaced = false;
    let latestSnap: Snapshot | null = null, latestTools: ToolDef[] = [];
    const freshSections: Section[] = [];
    try {
      const [profile, theme, usage] = await Promise.all([loadProfile(), loadTheme(), readUsage(owner)]);
      const r = await fetch(`${apiBase}/api/home`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, prompt: opts.prompt, reset: opts.reset, fresh: opts.fresh, profile, theme, current: current.current, usage: usageList(usage) }), signal: ac.signal });
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
          const ev = JSON.parse(line) as HomeEvent | { type: "snapshot"; snapshot: Snapshot; tools: ToolDef[] } | { type: "done"; home: Home; prefs: Prefs; reply: string; cached?: boolean } | { type: "theme"; theme: Theme } | { type: "instant"; home: Home };
          switch (ev.type) {
            case "snapshot": setSnap(ev.snapshot); setTools(ev.tools); latestSnap = ev.snapshot; latestTools = ev.tools; break;
            // Code-built home, shown until Claude's personalized one arrives.
            case "instant": if (!current.current) { setSections(ev.home.sections); setActions(ev.home.actions); setAlert(ev.home.alert); setDetails(ev.home.details ?? {}); } break;
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
              if (latestSnap) writeCache(owner, { snap: latestSnap, tools: latestTools, home: ev.home, prefs: ev.prefs, at: Date.now() });
              // Count one "open" per module per home load, for the designer's keep-or-retire call.
              if (!counted.current) { counted.current = true; void bumpUsage(owner, ev.home.sections.map(sectionKey), "opens"); }
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
  const ask = useCallback(async (prompt: string, site?: string) => {
    abort.current?.abort();
    const ac = new AbortController(); abort.current = ac;
    setWorking(true); setError(null); setReply(null); setNotes([]);
    setAnswer({ prompt, text: "", cards: [], steps: [], done: false });
    let replaced = false; const freshSections: Section[] = [];
    const before = new Set((current.current?.sections ?? []).map((x) => JSON.stringify(x)));
    const kindsBefore = new Set((current.current?.sections ?? []).map((x) => x.kind));
    // New modules, not a re-titled tokens or positions list that was already there.
    const isNew = (x: Section) => !before.has(JSON.stringify(x)) && !((x.kind === "tokens" || x.kind === "positions") && kindsBefore.has(x.kind));
    try {
      const [profile, theme] = await Promise.all([loadProfile(), loadTheme()]);
      const r = await fetch(`${apiBase}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, prompt, profile, theme, current: current.current, site }), signal: ac.signal });
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
            case "status": setAnswer((a) => (a ? { ...a, steps: [...a.steps, ev.text] } : a)); break;
            case "narration": setAnswer((a) => (a && a.text.trim() ? { ...a, steps: [...a.steps, firstSentence(a.text)], text: "" } : a)); break;
            case "text": setAnswer((a) => (a ? { ...a, text: a.text + ev.delta } : a)); break;
            case "card": setAnswer((a) => (a ? { ...a, cards: [...a.cards, ev.card] } : a)); break;
            case "proposal": setProposal(ev.prep); break;
            case "theme": applyTheme(ev.theme); void saveTheme(ev.theme); setAnswer((a) => (a ? { ...a, restyled: true } : a)); break;
            case "home": {
              const h = ev.ev as HomeEvent;
              if (h.type === "section") {
                if (!replaced) { replaced = true; setAlert(undefined); }
                freshSections.push(h.section); setSections([...freshSections]);
                if (isNew(h.section)) { const i = freshSections.length - 1; setAnswer((a) => (a ? { ...a, changed: [...(a.changed ?? []), i] } : a)); }
              }
              else if (h.type === "alert") setAlert(h.alert);
              else if (h.type === "actions") setActions(h.actions);
              else if (h.type === "detail") setDetails((d) => ({ ...d, [h.positionId]: h.card }));
              else if (h.type === "done") {
                setSections(h.home.sections); setActions(h.home.actions); setAlert(h.home.alert); setDetails(h.home.details ?? {}); setPrefs(h.prefs); current.current = h.home;
                const changed = h.home.sections.flatMap((x, i) => (isNew(x) ? [i] : []));
                setAnswer((a) => (a ? { ...a, changed } : a));
              }
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

  // Open instantly from the last-known wallet, then refresh in the background.
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    // Swap straight from one account's cached home to the next: no blank frame in between.
    current.current = null; counted.current = false;
    void readCache(owner).then((c) => {
      if (!live) return;
      if (!c) { setSnap(null); setSections([]); setDetails({}); setCachedAt(null); setAnswer(null); }
      else {
        setAnswer(null);
        setSnap(c.snap); setTools(c.tools); setSections(c.home.sections); setActions(c.home.actions); setAlert(c.home.alert);
        setDetails(c.home.details ?? {}); setPrefs(c.prefs); current.current = c.home; setCachedAt(c.at);
      }
      void run();
    });
    return () => { live = false; abort.current?.abort(); };
  }, [run, owner]);

  /** Hand edits to the home: applied instantly, saved, and remembered as a standing instruction. */
  const editSections = useCallback((next: Section[], instruction?: string) => {
    const home: Home = { ...(current.current ?? { actions, details, generatedAt: Date.now() }), sections: next } as Home;
    current.current = home; setSections(next);
    void readCache(owner).then((c) => c && writeCache(owner, { ...c, home, at: Date.now() }));
    void fetch(`${apiBase}/api/home/layout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, sections: next, instruction }) })
      .then((r) => r.json()).then((j) => j.prefs && setPrefs(j.prefs)).catch(() => {});
  }, [apiBase, owner, actions, details]);
  const removeSection = useCallback((i: number) => {
    const s = sections[i]; if (!s) return;
    editSections(sections.filter((_, j) => j !== i), `Removed “${label(s)}”: don't add it back unless asked.`);
    return () => editSections(sections, `Show “${label(s)}” (restored by the user).`);
  }, [sections, editSections]);
  const moveTop = useCallback((i: number) => {
    const s = sections[i]; if (!s || i === 0) return;
    editSections([s, ...sections.filter((_, j) => j !== i)], `Keep “${label(s)}” at the top.`);
  }, [sections, editSections]);
  const pin = useCallback((card: Card) => {
    const s: Section = { kind: "card", card: { ...card, span: 4 } };
    editSections([...sections, s], `Pinned “${label(s)}” to the home: keep it.`);
    return sections.length;
  }, [sections, editSections]);
  const tap = useCallback((i: number) => { const s = sections[i]; if (s) void bumpUsage(owner, [sectionKey(s)], "taps"); }, [sections, owner]);

  return { removeSection, moveTop, pin, tap, cachedAt, snap, tools, alert, actions, sections, details, notes, prefs, reply, setReply, intent, clearIntent: () => setIntent(null), working, error, run, ask, answer, clearAnswer: () => setAnswer(null), proposal, clearProposal: () => setProposal(null) };
}
