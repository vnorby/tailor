/**
 * Generic Anchor program support for the agent: read a program's IDL from chain,
 * summarize it for the model, and encode instructions from plain JSON. Handles
 * both the new (0.30+, `metadata.spec`) and legacy IDL formats.
 */
import { inflateSync } from "node:zlib";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BN, BorshInstructionCoder as Coder30, type Idl as Idl30 } from "@coral-xyz/anchor";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { BorshInstructionCoder as Coder29 } from "@coral-xyz/anchor-29";
import { connection } from "@/lib/core/solana";

type AnyIdl = Record<string, unknown> & { instructions: IdlIx[]; types?: IdlTypeDef[]; metadata?: { spec?: string; name?: string } ; name?: string };
interface IdlAccount { name: string; writable?: boolean; isMut?: boolean; signer?: boolean; isSigner?: boolean; optional?: boolean; isOptional?: boolean; address?: string; pda?: unknown; accounts?: IdlAccount[] }
interface IdlIx { name: string; accounts: IdlAccount[]; args: { name: string; type: unknown }[]; docs?: string[] }
interface IdlTypeDef { name: string; type: { kind: string; fields?: { name: string; type: unknown }[]; variants?: { name: string; fields?: unknown[] }[] } }

const cache = new Map<string, AnyIdl | null>();
const isNew = (idl: AnyIdl) => !!idl.metadata?.spec;

/** Anchor stores the IDL at createWithSeed(signer PDA, "anchor:idl", program), zlib-compressed. */
export async function fetchIdl(programId: string): Promise<AnyIdl | null> {
  if (cache.has(programId)) return cache.get(programId)!;
  try {
    const pid = new PublicKey(programId);
    const [base] = PublicKey.findProgramAddressSync([], pid);
    const addr = await PublicKey.createWithSeed(base, "anchor:idl", pid);
    const info = await connection().getAccountInfo(addr);
    if (!info) { cache.set(programId, null); return null; }
    const len = info.data.readUInt32LE(40);
    const idl = JSON.parse(inflateSync(info.data.subarray(44, 44 + len)).toString("utf8")) as AnyIdl;
    cache.set(programId, idl);
    return idl;
  } catch { cache.set(programId, null); return null; }
}

const flatAccounts = (accs: IdlAccount[], prefix = ""): IdlAccount[] =>
  accs.flatMap((a) => (a.accounts ? flatAccounts(a.accounts, `${prefix}${a.name}.`) : [{ ...a, name: `${prefix}${a.name}` }]));

const typeStr = (t: unknown): string => {
  if (typeof t === "string") return t;
  if (t && typeof t === "object") {
    const o = t as Record<string, unknown>;
    if (o.defined) return typeof o.defined === "string" ? o.defined : String((o.defined as { name: string }).name);
    if (o.option) return `Option<${typeStr(o.option)}>`;
    if (o.vec) return `Vec<${typeStr(o.vec)}>`;
    if (o.array) { const [inner, n] = o.array as [unknown, number]; return `[${typeStr(inner)}; ${n}]`; }
  }
  return JSON.stringify(t);
};

/** A compact description of what the program can do, for the model. */
export function summarizeIdl(idl: AnyIdl, only?: string): string {
  const name = idl.metadata?.name ?? idl.name ?? "program";
  const ixs = idl.instructions.filter((ix) => !only || ix.name === only);
  const lines = [`Program ${name} (${isNew(idl) ? "anchor ≥0.30" : "anchor legacy"} IDL), ${idl.instructions.length} instructions.`];
  for (const ix of ixs.slice(0, only ? 1 : 60)) {
    const accs = flatAccounts(ix.accounts).map((a) => `${a.name}${a.writable || a.isMut ? "(w)" : ""}${a.signer || a.isSigner ? "(signer)" : ""}${a.optional || a.isOptional ? "(opt)" : ""}${a.address ? `=${a.address}` : ""}${a.pda ? "(pda)" : ""}`);
    lines.push(`- ${ix.name}(${ix.args.map((x) => `${x.name}: ${typeStr(x.type)}`).join(", ")}) accounts: ${accs.join(", ")}`);
  }
  if (only && idl.types?.length) {
    const used = new Set<string>(JSON.stringify(ixs.map((i) => i.args)).match(/"defined":(?:"([^"]+)"|\{"name":"([^"]+)")/g)?.map((m) => m.replace(/.*"([^"]+)"$/, "$1")) ?? []);
    for (const t of idl.types.filter((x) => used.has(x.name))) lines.push(`type ${t.name} = ${t.type.kind} ${JSON.stringify(t.type.fields ?? t.type.variants ?? [])}`);
  }
  return lines.join("\n");
}

/** Convert JSON args into what the borsh coder expects (BN for big ints, PublicKey for keys). */
function convert(v: unknown, t: unknown, types: IdlTypeDef[]): unknown {
  if (v == null) return null;
  if (typeof t === "string") {
    if (/^[ui](64|128|256)$/.test(t)) return new BN(String(v));
    if (t === "publicKey" || t === "pubkey") return new PublicKey(String(v));
    if (t === "bytes") return Buffer.from(String(v), "base64");
    return v;
  }
  const o = t as Record<string, unknown>;
  if (o.option) return convert(v, o.option, types);
  if (o.vec) return (v as unknown[]).map((x) => convert(x, o.vec, types));
  if (o.array) return (v as unknown[]).map((x) => convert(x, (o.array as unknown[])[0], types));
  if (o.defined) {
    const name = typeof o.defined === "string" ? o.defined : (o.defined as { name: string }).name;
    const def = types.find((x) => x.name === name);
    if (def?.type.kind === "struct" && def.type.fields && v && typeof v === "object") {
      return Object.fromEntries(def.type.fields.map((f) => [f.name, convert((v as Record<string, unknown>)[f.name], f.type, types)]));
    }
    return v; // enums: pass { VariantName: {...} } through
  }
  return v;
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export async function buildAnchorIx(owner: string, programId: string, ixName: string, accounts: Record<string, string>, args: Record<string, unknown>, remaining: { pubkey: string; is_writable?: boolean; is_signer?: boolean }[] = []): Promise<TransactionInstruction> {
  const idl = await fetchIdl(programId);
  if (!idl) throw new Error(`No Anchor IDL on chain for ${programId}. Use build_raw_transaction instead.`);
  const ix = idl.instructions.find((i) => i.name === ixName || camel(i.name) === ixName || i.name === snake(ixName));
  if (!ix) throw new Error(`Instruction ${ixName} not found. Available: ${idl.instructions.map((i) => i.name).slice(0, 40).join(", ")}`);
  const types = idl.types ?? [];
  const lookup = (name: string) => accounts[name] ?? accounts[camel(name)] ?? accounts[snake(name)] ?? accounts[name.split(".").pop()!];
  const keys = flatAccounts(ix.accounts).flatMap((a) => {
    const addr = lookup(a.name) ?? a.address;
    const signer = !!(a.signer || a.isSigner), writable = !!(a.writable || a.isMut);
    if (!addr) {
      if (a.optional || a.isOptional) return [{ pubkey: new PublicKey(programId), isSigner: false, isWritable: false }]; // Anchor's "None" placeholder
      throw new Error(`Missing account "${a.name}" for ${ix.name}.`);
    }
    if (signer && addr !== owner) throw new Error(`Account "${a.name}" must sign, but only the wallet owner can sign.`);
    return [{ pubkey: new PublicKey(addr), isSigner: signer, isWritable: writable }];
  });
  // Many programs read extra accounts beyond the IDL (reserves, oracles, bins): appended in order.
  for (const r of remaining) {
    if (r.is_signer && r.pubkey !== owner) throw new Error(`Remaining account ${r.pubkey} can't sign; only the wallet owner can.`);
    keys.push({ pubkey: new PublicKey(r.pubkey), isSigner: !!r.is_signer, isWritable: !!r.is_writable });
  }
  const argObj = Object.fromEntries(ix.args.map((a) => [isNew(idl) ? a.name : camel(a.name), convert(args[a.name] ?? args[camel(a.name)] ?? args[snake(a.name)], a.type, types)]));
  const data = isNew(idl)
    ? new Coder30(idl as unknown as Idl30).encode(ix.name, argObj)
    : new (Coder29 as unknown as new (i: unknown) => { encode(n: string, a: unknown): Buffer })(idl).encode(camel(ix.name), argObj);
  return new TransactionInstruction({ programId: new PublicKey(programId), keys, data });
}

// ---------- account decoding ----------

import { createHash } from "node:crypto";
import { BorshAccountsCoder as Acc30 } from "@coral-xyz/anchor";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { BorshAccountsCoder as Acc29 } from "@coral-xyz/anchor-29";

/** JSON-safe view of decoded data: BN/PublicKey → strings, long byte arrays summarized. */
function plain(v: unknown, depth = 0): unknown {
  if (v == null || depth > 6) return v;
  if (v instanceof PublicKey) return v.toBase58();
  if (BN.isBN(v)) return (v as BN).toString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v.length > 32 ? `<${v.length} bytes>` : Buffer.from(v).toString("hex");
  if (Array.isArray(v)) {
    if (v.length > 24 && v.every((x) => typeof x === "number")) return `<${v.length} numbers>`;
    const items = v.slice(0, 24).map((x) => plain(x, depth + 1));
    return v.length > 24 ? [...items, `…${v.length - 24} more`] : items;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof (o as { toBase58?: unknown }).toBase58 === "function") return (o as unknown as PublicKey).toBase58();
    return Object.fromEntries(Object.entries(o).filter(([k]) => !/^padding|^reserved/i.test(k)).map(([k, x]) => [k, plain(x, depth + 1)]));
  }
  return v;
}

/** Decode an account owned by an Anchor program, if its IDL is on chain. */
export async function decodeAnchorAccount(programId: string, data: Buffer): Promise<{ type: string; data: unknown } | null> {
  const idl = await fetchIdl(programId);
  const accounts = (idl?.accounts as { name: string; discriminator?: number[] }[] | undefined) ?? [];
  if (!idl || !accounts.length || data.length < 8) return null;
  const head = data.subarray(0, 8);
  for (const a of accounts) {
    const disc = a.discriminator ? Buffer.from(a.discriminator) : createHash("sha256").update(`account:${a.name}`).digest().subarray(0, 8);
    if (!disc.equals(head)) continue;
    try {
      const decoded = isNew(idl)
        ? new Acc30(idl as unknown as Idl30).decode(a.name, data)
        : new (Acc29 as unknown as new (i: unknown) => { decode(n: string, d: Buffer): unknown })(idl).decode(a.name, data);
      return { type: a.name, data: plain(decoded) };
    } catch (e) { return { type: a.name, data: `decode failed: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  return null;
}

/** Name and arguments of an Anchor instruction, if the program's IDL is on chain. */
export async function decodeInstruction(programId: string, data: Buffer): Promise<{ name: string; args: unknown } | null> {
  const idl = await fetchIdl(programId);
  if (!idl || data.length < 8) return null;
  try {
    const coder = isNew(idl) ? new Coder30(idl as unknown as Idl30) : new (Coder29 as unknown as new (i: unknown) => { decode(d: Buffer): { name: string; data: unknown } | null })(idl);
    const r = (coder as unknown as { decode(d: Buffer): { name: string; data: unknown } | null }).decode(data);
    return r ? { name: r.name, args: plain(r.data) } : null;
  } catch { return null; }
}
