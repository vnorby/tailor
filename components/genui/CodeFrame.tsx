"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useActions } from "@/components/ActionSheet";
import { globalFacts, positionFacts } from "@/lib/genui/facts";
import type { Snapshot, ToolDef } from "@/lib/core/types";
import { useGenData } from "./data";

/**
 * Model-written HTML in a sandboxed iframe: scripts run, but with an opaque origin
 * (no cookies, storage or parent DOM) and a CSP that blocks all network access.
 * Its only way out is postMessage, and the only messages honoured are "open the
 * trusted review sheet for this real action/tool" and "resize me".
 */
export function CodeFrame({ html, height = 320 }: { html: string; height?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const { snap, tools } = useGenData();
  const { open } = useActions();
  const [h, setH] = useState(height);

  const srcDoc = useMemo(() => buildDoc(html, snap), [html, snap]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const m = e.data as { type?: string; positionId?: string; actionId?: string; toolId?: string; params?: Record<string, unknown>; h?: number };
      const params = m.params && typeof m.params === "object" ? Object.fromEntries(Object.entries(m.params).map(([k, v]) => [k, String(v)])) : undefined;
      if (m.type === "tailor.height" && typeof m.h === "number") setH(Math.min(1200, Math.max(60, m.h)));
      if (m.type === "tailor.action") {
        const p = snap.positions.find((x) => x.id === m.positionId);
        const a = p?.actions.find((x) => x.id === m.actionId);
        if (p && a) open({ kind: "action", position: p, action: a, params });
      }
      if (m.type === "tailor.tool") {
        const t = tools.find((x: ToolDef) => x.id === m.toolId);
        if (t) open({ kind: "tool", tool: t, params: params ?? {} });
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [snap, tools, open]);

  return <iframe ref={ref} title="Custom view" sandbox="allow-scripts" srcDoc={srcDoc} className="w-full rounded-lg bg-transparent" style={{ height: h, border: 0, colorScheme: "dark" }} />;
}

function buildDoc(html: string, snap: Snapshot) {
  const data = {
    facts: globalFacts(snap),
    tokens: snap.tokens.map(({ mint, symbol, amount, priceUsd, valueUsd }) => ({ mint, symbol, amount, priceUsd, valueUsd })),
    positions: snap.positions.map((p) => ({
      id: p.id, protocol: p.protocol, kind: p.kind, title: p.title, subtitle: p.subtitle, valueUsd: p.valueUsd, pnlUsd: p.pnlUsd,
      legs: p.legs, metrics: p.metrics, risk: p.risk, facts: positionFacts(p), actions: p.actions.map((a) => ({ id: a.id, label: a.label })),
    })),
  };
  // JSON inside <script>: escape "<" so wallet strings can't close the tag.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>html,body{margin:0;background:transparent;color:#ece6d8;font:14px/1.4 ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}</style>
<script>window.TAILOR=${json};window.tailor={action:function(p,a,params){parent.postMessage({type:"tailor.action",positionId:p,actionId:a,params:params||{}},"*")},tool:function(t,params){parent.postMessage({type:"tailor.tool",toolId:t,params:params||{}},"*")}};
new ResizeObserver(function(){parent.postMessage({type:"tailor.height",h:document.documentElement.scrollHeight},"*")}).observe(document.documentElement);</script>
</head><body>${html}</body></html>`;
}
