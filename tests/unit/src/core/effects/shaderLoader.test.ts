// Static checks over every WGSL file and every place that names a shader by
// string: discovery by basename (shaderLoader), references that resolve to a
// real file and entry point of the right stage, basic well-formedness, and
// the documented MaskFlags uniform layout.

import { readFileSync, readdirSync, statSync } from "fs";
import { basename, join, relative, resolve } from "path";
import { describe, expect, it } from "vitest";
import { getShader } from "@/core/effects/shaderLoader";
import { WgslModule, delimiterBalance } from "@tests/fakes/effectsWgsl";
import { SRC_DIR } from "@tests/paths";

const SRC = SRC_DIR;
const EFFECTS = resolve(SRC_DIR, "core/effects");

function walk(dir: string, pred: (f: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && name !== "generated") walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

const allWgsl = walk(SRC, (f) => f.endsWith(".wgsl"));
const effectWgsl = allWgsl.filter((f) => f.startsWith(EFFECTS));
const rel = (f: string) => relative(SRC, f).replace(/\\/g, "/");
const nameOf = (f: string) => basename(f, ".wgsl");

/** Every call that names an effect-loader shader by literal, with its entry. */
interface ShaderRef {
  file: string;
  fn: string;
  shader: string;
  entry?: string;
}

function collectRefs(): ShaderRef[] {
  const sources = walk(
    SRC,
    (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts"),
  );
  const refs: ShaderRef[] = [];
  const pipelineCall =
    /\b(getRenderPipelinePair|getRenderPipelineAuto|getRenderPipelineSingle|getRenderPipelineWithBGL|getComputePipelineForStorageFormat|getComputePipeline)\(\s*["'`]([\w-]+)["'`]\s*,\s*["'`](\w+)["'`]/g;
  const shaderCall = /\bgetShader\(\s*["'`]([\w-]+)["'`]\s*\)/g;
  for (const f of sources) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(pipelineCall)) refs.push({ file: rel(f), fn: m[1], shader: m[2], entry: m[3] });
    for (const m of text.matchAll(shaderCall)) refs.push({ file: rel(f), fn: "getShader", shader: m[1] });
  }
  return refs;
}

const refs = collectRefs();

describe("shaderLoader", () => {
  it("finds a meaningful number of effect shaders and references", () => {
    expect(effectWgsl.length).toBeGreaterThan(50);
    expect(refs.length).toBeGreaterThan(50);
  });

  it("has no duplicate shader basenames under effects/", () => {
    const names = effectWgsl.map(nameOf);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it.each(effectWgsl.map((f) => [rel(f), f]))("discovers %s by basename", (_r, f) => {
    expect(getShader(nameOf(f))).toBe(readFileSync(f, "utf8"));
  });

  it("throws on an unknown shader name", () => {
    expect(() => getShader("definitely-not-a-shader")).toThrow(/unknown shader/);
  });

  it("every literal shader reference resolves to a file and an entry point of the right stage", () => {
    const problems: string[] = [];
    for (const r of refs) {
      let code: string;
      try {
        code = getShader(r.shader);
      } catch {
        problems.push(`${r.file}: ${r.fn}("${r.shader}") — no such shader`);
        continue;
      }
      if (!r.entry) continue;
      const mod = new WgslModule(code);
      const fn = mod.functions.get(r.entry);
      const wantStage = /Compute/.test(r.fn) ? "compute" : "fragment";
      if (!fn) problems.push(`${r.file}: ${r.fn}("${r.shader}", "${r.entry}") — no such entry point`);
      else if (fn.stage !== wantStage) problems.push(`${r.file}: "${r.shader}".${r.entry} is ${fn.stage}, expected ${wantStage}`);
      // EffectRuntime builds every render pipeline with the vs_adj vertex stage.
      if (wantStage === "fragment" && mod.functions.get("vs_adj")?.stage !== "vertex") {
        problems.push(`${r.file}: "${r.shader}" is used for a render pipeline but has no @vertex vs_adj`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe.each(allWgsl.map((f) => [rel(f), f]))("%s", (_r, f) => {
  const src = readFileSync(f, "utf8");
  const mod = new WgslModule(src);

  it("is structurally well-formed and declares an entry point", () => {
    expect(delimiterBalance(src)).toBeNull();
    expect(mod.entryPoints().length).toBeGreaterThan(0);
  });

  it("has resolvable layouts for every uniform it binds, with unique (group, binding) slots", () => {
    const slots = mod.bindings.map((b) => `${b.group}:${b.binding}`);
    expect(new Set(slots).size).toBe(slots.length);
    for (const b of mod.bindings.filter((x) => x.kind === "uniform")) {
      expect(mod.layout(b.type), `${b.name}: ${b.type}`).not.toBeNull();
      // The per-frame params pool rounds to 16 bytes; uniform structs are
      // 16-byte aligned by WGSL anyway.
      expect(mod.layout(b.type)!.size % 4).toBe(0);
    }
  });

  if (mod.structs.has("MaskFlags")) {
    it("declares MaskFlags compatible with EffectRuntime.makeMaskFlagsBuf (32 bytes: hasMask, inputIsLinear)", () => {
      const s = mod.structLayout("MaskFlags")!;
      expect(s).not.toBeNull();
      // The shared constant buffer is 32 bytes.
      expect(s.size).toBeLessThanOrEqual(32);
      expect(s.members[0]).toMatchObject({ name: "hasMask", type: "u32", offset: 0 });
      const lin = s.members.find((m) => m.name === "inputIsLinear");
      if (lin) expect(lin).toMatchObject({ type: "u32", offset: 4 });
      // Anything else is padding.
      for (const m of s.members.slice(1)) {
        if (m.name !== "inputIsLinear") expect(m.name.startsWith("_"), `MaskFlags.${m.name}`).toBe(true);
      }
    });
  }
});
