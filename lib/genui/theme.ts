/**
 * Claude designs the wallet's look from the user's answers in onboarding.
 * Streamed as NDJSON: a few {"status"} lines narrating decisions as they're made,
 * then {"theme"}. Fonts come from a fixed bundled set; colors are contrast-checked
 * and repaired in code, so a theme can be bold but never unreadable.
 */
import Anthropic from "@anthropic-ai/sdk";
import { jsonObjects } from "./jsonstream";

export const FONTS = {
  sans: ["Inter Tight", "Space Grotesk", "DM Sans", "Manrope", "IBM Plex Sans", "Sora"],
  display: ["Instrument Serif", "Fraunces", "Syne", "Space Grotesk", "Inter Tight", "Sora"],
  mono: ["JetBrains Mono", "IBM Plex Mono", "Space Mono"],
} as const;

export interface Theme {
  name: string;
  mode: "dark" | "light";
  bg: string; surface: string; surface2: string; line: string;
  text: string; dim: string; faint: string;
  accent: string; onAccent: string;
  pos: string; neg: string; warn: string;
  radius: number;                       // px, 0–28
  fontSans: string; fontDisplay: string; fontMono: string;
  texture: "none" | "grain" | "weave" | "grid" | "dots";
  density: "compact" | "cozy";
}

export const DEFAULT_THEME: Theme = {
  name: "Tailor", mode: "dark",
  bg: "#141416", surface: "#1c1c1f", surface2: "#232327", line: "#2e2e33",
  text: "#ece6d8", dim: "#9a958a", faint: "#5f5c56",
  accent: "#e8c547", onAccent: "#1a1708", pos: "#7fd18b", neg: "#ff5a4e", warn: "#f0a33a",
  radius: 14, fontSans: "Inter Tight", fontDisplay: "Instrument Serif", fontMono: "JetBrains Mono",
  texture: "weave", density: "cozy",
};

export type ThemeEvent = { type: "status"; text: string } | { type: "theme"; theme: Theme } | { type: "error"; error: string };

// ---------- color math ----------

const hex = (s: unknown): string | null => (typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s.trim()) ? s.trim().toLowerCase() : null);
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lum = (h: string) => { const [r, g, b] = rgb(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const mix = (a: string, b: string, t: number) => "#" + rgb(a).map((c, i) => Math.round((c * (1 - t) + rgb(b)[i] * t) * 255).toString(16).padStart(2, "0")).join("");

/** Nudge `fg` toward black or white until it reaches `min` contrast on `bg`. */
function ensure(fg: string, bg: string, min: number): string {
  if (contrast(fg, bg) >= min) return fg;
  const target = lum(bg) > 0.4 ? "#000000" : "#ffffff";
  for (let t = 0.1; t <= 1.0001; t += 0.1) { const c = mix(fg, target, t); if (contrast(c, bg) >= min) return c; }
  return target;
}

export function sanitizeTheme(raw: Record<string, unknown>): Theme {
  const d = DEFAULT_THEME;
  const pick = <T extends string>(v: unknown, list: readonly T[], fb: T) => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fb);
  const bg = hex(raw.bg) ?? d.bg;
  const surface = hex(raw.surface) ?? mix(bg, lum(bg) > 0.4 ? "#000000" : "#ffffff", 0.04);
  const t: Theme = {
    name: typeof raw.name === "string" ? raw.name.slice(0, 40) : "Custom",
    mode: lum(bg) > 0.4 ? "light" : "dark",
    bg, surface,
    surface2: hex(raw.surface2) ?? mix(surface, lum(bg) > 0.4 ? "#000000" : "#ffffff", 0.05),
    line: hex(raw.line) ?? mix(surface, lum(bg) > 0.4 ? "#000000" : "#ffffff", 0.12),
    text: hex(raw.text) ?? d.text, dim: hex(raw.dim) ?? d.dim, faint: hex(raw.faint) ?? d.faint,
    accent: hex(raw.accent) ?? d.accent, onAccent: hex(raw.onAccent) ?? d.onAccent,
    pos: hex(raw.pos) ?? d.pos, neg: hex(raw.neg) ?? d.neg, warn: hex(raw.warn) ?? d.warn,
    radius: Math.max(0, Math.min(28, Math.round(Number(raw.radius) || d.radius))),
    fontSans: pick(raw.fontSans, FONTS.sans, d.fontSans as never),
    fontDisplay: pick(raw.fontDisplay, FONTS.display, d.fontDisplay as never),
    fontMono: pick(raw.fontMono, FONTS.mono, d.fontMono as never),
    texture: pick(raw.texture, ["none", "grain", "weave", "grid", "dots"] as const, "none"),
    density: raw.density === "compact" ? "compact" : "cozy",
  };
  // Readability is not negotiable: repair contrast against both surfaces.
  t.text = ensure(ensure(t.text, t.bg, 7), t.surface, 7);
  t.dim = ensure(ensure(t.dim, t.bg, 4.5), t.surface, 4.5);
  t.faint = ensure(t.faint, t.surface, 2.6);
  for (const k of ["pos", "neg", "warn"] as const) t[k] = ensure(t[k], t.surface, 3.5);
  t.accent = ensure(t.accent, t.bg, 3);
  t.onAccent = contrast("#000000", t.accent) >= contrast("#ffffff", t.accent) ? ensure(t.onAccent, t.accent, 4.5) : ensure(t.onAccent, t.accent, 4.5);
  return t;
}

const SYSTEM = `You are the visual designer of Tailor, a Solana wallet that each user styles to their taste. From what the user does with crypto and how they want it to feel, design the wallet's theme.

Output ONLY newline-delimited JSON, one object per line, no prose, no code fences:
- First, 3 to 5 lines of {"status": "<short note describing one aspect of the look, max 60 chars, concrete: colors, type, feel>"}, e.g. "Deep indigo ground with a neon magenta accent". They appear while the theme loads.
- Then one line {"theme": {...}} with exactly these keys:
  name (2–3 word name for the look), bg, surface (cards, one step off bg), surface2 (inputs/buttons, one more step), line (borders), text, dim (secondary text), faint (tertiary), accent (the one brand color: primary buttons, highlights), onAccent (text on accent), pos (gains), neg (losses/danger), warn — all #rrggbb;
  radius (0–28 px), fontSans (UI font, one of ${FONTS.sans.join(", ")}), fontDisplay (balance/headings, one of ${FONTS.display.join(", ")}), fontMono (numbers, one of ${FONTS.mono.join(", ")}), texture (none|grain|weave|grid|dots), density (compact|cozy).

Make it distinctive and true to the brief — a real, opinionated look, not generic dark mode — while staying a calm, legible financial app: one accent, quiet surfaces, readable text. Light themes are welcome when the brief suggests them.`;

export async function* generateTheme(input: { activities: string[]; style: string; current?: Theme | null }): AsyncGenerator<ThemeEvent> {
  if (!process.env.ANTHROPIC_API_KEY) { yield { type: "theme", theme: DEFAULT_THEME }; return; }
  const client = new Anthropic();
  const stream = client.beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: SYSTEM,
    messages: [{ role: "user", content: `What they do with a wallet: ${input.activities.join(", ") || "not specified"}\nHow it should feel: <style>${input.style.slice(0, 500) || "surprise me"}</style>${input.current ? `\nCurrent theme to adjust (keep what they didn't ask to change): ${JSON.stringify(input.current)}` : ""}` }],
  });
  const parser = jsonObjects();
  let gotTheme = false;
  const handle = (o: Record<string, unknown>): ThemeEvent | null => {
    if (typeof o.status === "string") return { type: "status", text: o.status.slice(0, 80) };
    if (o.theme && typeof o.theme === "object") { gotTheme = true; return { type: "theme", theme: sanitizeTheme(o.theme as Record<string, unknown>) }; }
    return null;
  };
  for await (const ev of stream) {
    if (ev.type !== "content_block_delta" || ev.delta.type !== "text_delta") continue;
    for (const o of parser.push(ev.delta.text)) { const e = handle(o as Record<string, unknown>); if (e) yield e; }
  }
  if (!gotTheme) yield { type: "theme", theme: DEFAULT_THEME };
}
