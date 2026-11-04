import { useCallback, useEffect, useRef, useState } from "react";
import type { Prefs, Snapshot, ToolDef } from "@/lib/core/types";
import type { Home, HomeEvent, Intent, Section } from "@/lib/genui/home";
import type { Card } from "@/lib/genui/spec";
import { applyTheme, loadProfile, loadTheme, saveTheme, type Theme } from "../theme";

export interface Note { text: string; source: "chain" | "ai"; at: number }

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

  useEffect(() => { setSnap(null); setSections([]); setDetails({}); void run(); return () => abort.current?.abort(); }, [run]);

  return { snap, tools, alert, actions, sections, details, notes, prefs, reply, setReply, intent, clearIntent: () => setIntent(null), working, error, run };
}
