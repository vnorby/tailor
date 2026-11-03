/**
 * Per-wallet generated page + standing instructions. Neon Postgres when DATABASE_URL is
 * set, otherwise an in-process map (fine for local dev, lost on restart).
 */
import { neon } from "@neondatabase/serverless";
import type { Prefs } from "./types";
import type { Page } from "@/lib/genui/spec";

export interface Saved { layout: Page | null; prefs: Prefs; fingerprint: string | null }

const empty = (): Saved => ({ layout: null, prefs: { instructions: [] }, fingerprint: null });
const mem = new Map<string, Saved>();

let ready: Promise<void> | null = null;
function db() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = neon(url);
  ready ??= sql`CREATE TABLE IF NOT EXISTS wallet_layouts (
    owner text PRIMARY KEY, layout jsonb, prefs jsonb NOT NULL DEFAULT '{"instructions":[]}',
    fingerprint text, updated_at timestamptz NOT NULL DEFAULT now())`.then(() => undefined);
  return sql;
}

export async function load(owner: string): Promise<Saved> {
  const sql = db();
  if (!sql) return mem.get(owner) ?? empty();
  await ready;
  const rows = (await sql`SELECT layout, prefs, fingerprint FROM wallet_layouts WHERE owner = ${owner}`) as { layout: Page | null; prefs: Prefs; fingerprint: string | null }[];
  return rows[0] ? { layout: rows[0].layout, prefs: rows[0].prefs ?? { instructions: [] }, fingerprint: rows[0].fingerprint } : empty();
}

export async function save(owner: string, s: Saved): Promise<void> {
  const sql = db();
  if (!sql) { mem.set(owner, s); return; }
  await ready;
  await sql`INSERT INTO wallet_layouts (owner, layout, prefs, fingerprint, updated_at)
    VALUES (${owner}, ${JSON.stringify(s.layout)}, ${JSON.stringify(s.prefs)}, ${s.fingerprint}, now())
    ON CONFLICT (owner) DO UPDATE SET layout = EXCLUDED.layout, prefs = EXCLUDED.prefs, fingerprint = EXCLUDED.fingerprint, updated_at = now()`;
}
