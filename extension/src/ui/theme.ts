/**
 * Applies a generated theme to an extension page. Themes are chosen in onboarding
 * (and can be re-generated later), stored in chrome.storage.local — not secret — and
 * every page listens for changes so all surfaces restyle together.
 */
import type { Theme } from "@/lib/genui/theme";

export type { Theme };

const FAMILY: Record<string, string> = {
  "Inter Tight": '"Inter Tight Variable"', "Space Grotesk": '"Space Grotesk Variable"', "DM Sans": '"DM Sans Variable"',
  Manrope: '"Manrope Variable"', "IBM Plex Sans": '"IBM Plex Sans"', Sora: '"Sora Variable"',
  "Instrument Serif": '"Instrument Serif"', Fraunces: '"Fraunces Variable"', Syne: '"Syne Variable"',
  "JetBrains Mono": '"JetBrains Mono Variable"', "IBM Plex Mono": '"IBM Plex Mono"', "Space Mono": '"Space Mono"',
};

export function applyTheme(t: Theme | null | undefined, el: HTMLElement = document.documentElement) {
  if (!t) return;
  const v: Record<string, string> = {
    "--t-bg": t.bg, "--t-surface": t.surface, "--t-surface2": t.surface2, "--t-line": t.line,
    "--t-text": t.text, "--t-dim": t.dim, "--t-faint": t.faint, "--t-accent": t.accent, "--t-on-accent": t.onAccent,
    "--t-pos": t.pos, "--t-neg": t.neg, "--t-warn": t.warn, "--t-radius": `${t.radius}px`,
    "--t-font-sans": `${FAMILY[t.fontSans] ?? FAMILY["Inter Tight"]}, system-ui, sans-serif`,
    "--t-font-display": `${FAMILY[t.fontDisplay] ?? FAMILY["Instrument Serif"]}, Georgia, serif`,
    "--t-font-mono": `${FAMILY[t.fontMono] ?? FAMILY["JetBrains Mono"]}, ui-monospace, monospace`,
  };
  for (const [k, val] of Object.entries(v)) el.style.setProperty(k, val);
  el.dataset.texture = t.texture;
  el.dataset.density = t.density;
  el.dataset.mode = t.mode;
  // A synchronous copy so the next page load paints in the theme from its first frame.
  try { if (el === document.documentElement) localStorage.setItem("tailor-theme", JSON.stringify(t)); } catch { /* storage unavailable */ }
}

export async function loadTheme(): Promise<Theme | null> {
  const { theme } = await chrome.storage.local.get("theme");
  return (theme as Theme | undefined) ?? null;
}

export async function saveTheme(t: Theme) { await chrome.storage.local.set({ theme: t }); }

/** Apply the saved theme now and whenever it changes. */
export function watchTheme() {
  try { const cached = localStorage.getItem("tailor-theme"); if (cached) applyTheme(JSON.parse(cached) as Theme); } catch { /* no cached theme */ }
  void loadTheme().then((t) => applyTheme(t));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.theme) applyTheme(changes.theme.newValue as Theme);
  });
}

export interface Profile { activities: string[]; style?: string }
export async function loadProfile(): Promise<Profile | null> {
  const { profile } = await chrome.storage.local.get("profile");
  return (profile as Profile | undefined) ?? null;
}
export async function saveProfile(p: Profile) { await chrome.storage.local.set({ profile: p }); }
