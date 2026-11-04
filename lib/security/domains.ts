/**
 * Phishing / malicious-site detection for dApp requests.
 *
 * Two layers:
 *  1. Phantom's open blocklist (github.com/phantom/blocklist), fetched server-side and
 *     cached. If GitHub is unreachable we keep the last good copy (or run without it).
 *  2. Heuristics: punycode/IDN homographs, lookalikes of popular Solana apps and
 *     wallets (confusable-character skeletons + edit distance), brand names embedded in
 *     unrelated domains, wallet-bait keywords ("claim", "airdrop"…) and abused TLDs.
 *
 * Pure string analysis apart from the blocklist fetch; never throws for bad input.
 */
import { domainToUnicode } from "node:url";

export type DomainVerdict = "ok" | "suspicious" | "malicious";

export interface DomainCheck {
  host: string;
  verdict: DomainVerdict;
  reasons: string[];
  /** True when the host is (a subdomain of) a well-known Solana app or wallet. */
  trusted?: boolean;
  blocklist: "ok" | "stale" | "unavailable";
}

// ---------- known-good Solana apps / wallets ----------

/** Official registrable domains. A host equal to one of these, or a subdomain of one, is trusted. */
export const OFFICIAL_DOMAINS: Record<string, string> = {
  "jup.ag": "Jupiter", "jupiter.ag": "Jupiter",
  "phantom.com": "Phantom", "phantom.app": "Phantom",
  "raydium.io": "Raydium", "orca.so": "Orca", "kamino.finance": "Kamino", "kamino.com": "Kamino",
  "marginfi.com": "marginfi", "drift.trade": "Drift", "tensor.trade": "Tensor",
  "magiceden.io": "Magic Eden", "magiceden.us": "Magic Eden", "pump.fun": "pump.fun",
  "solana.com": "Solana", "solana.org": "Solana", "solflare.com": "Solflare",
  "backpack.app": "Backpack", "backpack.exchange": "Backpack", "meteora.ag": "Meteora",
  "sanctum.so": "Sanctum", "jito.network": "Jito", "jito.wtf": "Jito",
  "marinade.finance": "Marinade", "solscan.io": "Solscan", "solana.fm": "SolanaFM",
  "birdeye.so": "Birdeye", "dexscreener.com": "DEX Screener", "phoenix.trade": "Phoenix",
  "zeta.markets": "Zeta", "squads.so": "Squads", "squads.xyz": "Squads", "realms.today": "Realms",
  "step.finance": "Step", "sns.id": "SNS", "tiplink.io": "TipLink", "save.finance": "Save",
  "solend.fi": "Solend", "lulo.fi": "Lulo", "exponent.finance": "Exponent", "parcl.co": "Parcl",
  "helius.dev": "Helius", "helius.xyz": "Helius", "dialect.to": "Dialect", "bonkbot.io": "BONKbot",
  "photon-sol.tinyastro.io": "Photon", "titan.exchange": "Titan", "dflow.net": "DFlow",
  "flash.trade": "Flash", "metaplex.com": "Metaplex", "coinbase.com": "Coinbase",
};

/** Brand words people impersonate, with the canonical spelling used for lookalike checks. */
const GENERIC_BRANDS = new Set(["solana", "jupiter", "drift", "orca", "squads"]);
const BRANDS: { word: string; name: string; domains: string[]; generic: boolean }[] = (() => {
  const words: [string, string][] = [
    ["jupiter", "Jupiter"], ["jup", "Jupiter"], ["phantom", "Phantom"], ["raydium", "Raydium"], ["orca", "Orca"],
    ["kamino", "Kamino"], ["marginfi", "marginfi"], ["drift", "Drift"], ["tensor", "Tensor"],
    ["magiceden", "Magic Eden"], ["pumpfun", "pump.fun"], ["solana", "Solana"], ["solflare", "Solflare"],
    ["backpack", "Backpack"], ["meteora", "Meteora"], ["sanctum", "Sanctum"], ["jito", "Jito"],
    ["marinade", "Marinade"], ["solscan", "Solscan"], ["birdeye", "Birdeye"], ["dexscreener", "DEX Screener"],
    ["squads", "Squads"], ["tiplink", "TipLink"], ["metaplex", "Metaplex"], ["bonkbot", "BONKbot"],
  ];
  return words.map(([word, name]) => ({ word, name, domains: Object.entries(OFFICIAL_DOMAINS).filter(([, n]) => n === name).map(([d]) => d), generic: GENERIC_BRANDS.has(word) }));
})();

/** Official domains written as a single label, e.g. "jup-ag", "pumpfun", "raydium-io". */
const COLLAPSED_OFFICIAL = new Map<string, string>(
  Object.entries(OFFICIAL_DOMAINS).flatMap(([d, n]) => [[d.replace(/\./g, ""), n], [d.replace(/\./g, "-"), n]] as [string, string][]),
);

const BAIT_WORDS = [
  "claim", "claims", "airdrop", "airdrops", "drop", "drops", "giveaway", "reward", "rewards", "bonus", "free",
  "promo", "presale", "whitelist", "eligible", "eligibility", "allocation", "verify", "verification", "validate",
  "sync", "rectify", "restore", "recover", "recovery", "migrate", "migration", "unlock", "refund", "connect",
  "walletconnect", "dapps", "fix", "support", "secure", "auth", "login", "redeem", "snapshot", "event", "gift",
];
const BAIT_SUBSTRINGS = ["airdrop", "claim", "giveaway", "reward", "walletconnect", "eligib", "allocation", "presale"];

const SUSPICIOUS_TLDS = new Set([
  "xyz", "top", "click", "site", "online", "live", "icu", "buzz", "monster", "rest", "cyou", "sbs", "cfd", "quest",
  "lol", "shop", "store", "support", "gq", "tk", "ml", "cf", "ga", "zip", "mov", "cc", "pw", "ws", "best", "bond",
  "life", "link", "work", "fun", "info", "pro", "vip", "win", "loan", "claims", "gift",
  "digital", "events", "space", "website",
]);

const MULTI_PART_SUFFIXES = new Set(["co.uk", "com.au", "co.jp", "com.br", "co.in", "com.cn", "co.kr", "com.mx", "co.za", "web.app", "vercel.app", "netlify.app", "pages.dev", "github.io", "firebaseapp.com", "herokuapp.com", "glitch.me", "replit.app", "onrender.com", "workers.dev"]);
/** Free hosting where anyone can publish under a subdomain: a brand in the subdomain is a red flag. */
const FREE_HOSTS = new Set(["web.app", "vercel.app", "netlify.app", "pages.dev", "github.io", "firebaseapp.com", "herokuapp.com", "glitch.me", "replit.app", "onrender.com", "workers.dev"]);

// ---------- confusables ----------

/** Unicode characters that render like Latin letters (Cyrillic, Greek, Armenian, IPA, fullwidth…). */
const CONFUSABLE: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d",
  "ɡ": "g", "һ": "h", "к": "k", "м": "m", "н": "h", "т": "t", "в": "b", "ԛ": "q", "ԝ": "w", "ӏ": "l", "ɩ": "i",
  "ո": "n", "ս": "u", "օ": "o", "ց": "g", "հ": "h", "ա": "w", "ј́": "j",
  "α": "a", "ο": "o", "ν": "v", "ρ": "p", "τ": "t", "κ": "k", "ι": "i", "υ": "u", "ε": "e", "η": "n", "μ": "u",
  "ı": "i", "ł": "l", "ø": "o", "ð": "d", "ß": "b", "ɑ": "a", "ʀ": "r", "ɴ": "n", "ʏ": "y", "ᴍ": "m", "ᴘ": "p",
  "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "å": "a", "ā": "a", "ă": "a", "ą": "a",
  "è": "e", "é": "e", "ê": "e", "ë": "e", "ē": "e", "ė": "e", "ę": "e",
  "ì": "i", "í": "i", "î": "i", "ï": "i", "ī": "i", "ò": "o", "ó": "o", "ô": "o", "õ": "o", "ö": "o", "ō": "o", "ő": "o",
  "ù": "u", "ú": "u", "û": "u", "ü": "u", "ū": "u", "ů": "u", "ű": "u", "ñ": "n", "ń": "n", "ç": "c", "ć": "c", "č": "c",
  "ś": "s", "š": "s", "ž": "z", "ź": "z", "ż": "z", "ý": "y", "ÿ": "y", "ğ": "g", "ř": "r", "ď": "d", "ť": "t", "ľ": "l",
};

/**
 * Map a label to a visual "skeleton": Unicode confusables → Latin, then multi-char ASCII
 * tricks (rn→m, vv→w), digit swaps (0→o, 1/l/i→l, 3→e, 5→s) and hyphens dropped. Two
 * labels with the same skeleton look the same at a glance.
 */
export function skeleton(label: string): string {
  let s = "";
  for (const ch of label.normalize("NFC").toLowerCase()) {
    const c = CONFUSABLE[ch];
    if (c) { s += c; continue; }
    // Fullwidth ASCII (ａ-ｚ, ０-９).
    const code = ch.codePointAt(0)!;
    if (code >= 0xff01 && code <= 0xff5e) { s += String.fromCodePoint(code - 0xfee0).toLowerCase(); continue; }
    s += ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
  return s
    .replace(/[-_]/g, "")
    .replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d")
    .replace(/0/g, "o").replace(/[1i|!]/g, "l").replace(/3/g, "e").replace(/5/g, "s").replace(/\$/g, "s").replace(/8/g, "b");
}

/** Damerau–Levenshtein (optimal string alignment) distance. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

// ---------- blocklist ----------

const BLOCKLIST_URLS = [
  "https://raw.githubusercontent.com/phantom/blocklist/master/blocklist.yaml",
];
const BLOCKLIST_TTL = 6 * 60 * 60_000;
const BLOCKLIST_RETRY = 5 * 60_000;
let blocklist: { set: Set<string>; at: number } | null = null;
let blocklistTriedAt = 0;
let inflight: Promise<void> | null = null;

/** Parse the YAML list without a YAML dependency: entries are `- url: host` lines. */
export function parseBlocklist(yaml: string): Set<string> {
  const out = new Set<string>();
  for (const line of yaml.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*url:\s*["']?([^"'\s#]+)["']?/);
    if (!m) continue;
    const host = m[1].toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "").replace(/\.$/, "");
    if (host.includes(".")) out.add(host);
  }
  return out;
}

async function refreshBlocklist(): Promise<void> {
  blocklistTriedAt = Date.now();
  const set = new Set<string>();
  let okCount = 0;
  await Promise.all(BLOCKLIST_URLS.map(async (u) => {
    try {
      const r = await fetch(u, { cache: "no-store", signal: AbortSignal.timeout(6000) });
      if (!r.ok) return;
      for (const h of parseBlocklist(await r.text())) set.add(h);
      okCount++;
    } catch { /* degrade gracefully */ }
  }));
  if (okCount && set.size > 100) blocklist = { set, at: Date.now() };
}

/** Load (or refresh) the cached blocklist. Never throws; returns its freshness. */
export async function ensureBlocklist(): Promise<DomainCheck["blocklist"]> {
  const fresh = blocklist && Date.now() - blocklist.at < BLOCKLIST_TTL;
  if (!fresh && Date.now() - blocklistTriedAt > BLOCKLIST_RETRY) {
    inflight ??= refreshBlocklist().finally(() => { inflight = null; });
    // First load waits; later refreshes happen in the background while the stale copy serves.
    if (!blocklist) await inflight;
  }
  if (!blocklist) return "unavailable";
  return Date.now() - blocklist.at < BLOCKLIST_TTL ? "ok" : "stale";
}

function onBlocklist(host: string): string | null {
  if (!blocklist) return null;
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const cand = labels.slice(i).join(".");
    if (blocklist.set.has(cand)) return cand;
  }
  return null;
}

// ---------- host parsing ----------

export function hostOf(originOrHost: string): string | null {
  const s = originOrHost.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    return u.hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch { return null; }
}

function splitHost(host: string): { registrable: string; label: string; tld: string; subLabels: string[]; suffix: string } {
  const labels = host.split(".");
  const last2 = labels.slice(-2).join(".");
  const multi = labels.length >= 3 && MULTI_PART_SUFFIXES.has(last2);
  const suffixLen = multi ? 2 : 1;
  const label = labels[labels.length - suffixLen - 1] ?? labels[0];
  const suffix = labels.slice(-suffixLen).join(".");
  return { registrable: `${label}.${suffix}`, label, tld: labels[labels.length - 1], subLabels: labels.slice(0, labels.length - suffixLen - 1), suffix };
}

function officialFor(host: string): string | null {
  for (const d of Object.keys(OFFICIAL_DOMAINS)) if (host === d || host.endsWith(`.${d}`)) return d;
  return null;
}

// ---------- main ----------

export async function checkDomain(originOrHost: string): Promise<DomainCheck> {
  const bl = await ensureBlocklist();
  return analyzeDomain(originOrHost, bl);
}

/** Synchronous analysis against whatever blocklist is currently cached. */
export function analyzeDomain(originOrHost: string, bl: DomainCheck["blocklist"] = blocklist ? "ok" : "unavailable"): DomainCheck {
  const raw = originOrHost.trim();
  const host = hostOf(raw);
  if (!host) return { host: raw, verdict: "suspicious", reasons: ["This request comes from an address that isn't a normal website."], blocklist: bl };
  const reasons: string[] = [];
  let score = 0; // ≥ 100 malicious, ≥ 40 suspicious
  const add = (pts: number, why: string) => { score += pts; if (!reasons.includes(why)) reasons.push(why); };

  const isLocal = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
  if (isLocal) return { host, verdict: "ok", reasons: [], blocklist: bl };

  const listed = onBlocklist(host);
  if (listed) add(100, `${listed} is on Phantom's public blocklist of known scam sites.`);

  if (/^https?:/i.test(raw) && raw.toLowerCase().startsWith("http:")) add(25, "The connection isn't encrypted (http, not https).");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) {
    add(45, "The site is a bare IP address, not a domain name.");
    return finish();
  }

  const official = officialFor(host);
  if (official && !listed) {
    return { host, verdict: "ok", reasons: [], trusted: true, blocklist: bl };
  }

  const unicodeHost = host.split(".").some((l) => l.startsWith("xn--")) ? domainToUnicode(host) || host : host;
  const { registrable, label, tld, subLabels, suffix } = splitHost(unicodeHost);
  const labelSkel = skeleton(label);
  const hostTokens = unicodeHost.split(/[.\-_]/).filter(Boolean);
  const hostSkelTokens = hostTokens.map(skeleton);

  // ---- IDN / homograph ----
  if (unicodeHost !== host) {
    const nonAscii = /[^\x00-\x7f]/.test(unicodeHost);
    const scripts = new Set([...unicodeHost].map((c) => (/[a-z0-9.\-]/.test(c) ? "latin" : /[Ѐ-ӿ]/.test(c) ? "cyrillic" : /[Ͱ-Ͽ]/.test(c) ? "greek" : "other")));
    if (nonAscii) add(45, `The address uses look-alike international characters (${unicodeHost}).`);
    if (scripts.has("latin") && scripts.size > 1) add(25, "It mixes Latin with other alphabets, a classic homograph trick.");
  }

  // ---- lookalikes of official domains/brands ----
  const sharedHostLabel = FREE_HOSTS.has(suffix) || MULTI_PART_SUFFIXES.has(suffix);
  for (const b of BRANDS) {
    const brandSkel = skeleton(b.word);
    const candidates = sharedHostLabel ? [labelSkel, ...subLabels.map(skeleton)] : [labelSkel];
    for (const cand of candidates) {
      if (!cand) continue;
      if (cand === brandSkel) {
        // Same skeleton as a brand: either the exact word on the wrong TLD, or a disguised spelling.
        const disguised = label !== b.word || unicodeHost !== host;
        if (disguised) add(100, `"${registrable}" is disguised to look like ${b.name} (${b.domains[0] ?? b.word}).`);
        else add(60, `${b.name}'s real site is ${b.domains.join(" / ")}, not ${registrable}.`);
      } else if (b.word.length >= 5 && cand.length >= 4) {
        const dist = editDistance(cand, brandSkel);
        if (dist === 1 && b.word.length >= 7) add(100, `"${label}" is one character away from ${b.name} — a typosquat of ${b.domains[0] ?? b.word}.`);
        else if (dist === 1) add(55, `"${label}" is one character away from ${b.name} (${b.domains[0] ?? b.word}).`);
        else if (dist === 2 && b.word.length >= 9) add(50, `"${label}" closely resembles ${b.name} (${b.domains[0] ?? b.word}).`);
      }
    }
  }

  const lookalikeScore = score - (listed ? 100 : 0);

  // ---- bait keywords + abused TLDs ----
  const bait = hostTokens.filter((t) => BAIT_WORDS.includes(t.toLowerCase()));
  const baitSub = BAIT_SUBSTRINGS.filter((w) => unicodeHost.includes(w) && !bait.some((t) => t.includes(w)));
  const baitWords = [...new Set([...bait, ...baitSub])];
  const susTld = SUSPICIOUS_TLDS.has(tld);

  // ---- brand embedded in an unrelated domain (phantom-wallet.app, jup-ag.claim-airdrop.xyz) ----
  let brandMention: string | null = null;
  const collapsed = [...COLLAPSED_OFFICIAL.keys()].find((c) => c.length >= 5 && (c.includes("-")
    ? new RegExp(`(^|[.-])${c.replace(/[.]/g, "\\.")}($|[.-])`).test(unicodeHost)
    : hostTokens.includes(c)));
  if (collapsed) brandMention = COLLAPSED_OFFICIAL.get(collapsed)!;
  const compact = skeleton(unicodeHost.split(".").slice(0, -1).join(""));
  for (const b of BRANDS) {
    if (brandMention) break;
    if (b.generic && !baitWords.length && !susTld) continue; // "solana", "drift"… are everyday words
    const bs = skeleton(b.word);
    // Short brand words must appear as a whole token; long ones can be glued to other words.
    if (hostSkelTokens.includes(bs) || (!b.generic && b.word.length >= 6 && (hostSkelTokens.some((t) => t !== bs && t.includes(bs)) || compact.includes(bs)))) brandMention = b.name;
  }
  // Only count it if the lookalike checks above didn't already flag the same impersonation.
  if (brandMention && lookalikeScore === 0) add(collapsed ? 60 : 45, `Uses the name ${brandMention} but isn't ${brandMention}'s official site.`);

  if (baitWords.length) add(Math.min(45, 20 * baitWords.length) + (brandMention ? 40 : 0), `The address contains wallet-scam bait (${baitWords.map((w) => `"${w}"`).join(", ")}).`);
  if (susTld && (baitWords.length || brandMention || lookalikeScore > 0)) add(brandMention || lookalikeScore > 0 ? 40 : 30, `.${tld} domains are cheap and heavily used for crypto phishing.`);
  if (FREE_HOSTS.has(suffix) && (brandMention || baitWords.length || lookalikeScore > 0)) add(brandMention || lookalikeScore > 0 ? 40 : 30, `It's hosted on a free subdomain service (${suffix}), not the app's own domain.`);
  if (subLabels.length >= 4) add(15, "Unusually deep subdomain nesting.");

  return finish();

  function finish(): DomainCheck {
    const verdict: DomainVerdict = score >= 100 ? "malicious" : score >= 40 ? "suspicious" : "ok";
    return { host: host ?? raw, verdict, reasons: verdict === "ok" ? [] : reasons, blocklist: bl };
  }
}
