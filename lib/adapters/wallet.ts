/**
 * Core wallet tools: send SOL/SPL tokens and reclaim rent from empty token accounts.
 * These are what make "send 2 SOL to …" or "clean up my wallet" possible from a prompt.
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Adapter, Ctx } from "@/lib/core/types";
import { buildTx, connection, isAddress, num, SOL_MINT } from "@/lib/core/solana";

function findToken(input: string, ctx: Ctx) {
  const s = input.trim();
  return ctx.tokens.find((t) => t.mint === s) ?? ctx.tokens.find((t) => t.symbol.toLowerCase() === s.toLowerCase());
}

async function send(owner: string, params: Record<string, string>, ctx: Ctx) {
  const to = (params.to ?? "").trim();
  if (!isAddress(to)) throw new Error("Enter a valid Solana address to send to.");
  if (to === owner) throw new Error("That's your own address.");
  const token = findToken(params.token || "SOL", ctx);
  if (!token) throw new Error(`You don't hold ${params.token}.`);
  const amount = params.amount === "max" ? token.amount : Number(params.amount);
  if (!(amount > 0)) throw new Error("Enter an amount greater than zero.");
  if (amount > token.amount + 1e-12) throw new Error(`You only have ${num(token.amount)} ${token.symbol}.`);

  const from = new PublicKey(owner), dest = new PublicKey(to);
  const warnings: string[] = [];
  const destInfo = await connection().getAccountInfo(dest);
  if (!destInfo) warnings.push("This address has never been used on Solana. Double-check it before sending.");
  if (!PublicKey.isOnCurve(dest.toBytes())) warnings.push("This address is a program-derived account, not a normal wallet. Funds sent here may be unrecoverable.");

  const ixs: TransactionInstruction[] = [];
  if (token.mint === SOL_MINT) {
    // Keep enough for fees when sending "max".
    const lamports = BigInt(Math.floor((params.amount === "max" ? Math.max(0, amount - 0.001) : amount) * 1e9));
    ixs.push(SystemProgram.transfer({ fromPubkey: from, toPubkey: dest, lamports }));
  } else {
    const mint = new PublicKey(token.mint);
    const mintInfo = await connection().getAccountInfo(mint);
    const programId = mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const srcAta = getAssociatedTokenAddressSync(mint, from, false, programId);
    const dstAta = getAssociatedTokenAddressSync(mint, dest, true, programId);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(from, dstAta, dest, mint, programId));
    const atomic = BigInt(Math.floor(amount * 10 ** token.decimals));
    ixs.push(createTransferCheckedInstruction(srcAta, mint, dstAta, from, atomic, token.decimals, [], programId));
  }
  return { txs: [await buildTx(owner, ixs, { cuLimit: 60_000 })], summary: `Send ${num(amount)} ${token.symbol} to ${to.slice(0, 4)}…${to.slice(-4)}.`, warnings };
}

async function closeEmpty(owner: string) {
  const c = connection();
  const pk = new PublicKey(owner);
  const empties: { pubkey: PublicKey; programId: PublicKey; lamports: number }[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await c.getParsedTokenAccountsByOwner(pk, { programId });
    for (const a of res.value) {
      const info = (a.account.data as { parsed?: { info?: { tokenAmount?: { amount: string }; state?: string; closeAuthority?: string } } }).parsed?.info;
      if (info?.tokenAmount?.amount === "0" && info.state !== "frozen" && (!info.closeAuthority || info.closeAuthority === owner)) empties.push({ pubkey: a.pubkey, programId, lamports: a.account.lamports });
    }
  }
  if (!empties.length) throw new Error("You have no empty token accounts to close.");
  const batch = empties.slice(0, 20);
  const ixs = batch.map((e) => createCloseAccountInstruction(e.pubkey, pk, pk, [], e.programId));
  const sol = batch.reduce((s, e) => s + e.lamports, 0) / 1e9;
  return {
    txs: [await buildTx(owner, ixs, { cuLimit: 20_000 + batch.length * 5_000 })],
    summary: `Close ${batch.length} empty token account${batch.length > 1 ? "s" : ""} and reclaim ~${num(sol, 4)} SOL of rent.`,
    warnings: empties.length > batch.length ? [`${empties.length - batch.length} more remain; run this again afterwards.`] : [],
  };
}

export const walletAdapter: Adapter = {
  protocol: "wallet",
  name: "Wallet",
  async positions() { return []; },
  tools: [
    {
      id: "send", protocol: "wallet", label: "Send",
      description: "Send SOL or any token you hold to a Solana address. Prefill 'to', 'token' (symbol) and 'amount' (number or 'max') from the user's request.",
      fields: [
        { name: "to", label: "To address", kind: "text" },
        { name: "token", label: "Token", kind: "text", default: "SOL" },
        { name: "amount", label: "Amount", kind: "amount" },
      ],
    },
    {
      id: "close-empty-accounts", protocol: "wallet", label: "Reclaim rent",
      description: "Close the wallet's empty token accounts and get back their rent (~0.002 SOL each).",
      fields: [],
    },
  ],
  async buildTool(owner, toolId, params, ctx) {
    if (toolId === "send") return send(owner, params, ctx);
    if (toolId === "close-empty-accounts") return closeEmpty(owner);
    throw new Error(`Unknown tool ${toolId}`);
  },
};
