// ─── Minimal YAML reader (OCIO-subset) ───────────────────────────────────────
//
// OCIO configs use a constrained slice of YAML 1.1: indented block maps,
// block sequences, scalars, flow mappings inside `!<Tag>` notation, and
// occasional flow sequences for matrices. We do NOT support anchors,
// aliases, multi-doc streams, folded scalars, or custom tags beyond the
// `!<Tag>` shorthand.
//
// Output shape: a plain JS value tree. `!<Tag>` is preserved on the
// resulting object as a `__tag` property so the OCIO importer can branch
// on transform type.

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue | undefined };

interface Cursor {
  lines: string[];
  i: number;
}

const COMMENT_RE = /(^|\s)#.*/;

function stripComment(line: string): string {
  // Remove `# ...` comments not inside quoted strings. Conservative — if
  // a value contains `#` inside quotes, this still works because we only
  // strip when preceded by whitespace or at line start.
  return line.replace(COMMENT_RE, "$1").replace(/\s+$/, "");
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 2;
    else break;
  }
  return n;
}

function parseScalar(s: string): YamlValue {
  const t = s.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+(e-?\d+)?$/i.test(t) || /^-?\d+e-?\d+$/i.test(t)) {
    return parseFloat(t);
  }
  // Quoted strings — strip quotes.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse a flow value: `[a, b, c]`, `{key: val, ...}`, or a scalar. */
function parseFlow(input: string): YamlValue {
  const s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) {
    return splitFlowItems(s.slice(1, -1)).map(parseFlow);
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const out: { [k: string]: YamlValue } = {};
    for (const item of splitFlowItems(s.slice(1, -1))) {
      const colon = item.indexOf(":");
      if (colon < 0) continue;
      out[item.slice(0, colon).trim()] = parseFlow(item.slice(colon + 1));
    }
    return out;
  }
  return parseScalar(s);
}

/** Split a flow-collection body on commas, respecting nested brackets and
 *  quoted strings. */
function splitFlowItems(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote && body[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (start < body.length) out.push(body.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Recognise `!<Tag> rest` and split into `(tag, rest)`. */
function extractTag(value: string): { tag?: string; rest: string } {
  const m = value.match(/^!<([^>]+)>\s*(.*)$/);
  if (!m) return { rest: value };
  return { tag: m[1], rest: m[2] };
}

function parseBlock(c: Cursor, indent: number): YamlValue {
  // Decide map vs sequence by the first non-empty line at this indent.
  while (c.i < c.lines.length) {
    const line = c.lines[c.i];
    const stripped = stripComment(line);
    if (stripped.trim() === "") {
      c.i++;
      continue;
    }
    const ind = indentOf(stripped);
    if (ind < indent) return null;
    if (stripped.trimStart().startsWith("- ")) {
      return parseSequence(c, indent);
    }
    return parseMap(c, indent);
  }
  return null;
}

function parseSequence(c: Cursor, indent: number): YamlValue[] {
  const out: YamlValue[] = [];
  while (c.i < c.lines.length) {
    const raw = c.lines[c.i];
    const line = stripComment(raw);
    if (line.trim() === "") {
      c.i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent || !line.trimStart().startsWith("- ")) break;
    const after = line.slice(ind + 2);
    c.i++;
    // The "- !<Tag> {…}" / "- key: value" / scalar forms.
    const { tag, rest } = extractTag(after);
    if (rest.startsWith("{") || rest.startsWith("[")) {
      const v = parseFlow(rest);
      if (tag && v && typeof v === "object" && !Array.isArray(v)) {
        (v as { [k: string]: YamlValue }).__tag = tag;
      }
      out.push(v);
      continue;
    }
    // Embedded "key: value" inline at start, possibly more nested keys
    if (/^[\w-]+\s*:/.test(rest)) {
      // Re-inject as a one-line map; consume any further-nested lines.
      const inlineLine = " ".repeat(ind + 2) + rest;
      c.lines[c.i - 1] = inlineLine; // replace the just-consumed "- " with the inline body
      c.i--;
      const m = parseMap(c, ind + 2);
      if (tag && m && typeof m === "object" && !Array.isArray(m)) {
        (m as { [k: string]: YamlValue }).__tag = tag;
      }
      out.push(m);
      continue;
    }
    out.push(parseScalar(rest));
  }
  return out;
}

function parseMap(c: Cursor, indent: number): { [key: string]: YamlValue } {
  const out: { [key: string]: YamlValue } = {};
  while (c.i < c.lines.length) {
    const raw = c.lines[c.i];
    const line = stripComment(raw);
    if (line.trim() === "") {
      c.i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) break;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("- ")) break;
    const colon = trimmed.indexOf(":");
    if (colon < 0) break;
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    c.i++;
    if (rest === "") {
      out[key] = parseBlock(c, indent + 2);
      continue;
    }
    const { tag, rest: r2 } = extractTag(rest);
    if (r2.startsWith("{") || r2.startsWith("[")) {
      const v = parseFlow(r2);
      if (tag && v && typeof v === "object" && !Array.isArray(v)) {
        (v as { [k: string]: YamlValue }).__tag = tag;
      }
      out[key] = v;
    } else if (tag) {
      // Tagged scalar: treat as a 1-key tagged object.
      out[key] = { __tag: tag, value: parseScalar(r2) };
    } else {
      out[key] = parseScalar(r2);
    }
  }
  return out;
}

export function parseYaml(source: string): YamlValue {
  const c: Cursor = { lines: source.split(/\r?\n/), i: 0 };
  return parseBlock(c, 0);
}
