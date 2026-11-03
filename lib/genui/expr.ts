/**
 * A tiny, safe expression language for generated UI: numbers, variables,
 * + − × ÷, parentheses, comparisons, ternary, and a few math functions.
 * No property access, no strings, no eval — generated specs can compute
 * with live position data but can't execute anything.
 *
 * Templates: any text may contain {{expr}} or {{expr|format}}.
 */

export type Scope = Record<string, number>;

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (id) { out.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
    const op = /^(<=|>=|==|!=|&&|\|\||[-+*/%()<>?:,!])/.exec(src.slice(i));
    if (op) { out.push({ t: "op", v: op[0] }); i += op[0].length; continue; }
    throw new Error(`bad char ${c}`);
  }
  return out;
}

const FNS: Record<string, (...a: number[]) => number> = {
  min: Math.min, max: Math.max, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sqrt: Math.sqrt, log: Math.log, pow: Math.pow,
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
};

/** Recursive-descent parser that evaluates as it goes. Unknown variables → NaN. */
export function evaluate(src: string, scope: Scope): number {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p];
    if (!t || (v && (t.t !== "op" || t.v !== v))) throw new Error(`expected ${v}`);
    p++;
    return t;
  };
  const ternary = (): number => {
    const c = or();
    if (peek()?.t === "op" && peek()!.v === "?") { eat("?"); const a = ternary(); eat(":"); const b = ternary(); return c ? a : b; }
    return c;
  };
  const or = (): number => { let a = and(); while (peek()?.v === "||") { eat(); const b = and(); a = a || b ? 1 : 0; } return a; };
  const and = (): number => { let a = cmp(); while (peek()?.v === "&&") { eat(); const b = cmp(); a = a && b ? 1 : 0; } return a; };
  const cmp = (): number => {
    let a = add();
    while (peek()?.t === "op" && ["<", ">", "<=", ">=", "==", "!="].includes(String(peek()!.v))) {
      const op = eat().v as string; const b = add();
      a = (op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : op === ">=" ? a >= b : op === "==" ? a === b : a !== b) ? 1 : 0;
    }
    return a;
  };
  const add = (): number => { let a = mul(); while (peek()?.t === "op" && (peek()!.v === "+" || peek()!.v === "-")) { const op = eat().v; const b = mul(); a = op === "+" ? a + b : a - b; } return a; };
  const mul = (): number => { let a = unary(); while (peek()?.t === "op" && ["*", "/", "%"].includes(String(peek()!.v))) { const op = eat().v; const b = unary(); a = op === "*" ? a * b : op === "/" ? a / b : a % b; } return a; };
  const unary = (): number => {
    if (peek()?.v === "-") { eat(); return -unary(); }
    if (peek()?.v === "!") { eat(); return unary() ? 0 : 1; }
    return atom();
  };
  const atom = (): number => {
    const t = peek();
    if (!t) throw new Error("unexpected end");
    if (t.t === "num") { p++; return t.v; }
    if (t.t === "op" && t.v === "(") { eat("("); const v = ternary(); eat(")"); return v; }
    if (t.t === "id") {
      p++;
      if (peek()?.v === "(") {
        const fn = Object.hasOwn(FNS, t.v) ? FNS[t.v] : undefined; if (!fn) throw new Error(`unknown fn ${t.v}`);
        eat("("); const args: number[] = [];
        if (peek()?.v !== ")") { args.push(ternary()); while (peek()?.v === ",") { eat(","); args.push(ternary()); } }
        eat(")");
        return fn(...args);
      }
      return Object.hasOwn(scope, t.v) && typeof scope[t.v] === "number" ? scope[t.v] : NaN;
    }
    throw new Error(`unexpected ${t.v}`);
  };
  const v = ternary();
  if (p !== toks.length) throw new Error("trailing tokens");
  return v;
}

export const safeEval = (src: string | number | undefined, scope: Scope): number => {
  if (typeof src === "number") return src;
  if (!src) return NaN;
  try { return evaluate(src, scope); } catch { return NaN; }
};

export type Fmt = "usd" | "usd0" | "pct" | "pct100" | "num" | "num0" | "num2" | "price" | "x" | "sol";

export function fmt(n: number, f: Fmt | string = "num"): string {
  if (!isFinite(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? "−" : "";
  switch (f) {
    case "usd": return `${s}$${a.toLocaleString("en-US", { minimumFractionDigits: a >= 1000 ? 0 : 2, maximumFractionDigits: a >= 1000 ? 0 : a < 1 ? 4 : 2 })}`;
    case "usd0": return `${s}$${Math.round(a).toLocaleString("en-US")}`;
    case "pct": return `${(n * 100).toFixed(Math.abs(n) < 0.1 ? 2 : 1)}%`;
    case "pct100": return `${n.toFixed(1)}%`;
    case "num0": return Math.round(n).toLocaleString("en-US");
    case "num2": return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    case "price": return a >= 1000 ? `${s}$${a.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : a >= 1 ? `${s}$${a.toFixed(2)}` : `${s}$${a.toPrecision(4)}`;
    case "x": return `${n.toFixed(n >= 10 ? 0 : 1)}x`;
    case "sol": return `${n.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`;
    default: return n.toLocaleString("en-US", { maximumFractionDigits: a >= 1000 ? 0 : 4 });
  }
}

/** Replace {{expr|fmt}} with formatted values from scope. */
export function template(text: string, scope: Scope): string {
  return text.replace(/\{\{([^}|]+)(?:\|([a-z0-9]+))?\}\}/gi, (_, expr: string, f?: string) => fmt(safeEval(expr.trim(), scope), (f ?? "num") as Fmt));
}
