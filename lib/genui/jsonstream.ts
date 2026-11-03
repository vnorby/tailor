/**
 * Incrementally splits a stream of text into top-level JSON objects, whether the
 * model separated them with newlines, spaces, nothing, or wrapped them in code
 * fences. Feed text with push(); each complete object comes back parsed.
 */
export function jsonObjects() {
  let buf = "", depth = 0, inStr = false, esc = false, start = -1, scanned = 0;
  return {
    push(text: string): unknown[] {
      buf += text;
      const out: unknown[] = [];
      for (let i = scanned; i < buf.length; i++) {
        const c = buf[i];
        if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') { if (depth > 0) inStr = true; continue; }
        if (c === "{") { if (depth === 0) start = i; depth++; }
        else if (c === "}" && depth > 0) {
          depth--;
          if (depth === 0 && start >= 0) {
            try { out.push(JSON.parse(buf.slice(start, i + 1))); } catch { /* malformed object: skip */ }
            buf = buf.slice(i + 1); i = -1; start = -1;
          }
        }
      }
      scanned = buf.length;
      if (depth === 0) { buf = ""; scanned = 0; }
      return out;
    },
  };
}
