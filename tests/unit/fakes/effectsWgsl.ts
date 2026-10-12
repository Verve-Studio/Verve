// Minimal static WGSL reader for the effect / renderer shader tests.
//
// Not a WGSL compiler: it understands exactly what the invariant tests need —
// struct layouts (WGSL host-shareable alignment / size rules), resource
// binding declarations, function bodies and which bindings an entry point
// reaches. Real compilation is covered by the E2E suite on a real GPU.

/** Remove `//` and (nested) block comments. */
export function stripWgslComments(src: string): string {
  let out = "";
  let i = 0;
  let depth = 0;
  while (i < src.length) {
    if (depth === 0 && src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (src.startsWith("/*", i)) {
      depth++;
      i += 2;
      continue;
    }
    if (depth > 0 && src.startsWith("*/", i)) {
      depth--;
      i += 2;
      continue;
    }
    if (depth === 0) out += src[i];
    i++;
  }
  return out;
}

export interface Layout {
  align: number;
  size: number;
}

export interface StructMember {
  name: string;
  type: string;
  offset: number;
  size: number;
  align: number;
}

export interface StructLayout extends Layout {
  name: string;
  members: StructMember[];
}

export type BindingKind =
  | "uniform"
  | "storage"
  | "texture"
  | "storage-texture"
  | "sampler"
  | "other";

export interface WgslBinding {
  group: number;
  binding: number;
  name: string;
  /** Address space / access, e.g. `uniform`, `storage, read`. */
  space: string | null;
  type: string;
  kind: BindingKind;
  /** For storage textures: the texel format. */
  storageFormat?: string;
}

export interface WgslFunction {
  name: string;
  body: string;
  /** `vertex` / `fragment` / `compute` for entry points. */
  stage: "vertex" | "fragment" | "compute" | null;
}

/** Split on commas that aren't nested inside `<>` / `()` / `[]`. */
function splitTopLevel(s: string, sep = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const roundUp = (k: number, n: number): number => Math.ceil(n / k) * k;

const SCALARS: Record<string, Layout> = {
  f32: { align: 4, size: 4 },
  i32: { align: 4, size: 4 },
  u32: { align: 4, size: 4 },
  bool: { align: 4, size: 4 },
  f16: { align: 2, size: 2 },
};

const SHORT_SUFFIX: Record<string, string> = { f: "f32", i: "i32", u: "u32", h: "f16" };

export class WgslModule {
  readonly source: string;
  readonly code: string;
  readonly structs = new Map<string, string>();
  readonly aliases = new Map<string, string>();
  readonly consts = new Map<string, number>();
  readonly bindings: WgslBinding[] = [];
  readonly functions = new Map<string, WgslFunction>();
  private readonly layoutCache = new Map<string, Layout | null>();

  constructor(source: string) {
    this.source = source;
    this.code = stripWgslComments(source);
    for (const m of this.code.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g)) {
      this.structs.set(m[1], m[2]);
    }
    for (const m of this.code.matchAll(/\balias\s+(\w+)\s*=\s*([^;]+);/g)) {
      this.aliases.set(m[1], m[2].trim());
    }
    for (const m of this.code.matchAll(
      /\b(?:const|override)\s+(\w+)\s*(?::\s*\w+\s*)?=\s*([0-9.]+)[uif]?\s*;/g,
    )) {
      this.consts.set(m[1], Number(m[2]));
    }
    for (const m of this.code.matchAll(
      /((?:@\w+\s*\([^)]*\)\s*)+)var(?:\s*<([^>]+)>)?\s+(\w+)\s*:\s*([^;=]+);/g,
    )) {
      const attrs = m[1];
      const g = /@group\s*\(\s*(\d+)\s*\)/.exec(attrs);
      const b = /@binding\s*\(\s*(\d+)\s*\)/.exec(attrs);
      if (!g || !b) continue;
      const space = m[2]?.trim() ?? null;
      const type = m[4].trim();
      let kind: BindingKind = "other";
      let storageFormat: string | undefined;
      if (space === "uniform") kind = "uniform";
      else if (space?.startsWith("storage")) kind = "storage";
      else if (/^texture_storage_/.test(type)) {
        kind = "storage-texture";
        storageFormat = /<\s*(\w+)/.exec(type)?.[1];
      } else if (/^texture_/.test(type)) kind = "texture";
      else if (/^sampler(_comparison)?$/.test(type)) kind = "sampler";
      this.bindings.push({
        group: Number(g[1]),
        binding: Number(b[1]),
        name: m[3],
        space,
        type,
        kind,
        storageFormat,
      });
    }
    this.parseFunctions();
  }

  private parseFunctions(): void {
    const re = /((?:@\w+(?:\s*\([^)]*\))?\s*)*)fn\s+(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.code))) {
      const open = this.code.indexOf("{", re.lastIndex);
      if (open === -1) break;
      let depth = 0;
      let end = open;
      for (; end < this.code.length; end++) {
        const ch = this.code[end];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      const attrs = m[1];
      const stage = /@vertex/.test(attrs)
        ? "vertex"
        : /@fragment/.test(attrs)
          ? "fragment"
          : /@compute/.test(attrs)
            ? "compute"
            : null;
      // Include the signature: parameters can name structs etc.
      this.functions.set(m[2], { name: m[2], body: this.code.slice(m.index, end + 1), stage });
      re.lastIndex = end + 1;
    }
  }

  entryPoints(stage?: WgslFunction["stage"]): WgslFunction[] {
    return [...this.functions.values()].filter((f) => f.stage !== null && (!stage || f.stage === stage));
  }

  /** Names of every function transitively called from `entry`. */
  reachableFunctions(entry: string): Set<string> {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const name = stack.pop()!;
      if (seen.has(name)) continue;
      const fn = this.functions.get(name);
      if (!fn) continue;
      seen.add(name);
      for (const other of this.functions.keys()) {
        if (!seen.has(other) && new RegExp(`\\b${other}\\s*\\(`).test(fn.body)) stack.push(other);
      }
    }
    return seen;
  }

  /** Bindings statically referenced by the given entry points. */
  usedBindings(entries: readonly string[]): WgslBinding[] {
    const fns = new Set<string>();
    for (const e of entries) for (const f of this.reachableFunctions(e)) fns.add(f);
    const bodies = [...fns].map((f) => this.functions.get(f)!.body).join("\n");
    return this.bindings.filter((b) => new RegExp(`\\b${b.name}\\b`).test(bodies));
  }

  binding(group: number, binding: number): WgslBinding | undefined {
    return this.bindings.find((b) => b.group === group && b.binding === binding);
  }

  private resolveCount(expr: string): number | null {
    const t = expr.trim().replace(/[ui]$/, "");
    if (/^\d+$/.test(t)) return Number(t);
    return this.consts.get(t) ?? null;
  }

  /** Host-shareable layout of a type, or null for runtime-sized / unknown. */
  layout(typeIn: string): Layout | null {
    const type = typeIn.replace(/\s+/g, "");
    if (this.layoutCache.has(type)) return this.layoutCache.get(type)!;
    const result = this.computeLayout(type);
    this.layoutCache.set(type, result);
    return result;
  }

  private computeLayout(type: string): Layout | null {
    if (SCALARS[type]) return SCALARS[type];
    const alias = this.aliases.get(type);
    if (alias) return this.layout(alias);
    let m = /^atomic<(\w+)>$/.exec(type);
    if (m) return SCALARS[m[1]] ?? null;
    m = /^vec([234])(?:<(\w+)>|([fiuh]))$/.exec(type);
    if (m) {
      const n = Number(m[1]);
      const el = SCALARS[m[2] ?? SHORT_SUFFIX[m[3]]];
      if (!el) return null;
      const size = n * el.size;
      const align = n === 3 ? 4 * el.size : size;
      return { align, size };
    }
    m = /^mat([234])x([234])(?:<(\w+)>|([fh]))$/.exec(type);
    if (m) {
      const cols = Number(m[1]);
      const rows = Number(m[2]);
      const col = this.layout(`vec${rows}<${m[3] ?? SHORT_SUFFIX[m[4]]}>`);
      if (!col) return null;
      return { align: col.align, size: cols * roundUp(col.align, col.size) };
    }
    m = /^array<(.+)>$/.exec(type);
    if (m) {
      const parts = splitTopLevel(m[1]);
      if (parts.length < 2) return null; // runtime-sized
      const el = this.layout(parts[0]);
      const count = this.resolveCount(parts[1]);
      if (!el || count === null) return null;
      return { align: el.align, size: count * roundUp(el.align, el.size) };
    }
    if (this.structs.has(type)) return this.structLayout(type);
    return null;
  }

  /** Full layout of a struct, or null when a member's layout is unknown. */
  structLayout(name: string): StructLayout | null {
    const body = this.structs.get(name);
    if (body === undefined) return null;
    const members: StructMember[] = [];
    let offset = 0;
    let align = 1;
    for (const raw of splitTopLevel(body)) {
      const decl = raw.trim();
      if (!decl) continue;
      const m = /^((?:@\w+\s*(?:\([^)]*\))?\s*)*)(\w+)\s*:\s*(.+)$/s.exec(decl);
      if (!m) return null;
      const lay = this.layout(m[3]);
      if (!lay) return null;
      const alignAttr = /@align\s*\(\s*(\d+)\s*\)/.exec(m[1]);
      const sizeAttr = /@size\s*\(\s*(\d+)\s*\)/.exec(m[1]);
      const mAlign = alignAttr ? Number(alignAttr[1]) : lay.align;
      const mSize = sizeAttr ? Number(sizeAttr[1]) : lay.size;
      offset = roundUp(mAlign, offset);
      members.push({ name: m[2], type: m[3].trim(), offset, size: mSize, align: mAlign });
      offset += mSize;
      align = Math.max(align, mAlign);
    }
    return { name, members, align, size: roundUp(align, offset) };
  }

  /** Bytes up to the end of the last non-padding member (`_`-prefixed
   *  members are padding). What a host must write for the shader to read
   *  only defined data. */
  meaningfulBytes(type: string): number | null {
    const s = this.structLayout(type.trim());
    if (!s) {
      const l = this.layout(type);
      return l ? l.size : null;
    }
    let end = 0;
    for (const m of s.members) if (!m.name.startsWith("_")) end = m.offset + m.size;
    return end;
  }
}

/** Basic structural sanity: balanced delimiters outside comments. */
export function delimiterBalance(src: string): string | null {
  const code = stripWgslComments(src);
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  for (const ch of code) {
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch in pairs) {
      if (stack.pop() !== pairs[ch]) return `unbalanced '${ch}'`;
    }
  }
  return stack.length ? `unclosed '${stack[stack.length - 1]}'` : null;
}
