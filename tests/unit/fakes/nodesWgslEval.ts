/**
 * A small interpreter for the WGSL subset the shader-graph compiler emits
 * (helper functions + `ng_shade`). Tests use it to run compiled graphs on
 * the CPU and compare them with the automation (`execute`) path, since
 * there is no WebGPU in Node.
 *
 * Supported: `fn` / `const` declarations, `let` / `var` / `const`,
 * assignment (incl. compound, swizzle / index targets, `++`), `if` / `else`,
 * `for`, `while`, `loop`, `break`, `continue`, `return`; scalar and vector
 * arithmetic with WGSL splatting rules; swizzles; the common built-ins.
 * f32 maths runs in double precision (compare with a tolerance).
 */

type Kind = "f" | "i" | "u" | "b" | "a"; // a = abstract-int literal

export interface WVec {
  readonly t: "vec";
  readonly k: Kind;
  readonly c: number[];
}
interface WStruct {
  readonly t: "struct";
  readonly f: Record<string, WVal>;
}
interface WArr {
  readonly t: "arr";
  readonly items: WVal[];
}
export type WVal = WVec | WStruct | WArr;
export type NativeFn = (args: WVal[]) => WVal;

export const vec = (k: Kind, c: number[]): WVec => ({ t: "vec", k, c });
export const f32v = (...c: number[]): WVec => vec("f", c);

// ─── Tokenizer ────────────────────────────────────────────────────────────────

type Tok = { kind: "num" | "id" | "op"; s: string };

const TOKEN =
  /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(\d+\.\d*(?:[eE][+-]?\d+)?[fh]?|\.\d+(?:[eE][+-]?\d+)?[fh]?|\d+[eE][+-]?\d+[fh]?|0[xX][0-9a-fA-F]+[iu]?|\d+[iuf]?)|([A-Za-z_]\w*)|(->|\+\+|--|\+=|-=|\*=|\/=|%=|&&|\|\||==|!=|<=|>=|[-+*/%<>=!(){}[\],;:.&|@^~])/y;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`WGSL eval: bad character at ${at}: ${src.slice(at, at + 20)}`);
    if (m[1]) out.push({ kind: "num", s: m[1] });
    else if (m[2]) out.push({ kind: "id", s: m[2] });
    else if (m[3]) out.push({ kind: "op", s: m[3] });
  }
  return out;
}

// ─── AST ──────────────────────────────────────────────────────────────────────

type Expr =
  | { e: "num"; v: WVec }
  | { e: "id"; name: string }
  | { e: "un"; op: string; a: Expr }
  | { e: "bin"; op: string; a: Expr; b: Expr }
  | { e: "call"; name: string; args: Expr[] }
  | { e: "mem"; a: Expr; name: string }
  | { e: "idx"; a: Expr; i: Expr };

type Stmt =
  | { s: "decl"; name: string; mutable: boolean; init: Expr }
  | { s: "assign"; target: Expr; op: string; value: Expr }
  | { s: "expr"; value: Expr }
  | { s: "if"; cond: Expr; then: Stmt[]; else: Stmt[] | null }
  | { s: "for"; init: Stmt | null; cond: Expr | null; update: Stmt | null; body: Stmt[] }
  | { s: "while"; cond: Expr; body: Stmt[] }
  | { s: "loop"; body: Stmt[] }
  | { s: "break" }
  | { s: "continue" }
  | { s: "return"; value: Expr | null }
  | { s: "block"; body: Stmt[] };

interface FnDecl {
  params: string[];
  body: Stmt[];
}

const PREC: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "<": 7,
  ">": 7,
  "<=": 7,
  ">=": 7,
  "+": 8,
  "-": 8,
  "*": 9,
  "/": 9,
  "%": 9,
};

class Parser {
  private p = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(o = 0): Tok | undefined {
    return this.toks[this.p + o];
  }
  private next(): Tok {
    const t = this.toks[this.p++];
    if (!t) throw new Error("WGSL eval: unexpected end of input");
    return t;
  }
  private is(s: string, o = 0): boolean {
    return this.peek(o)?.s === s;
  }
  private eat(s: string): boolean {
    if (this.is(s)) {
      this.p++;
      return true;
    }
    return false;
  }
  private expect(s: string): void {
    const t = this.next();
    if (t.s !== s) throw new Error(`WGSL eval: expected "${s}", got "${t.s}"`);
  }
  get done(): boolean {
    return this.p >= this.toks.length;
  }

  /** Skip a type annotation (stops at `stop` tokens outside `<>`). */
  private skipType(stops: string[]): void {
    let depth = 0;
    while (!this.done) {
      const s = this.peek()!.s;
      if (depth === 0 && stops.includes(s)) return;
      if (s === "<") depth++;
      if (s === ">") depth--;
      this.p++;
    }
  }

  module(): { fns: Map<string, FnDecl>; consts: [string, Expr][]; structs: Map<string, string[]> } {
    const fns = new Map<string, FnDecl>();
    const consts: [string, Expr][] = [];
    const structs = new Map<string, string[]>();
    while (!this.done) {
      if (this.eat("@")) {
        // attribute: @x or @x(...)
        this.next();
        if (this.is("(")) this.skipParens();
        continue;
      }
      const t = this.next();
      if (t.s === "fn") {
        const name = this.next().s;
        this.expect("(");
        const params: string[] = [];
        while (!this.eat(")")) {
          params.push(this.next().s);
          this.expect(":");
          this.skipType([",", ")"]);
          this.eat(",");
        }
        if (this.eat("->")) this.skipType(["{"]);
        fns.set(name, { params, body: this.block() });
      } else if (t.s === "const" || t.s === "override") {
        const name = this.next().s;
        if (this.eat(":")) this.skipType(["="]);
        this.expect("=");
        consts.push([name, this.expr()]);
        this.expect(";");
      } else if (t.s === "struct") {
        const name = this.next().s;
        this.expect("{");
        const fields: string[] = [];
        while (!this.eat("}")) {
          if (this.eat("@")) {
            this.next();
            if (this.is("(")) this.skipParens();
            continue;
          }
          fields.push(this.next().s);
          this.expect(":");
          this.skipType([",", "}"]);
          this.eat(",");
        }
        structs.set(name, fields);
        this.eat(";");
      } else if (t.s === "var") {
        // module-scope resource: skip to ;
        while (!this.eat(";")) this.next();
      } else if (t.s === ";") {
        continue;
      } else {
        throw new Error(`WGSL eval: unexpected top-level token "${t.s}"`);
      }
    }
    return { fns, consts, structs };
  }

  private skipParens(): void {
    let d = 0;
    do {
      const s = this.next().s;
      if (s === "(") d++;
      if (s === ")") d--;
    } while (d > 0);
  }

  block(): Stmt[] {
    this.expect("{");
    const out: Stmt[] = [];
    while (!this.eat("}")) out.push(this.stmt());
    return out;
  }

  /** A statement without its trailing `;` handling for `for` headers. */
  private simple(): Stmt {
    const t = this.peek()!;
    if (t.s === "let" || t.s === "var" || t.s === "const") {
      this.p++;
      const name = this.next().s;
      if (this.eat(":")) this.skipType(["="]);
      this.expect("=");
      return { s: "decl", name, mutable: t.s === "var", init: this.expr() };
    }
    const target = this.expr();
    if (this.eat("++")) return { s: "assign", target, op: "+", value: { e: "num", v: vec("a", [1]) } };
    if (this.eat("--")) return { s: "assign", target, op: "-", value: { e: "num", v: vec("a", [1]) } };
    for (const op of ["=", "+=", "-=", "*=", "/=", "%="]) {
      if (this.eat(op)) return { s: "assign", target, op: op === "=" ? "" : op[0], value: this.expr() };
    }
    return { s: "expr", value: target };
  }

  stmt(): Stmt {
    const t = this.peek()!;
    switch (t.s) {
      case "{":
        return { s: "block", body: this.block() };
      case "return": {
        this.p++;
        const value = this.is(";") ? null : this.expr();
        this.expect(";");
        return { s: "return", value };
      }
      case "break":
      case "continue":
        this.p++;
        this.expect(";");
        return { s: t.s };
      case "if": {
        this.p++;
        const cond = this.expr();
        const then = this.block();
        let els: Stmt[] | null = null;
        if (this.eat("else")) els = this.is("if") ? [this.stmt()] : this.block();
        return { s: "if", cond, then, else: els };
      }
      case "for": {
        this.p++;
        this.expect("(");
        const init = this.is(";") ? null : this.simple();
        this.expect(";");
        const cond = this.is(";") ? null : this.expr();
        this.expect(";");
        const update = this.is(")") ? null : this.simple();
        this.expect(")");
        return { s: "for", init, cond, update, body: this.block() };
      }
      case "while": {
        this.p++;
        const cond = this.expr();
        return { s: "while", cond, body: this.block() };
      }
      case "loop":
        this.p++;
        return { s: "loop", body: this.block() };
      default: {
        const s = this.simple();
        this.expect(";");
        return s;
      }
    }
  }

  expr(minPrec = 0): Expr {
    let left = this.unary();
    for (;;) {
      const op = this.peek()?.s;
      const prec = op !== undefined ? PREC[op] : undefined;
      if (prec === undefined || prec <= minPrec) return left;
      this.p++;
      left = { e: "bin", op: op!, a: left, b: this.expr(prec) };
    }
  }

  private unary(): Expr {
    if (this.eat("-")) return { e: "un", op: "-", a: this.unary() };
    if (this.eat("!")) return { e: "un", op: "!", a: this.unary() };
    if (this.eat("~")) return { e: "un", op: "~", a: this.unary() };
    return this.postfix(this.primary());
  }

  private primary(): Expr {
    const t = this.next();
    if (t.kind === "num") return { e: "num", v: parseNumber(t.s) };
    if (t.s === "(") {
      const e = this.expr();
      this.expect(")");
      return e;
    }
    if (t.kind === "id") {
      if (t.s === "true" || t.s === "false") return { e: "num", v: vec("b", [t.s === "true" ? 1 : 0]) };
      let name = t.s;
      // Templated constructors: vec2<f32>(…)
      if (this.is("<") && /^(vec[234]|array|mat\d+x\d+)$/.test(name)) {
        this.p++;
        let inner = "";
        let d = 1;
        while (d > 0) {
          const s = this.next().s;
          if (s === "<") d++;
          else if (s === ">") d--;
          if (d > 0) inner += s;
        }
        name = `${name}<${inner}>`;
      }
      if (this.eat("(")) {
        const args: Expr[] = [];
        while (!this.eat(")")) {
          args.push(this.expr());
          this.eat(",");
        }
        return { e: "call", name, args };
      }
      return { e: "id", name };
    }
    throw new Error(`WGSL eval: unexpected token "${t.s}"`);
  }

  private postfix(e: Expr): Expr {
    for (;;) {
      if (this.eat(".")) e = { e: "mem", a: e, name: this.next().s };
      else if (this.eat("[")) {
        const i = this.expr();
        this.expect("]");
        e = { e: "idx", a: e, i };
      } else return e;
    }
  }
}

function parseNumber(s: string): WVec {
  const suffix = s[s.length - 1];
  if (/^0[xX]/.test(s)) {
    return vec(suffix === "u" ? "u" : suffix === "i" ? "i" : "a", [parseInt(s.replace(/[iu]$/, ""), 16)]);
  }
  if (suffix === "i") return vec("i", [parseInt(s, 10)]);
  if (suffix === "u") return vec("u", [parseInt(s, 10)]);
  if (suffix === "f" || suffix === "h") return vec("f", [parseFloat(s)]);
  if (/[.eE]/.test(s)) return vec("f", [parseFloat(s)]);
  return vec("a", [parseInt(s, 10)]);
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

class Scope {
  private readonly vars = new Map<string, { v: WVal; mutable: boolean }>();
  constructor(readonly parent: Scope | null) {}
  get(name: string): WVal | undefined {
    return this.vars.get(name)?.v ?? this.parent?.get(name);
  }
  declare(name: string, v: WVal, mutable: boolean): void {
    this.vars.set(name, { v, mutable });
  }
  set(name: string, v: WVal): void {
    const slot = this.vars.get(name);
    if (slot) {
      if (!slot.mutable) throw new Error(`WGSL eval: assignment to immutable "${name}"`);
      slot.v = v;
      return;
    }
    if (!this.parent) throw new Error(`WGSL eval: unknown variable "${name}"`);
    this.parent.set(name, v);
  }
}

class Return {
  constructor(readonly v: WVal | null) {}
}
const BREAK = Symbol("break");
const CONTINUE = Symbol("continue");

const asVec = (v: WVal): WVec => {
  if (v.t !== "vec") throw new Error("WGSL eval: expected a scalar / vector");
  return v;
};
const scalar = (v: WVal): number => {
  const x = asVec(v);
  if (x.c.length !== 1) throw new Error("WGSL eval: expected a scalar");
  return x.c[0];
};
const truthy = (v: WVal): boolean => scalar(v) !== 0;

function joinKind(a: Kind, b: Kind): Kind {
  if (a === b) return a;
  if (a === "a") return b;
  if (b === "a") return a;
  if (a === "f" || b === "f") return "f";
  return a;
}

function coerce(k: Kind, x: number): number {
  switch (k) {
    case "i":
    case "a":
      return Math.trunc(x) | 0;
    case "u":
      return Math.trunc(x) >>> 0;
    case "b":
      return x !== 0 ? 1 : 0;
    default:
      return x;
  }
}

/** Component-wise map with scalar splatting. */
function zip(args: WVec[], k: Kind, fn: (...xs: number[]) => number): WVec {
  const n = Math.max(...args.map((a) => a.c.length));
  for (const a of args) {
    if (a.c.length !== 1 && a.c.length !== n) throw new Error("WGSL eval: vector size mismatch");
  }
  const c: number[] = [];
  for (let i = 0; i < n; i++) c.push(fn(...args.map((a) => (a.c.length === 1 ? a.c[0] : a.c[i]))));
  return vec(k, c);
}

const kindOf = (args: WVec[]): Kind => args.map((a) => a.k).reduce(joinKind);
const fmap = (fn: (...xs: number[]) => number) => (args: WVal[]): WVal => {
  const vs = args.map(asVec);
  const k = kindOf(vs);
  return zip(vs, k === "a" ? "a" : k, fn);
};

/** WGSL `round`: half to even. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

const dotOf = (a: WVec, b: WVec): number => a.c.reduce((s, x, i) => s + x * b.c[i], 0);

const BUILTINS: Record<string, NativeFn> = {
  abs: fmap(Math.abs),
  floor: fmap(Math.floor),
  ceil: fmap(Math.ceil),
  trunc: fmap(Math.trunc),
  round: fmap(roundHalfEven),
  fract: fmap((x) => x - Math.floor(x)),
  sqrt: fmap(Math.sqrt),
  inverseSqrt: fmap((x) => 1 / Math.sqrt(x)),
  sin: fmap(Math.sin),
  cos: fmap(Math.cos),
  tan: fmap(Math.tan),
  asin: fmap(Math.asin),
  acos: fmap(Math.acos),
  atan: fmap(Math.atan),
  sinh: fmap(Math.sinh),
  cosh: fmap(Math.cosh),
  tanh: fmap(Math.tanh),
  atan2: fmap(Math.atan2),
  // GPU pow is exp2(y * log2(x)): undefined (NaN) for x < 0.
  pow: fmap((x, y) => (x < 0 ? NaN : Math.pow(x, y))),
  exp: fmap(Math.exp),
  exp2: fmap((x) => Math.pow(2, x)),
  log: fmap(Math.log),
  log2: fmap(Math.log2),
  sign: fmap(Math.sign),
  step: fmap((edge, x) => (edge <= x ? 1 : 0)),
  min: fmap(Math.min),
  max: fmap(Math.max),
  clamp: fmap((x, lo, hi) => Math.min(Math.max(x, lo), hi)),
  saturate: fmap((x) => Math.min(Math.max(x, 0), 1)),
  mix: fmap((a, b, t) => a * (1 - t) + b * t),
  smoothstep: fmap((e0, e1, x) => {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  }),
  fma: fmap((a, b, c) => a * b + c),
  radians: fmap((x) => (x * Math.PI) / 180),
  degrees: fmap((x) => (x * 180) / Math.PI),
  select: (args) => {
    const [f, t, c] = args.map(asVec);
    const k = joinKind(f.k, t.k);
    return zip([f, t, c], k, (fv, tv, cv) => (cv !== 0 ? tv : fv));
  },
  dot: (args) => {
    const [a, b] = args.map(asVec);
    return vec(joinKind(a.k, b.k) === "a" ? "a" : joinKind(a.k, b.k), [dotOf(a, b)]);
  },
  length: (args) => vec("f", [Math.sqrt(dotOf(asVec(args[0]), asVec(args[0])))]),
  distance: (args) => {
    const [a, b] = args.map(asVec);
    const d = zip([a, b], "f", (x, y) => x - y);
    return vec("f", [Math.sqrt(dotOf(d, d))]);
  },
  normalize: (args) => {
    const a = asVec(args[0]);
    const l = Math.sqrt(dotOf(a, a));
    return vec("f", a.c.map((x) => x / l));
  },
  cross: (args) => {
    const [a, b] = args.map(asVec);
    return vec("f", [
      a.c[1] * b.c[2] - a.c[2] * b.c[1],
      a.c[2] * b.c[0] - a.c[0] * b.c[2],
      a.c[0] * b.c[1] - a.c[1] * b.c[0],
    ]);
  },
  reflect: (args) => {
    const [e, n] = args.map(asVec);
    const d = dotOf(n, e);
    return vec("f", e.c.map((x, i) => x - 2 * d * n.c[i]));
  },
  all: (args) => vec("b", [asVec(args[0]).c.every((x) => x !== 0) ? 1 : 0]),
  any: (args) => vec("b", [asVec(args[0]).c.some((x) => x !== 0) ? 1 : 0]),
};

const SWIZ = "xyzw";
const SWIZ_RGBA = "rgba";

function construct(name: string, args: WVal[]): WVal | null {
  const m = /^vec([234])(?:([fiuh])|<(f32|i32|u32|bool|f16)>)$/.exec(name);
  let n: number;
  let k: Kind;
  if (m) {
    n = Number(m[1]);
    const t = m[2] ?? m[3];
    k = t === "i" || t === "i32" ? "i" : t === "u" || t === "u32" ? "u" : t === "bool" ? "b" : "f";
  } else if (name === "f32" || name === "i32" || name === "u32" || name === "bool") {
    n = 1;
    k = name === "f32" ? "f" : name === "i32" ? "i" : name === "u32" ? "u" : "b";
  } else return null;
  const comps = args.flatMap((a) => asVec(a).c);
  let c: number[];
  if (comps.length === 0) c = new Array(n).fill(0);
  else if (comps.length === 1) c = new Array(n).fill(comps[0]);
  else if (comps.length === n) c = comps;
  else throw new Error(`WGSL eval: ${name} given ${comps.length} components`);
  return vec(k, c.map((x) => coerce(k, x)));
}

function binary(op: string, a: WVal, b: WVal): WVal {
  const x = asVec(a);
  const y = asVec(b);
  const k = joinKind(x.k, y.k);
  const intLike = k === "i" || k === "u" || k === "a";
  switch (op) {
    case "+":
      return zip([x, y], k, (p, q) => coerce(k, p + q));
    case "-":
      return zip([x, y], k, (p, q) => coerce(k, p - q));
    case "*":
      return zip([x, y], k, (p, q) => coerce(k, p * q));
    case "/":
      return zip([x, y], k, (p, q) => (intLike ? (q === 0 ? p : coerce(k, Math.trunc(p / q))) : p / q));
    case "%":
      return zip([x, y], k, (p, q) => (intLike && q === 0 ? 0 : p % q));
    case "<":
      return zip([x, y], "b", (p, q) => +(p < q));
    case ">":
      return zip([x, y], "b", (p, q) => +(p > q));
    case "<=":
      return zip([x, y], "b", (p, q) => +(p <= q));
    case ">=":
      return zip([x, y], "b", (p, q) => +(p >= q));
    case "==":
      return zip([x, y], "b", (p, q) => +(p === q));
    case "!=":
      return zip([x, y], "b", (p, q) => +(p !== q));
    case "&":
      return zip([x, y], k, (p, q) => p & q);
    case "|":
      return zip([x, y], k, (p, q) => p | q);
    case "^":
      return zip([x, y], k, (p, q) => p ^ q);
    default:
      throw new Error(`WGSL eval: operator ${op}`);
  }
}

export interface WgslProgram {
  call(name: string, args: WVal[]): WVal;
}

export interface WgslEnv {
  /** Module-scope values (e.g. `ng_u`). */
  globals?: Record<string, WVal>;
  /** Host functions (e.g. `ng_load`). */
  natives?: Record<string, NativeFn>;
  /** Abort runaway loops. */
  maxIterations?: number;
}

/** Parse `code` (helpers + entry point) and return a callable program. */
export function loadWgsl(code: string, env: WgslEnv = {}): WgslProgram {
  const { fns, consts, structs } = new Parser(tokenize(code)).module();
  const maxIter = env.maxIterations ?? 1_000_000;
  const global = new Scope(null);
  for (const [k, v] of Object.entries(env.globals ?? {})) global.declare(k, v, false);

  const evalExpr = (e: Expr, sc: Scope): WVal => {
    switch (e.e) {
      case "num":
        return e.v;
      case "id": {
        const v = sc.get(e.name);
        if (!v) throw new Error(`WGSL eval: unknown identifier "${e.name}"`);
        return v;
      }
      case "un": {
        const a = asVec(evalExpr(e.a, sc));
        if (e.op === "-") return vec(a.k, a.c.map((x) => coerce(a.k, -x)));
        if (e.op === "!") return vec("b", a.c.map((x) => +(x === 0)));
        return vec(a.k, a.c.map((x) => ~x));
      }
      case "bin": {
        if (e.op === "&&") return vec("b", [+(truthy(evalExpr(e.a, sc)) && truthy(evalExpr(e.b, sc)))]);
        if (e.op === "||") return vec("b", [+(truthy(evalExpr(e.a, sc)) || truthy(evalExpr(e.b, sc)))]);
        return binary(e.op, evalExpr(e.a, sc), evalExpr(e.b, sc));
      }
      case "mem": {
        const a = evalExpr(e.a, sc);
        if (a.t === "struct") {
          const f = a.f[e.name];
          if (!f) throw new Error(`WGSL eval: no field ${e.name}`);
          return f;
        }
        const v = asVec(a);
        const set = SWIZ.includes(e.name[0]) ? SWIZ : SWIZ_RGBA;
        const idx = [...e.name].map((ch) => {
          const i = set.indexOf(ch);
          if (i < 0 || i >= v.c.length) throw new Error(`WGSL eval: bad swizzle .${e.name}`);
          return i;
        });
        return vec(v.k, idx.map((i) => v.c[i]));
      }
      case "idx": {
        const a = evalExpr(e.a, sc);
        const i = scalar(evalExpr(e.i, sc));
        if (a.t === "arr") {
          const item = a.items[i];
          if (!item) throw new Error(`WGSL eval: index ${i} out of bounds`);
          return item;
        }
        const v = asVec(a);
        if (i < 0 || i >= v.c.length) throw new Error(`WGSL eval: index ${i} out of bounds`);
        return vec(v.k, [v.c[i]]);
      }
      case "call": {
        const args = e.args.map((x) => evalExpr(x, sc));
        return callFn(e.name, args);
      }
    }
  };

  const callFn = (name: string, args: WVal[]): WVal => {
    const user = fns.get(name);
    if (user) {
      const sc = new Scope(global);
      user.params.forEach((p, i) => sc.declare(p, args[i], false));
      try {
        runBlock(user.body, sc);
      } catch (r) {
        if (r instanceof Return) return r.v ?? vec("f", []);
        throw r;
      }
      throw new Error(`WGSL eval: ${name} returned no value`);
    }
    const fields = structs.get(name);
    if (fields) return { t: "struct", f: Object.fromEntries(fields.map((f, i) => [f, args[i]])) };
    const native = env.natives?.[name] ?? BUILTINS[name];
    if (native) return native(args);
    const ctor = construct(name, args);
    if (ctor) return ctor;
    throw new Error(`WGSL eval: unknown function "${name}"`);
  };

  const assign = (target: Expr, value: WVal, sc: Scope): void => {
    if (target.e === "id") {
      sc.set(target.name, value);
      return;
    }
    if (target.e === "mem" || target.e === "idx") {
      const base = asVec(evalExpr(target.a, sc));
      const c = [...base.c];
      const val = asVec(value);
      if (target.e === "idx") c[scalar(evalExpr(target.i, sc))] = coerce(base.k, val.c[0]);
      else {
        const set = SWIZ.includes(target.name[0]) ? SWIZ : SWIZ_RGBA;
        [...target.name].forEach((ch, i) => {
          c[set.indexOf(ch)] = coerce(base.k, val.c.length === 1 ? val.c[0] : val.c[i]);
        });
      }
      assign(target.a, vec(base.k, c), sc);
      return;
    }
    throw new Error("WGSL eval: bad assignment target");
  };

  const runStmt = (st: Stmt, sc: Scope): void => {
    switch (st.s) {
      case "decl":
        sc.declare(st.name, evalExpr(st.init, sc), st.mutable);
        return;
      case "assign": {
        let v = evalExpr(st.value, sc);
        if (st.op) v = binary(st.op, evalExpr(st.target, sc), v);
        const cur = evalExpr(st.target, sc);
        if (cur.t === "vec") v = vec(cur.k, asVec(v).c.map((x) => coerce(cur.k, x)));
        assign(st.target, v, sc);
        return;
      }
      case "expr":
        evalExpr(st.value, sc);
        return;
      case "block":
        runBlock(st.body, new Scope(sc));
        return;
      case "if":
        if (truthy(evalExpr(st.cond, sc))) runBlock(st.then, new Scope(sc));
        else if (st.else) runBlock(st.else, new Scope(sc));
        return;
      case "return":
        throw new Return(st.value ? evalExpr(st.value, sc) : null);
      case "break":
        throw BREAK;
      case "continue":
        throw CONTINUE;
      case "for": {
        const outer = new Scope(sc);
        if (st.init) runStmt(st.init, outer);
        let n = 0;
        while (!st.cond || truthy(evalExpr(st.cond, outer))) {
          if (++n > maxIter) throw new Error("WGSL eval: loop limit");
          if (loopBody(st.body, outer)) break;
          if (st.update) runStmt(st.update, outer);
        }
        return;
      }
      case "while": {
        let n = 0;
        while (truthy(evalExpr(st.cond, sc))) {
          if (++n > maxIter) throw new Error("WGSL eval: loop limit");
          if (loopBody(st.body, sc)) break;
        }
        return;
      }
      case "loop": {
        let n = 0;
        for (;;) {
          if (++n > maxIter) throw new Error("WGSL eval: loop limit");
          if (loopBody(st.body, sc)) break;
        }
        return;
      }
    }
  };

  /** Runs one iteration; true when the loop should stop. */
  const loopBody = (body: Stmt[], sc: Scope): boolean => {
    try {
      runBlock(body, new Scope(sc));
    } catch (sig) {
      if (sig === BREAK) return true;
      if (sig === CONTINUE) return false;
      throw sig;
    }
    return false;
  };

  const runBlock = (body: Stmt[], sc: Scope): void => {
    for (const st of body) runStmt(st, sc);
  };

  for (const [name, e] of consts) global.declare(name, evalExpr(e, global), false);

  return { call: callFn };
}

// ─── Shader-graph host ───────────────────────────────────────────────────────

export interface ShadeInput {
  uv?: readonly [number, number];
  pixel?: readonly [number, number];
  src?: readonly [number, number, number, number];
  /** Texel fetch of the shaded layer (defaults to `src` everywhere). */
  load?: (x: number, y: number) => readonly [number, number, number, number];
  natives?: Record<string, NativeFn>;
  /** Extra module-scope values (e.g. layer-source textures). */
  globals?: Record<string, WVal>;
}

/**
 * Run a compiled shader graph (`ShaderCompileResult.code` + `uniforms`) for
 * one pixel, the way the host fragment shader would.
 */
export function shadePixel(code: string, uniforms: Float32Array, input: ShadeInput = {}): number[] {
  const slots: WVal[] = [];
  for (let i = 0; i < uniforms.length; i += 4) slots.push(f32v(...uniforms.slice(i, i + 4)));
  const src = input.src ?? [0, 0, 0, 1];
  const load = input.load ?? (() => src);
  // Intermediate pass textures (`ng_pass{k}`): by default a 1×1 image of
  // `src` (override textureLoad / textureDimensions to give them content).
  const passes = Object.fromEntries(
    [...new Set(code.match(/\bng_pass\d+\b/g) ?? [])].map((name): [string, WVal] => [name, f32v(0)]),
  );
  const passNatives: Record<string, NativeFn> =
    Object.keys(passes).length > 0
      ? { textureDimensions: () => vec("u", [1, 1]), textureLoad: () => f32v(...src) }
      : {};
  const program = loadWgsl(code, {
    globals: { ng_u: { t: "struct", f: { v: { t: "arr", items: slots } } }, ...passes, ...input.globals },
    natives: {
      ng_load: (args) => {
        const p = asVec(args[0]).c;
        return f32v(...load(p[0], p[1]));
      },
      ...passNatives,
      ...input.natives,
    },
  });
  const out = program.call("ng_shade", [
    f32v(...(input.uv ?? [0.5, 0.5])),
    f32v(...(input.pixel ?? [0.5, 0.5])),
    f32v(...src),
  ]);
  return [...asVec(out).c];
}
