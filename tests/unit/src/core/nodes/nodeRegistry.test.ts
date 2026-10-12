/**
 * Invariants every registered node type must satisfy — including the
 * provider-generated effect nodes (one per registered effect).
 */
import { describe, expect, it } from "vitest";
import "@/core/effects";
import "@/core/nodes";
import { effectRegistry } from "@/core/effects/effectRegistry";
import { nodeRegistry } from "@/core/nodes/nodeRegistry";
import { createNode, nodePorts } from "@/core/nodes/graphOps";
import { isKernelValue, type ParamValue } from "@/core/nodes/graphTypes";
import type { INode, ParamSpec, PortDef } from "@/core/nodes/INode";

const allNodes = (): INode[] => {
  const byType = new Map<string, INode>();
  for (const n of [...nodeRegistry.forDomain("shader"), ...nodeRegistry.forDomain("automation")]) {
    byType.set(n.type, n);
  }
  return [...byType.values()];
};

function fits(v: ParamValue, spec: ParamSpec): boolean {
  switch (spec.kind) {
    case "float":
      return typeof v === "number" && Number.isFinite(v);
    case "int":
      return typeof v === "number" && Number.isInteger(v);
    case "bool":
      return typeof v === "boolean";
    case "enum":
      return typeof v === "string" && spec.options.some((o) => o.value === v);
    case "string":
      return typeof v === "string";
    case "color":
      return Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number");
    case "vec2":
      return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number");
    case "kernel":
      return isKernelValue(v) && v.weights.length === v.size * v.size;
  }
}

function inRange(v: ParamValue, spec: ParamSpec): boolean {
  if ((spec.kind !== "float" && spec.kind !== "int") || typeof v !== "number") return true;
  return (spec.min === undefined || v >= spec.min) && (spec.max === undefined || v <= spec.max);
}

const enumParams = (def: INode) => (def.params ?? []).filter((p) => p.spec.kind === "enum");

/** Every single-enum variation of the node's params (others at default). */
function configurations(def: INode): Record<string, ParamValue>[] {
  const out: Record<string, ParamValue>[] = [{}];
  for (const p of enumParams(def)) {
    if (p.spec.kind !== "enum") continue;
    for (const o of p.spec.options) out.push({ [p.id]: o.value });
  }
  return out;
}

const nodes = allNodes();

describe("node registry", () => {
  it("has nodes for both domains", () => {
    expect(nodeRegistry.forDomain("shader").length).toBeGreaterThan(20);
    expect(nodeRegistry.forDomain("automation").length).toBeGreaterThan(50);
  });

  it("generates exactly one automation node per registered effect (except Custom Shader)", () => {
    const effects = effectRegistry.all().filter((e) => e.id !== "custom-shader");
    expect(effects.length).toBeGreaterThan(10);
    for (const e of effects) {
      const node = nodeRegistry.get(`effect.${e.id}`);
      expect(node, e.id).toBeDefined();
      expect(node!.domains).toEqual(["automation"]);
      // Stable identity: lookups return the same object.
      expect(nodeRegistry.get(`effect.${e.id}`)).toBe(node);
    }
    expect(nodeRegistry.get("effect.custom-shader")).toBeUndefined();
  });

  it("rejects duplicate types and domains without their method", () => {
    const base = { label: "X", category: "Test", inputs: [], outputs: [] };
    expect(() => nodeRegistry.register({ ...base, type: "math", domains: ["automation"], execute: () => {} })).toThrow(
      /registered twice/,
    );
    expect(() => nodeRegistry.register({ ...base, type: "__test_noShader", domains: ["shader"] })).toThrow(
      /generateShader/,
    );
    expect(() => nodeRegistry.register({ ...base, type: "__test_noExec", domains: ["automation"] })).toThrow(
      /execute/,
    );
    expect(nodeRegistry.get("__test_noShader")).toBeUndefined();
    expect(nodeRegistry.get("__test_noExec")).toBeUndefined();
  });

  it("returns undefined for unknown types", () => {
    expect(nodeRegistry.get("definitely-not-a-node")).toBeUndefined();
  });
});

describe.each(nodes.map((n) => [n.type, n] as const))("node %s", (_type, def) => {
  it("declares identity and domains with matching methods", () => {
    expect(def.label.length).toBeGreaterThan(0);
    expect(def.category.length).toBeGreaterThan(0);
    expect(def.domains.length).toBeGreaterThan(0);
    for (const d of def.domains) expect(["shader", "automation"]).toContain(d);
    if (def.domains.includes("shader")) expect(typeof def.generateShader).toBe("function");
    if (def.domains.includes("automation")) expect(typeof def.execute).toBe("function");
    expect(nodeRegistry.get(def.type)).toBe(def);
  });

  it("has valid parameter defaults", () => {
    const ids = new Set<string>();
    for (const p of def.params ?? []) {
      expect(ids.has(p.id), `duplicate param ${p.id}`).toBe(false);
      ids.add(p.id);
      expect(fits(p.spec.default, p.spec), `param ${p.id} default`).toBe(true);
      expect(inRange(p.spec.default, p.spec), `param ${p.id} default in range`).toBe(true);
    }
  });

  it.each(configurations(def).map((c) => [JSON.stringify(c), c] as const))(
    "has well-formed, memoised ports for %s",
    (_label, config) => {
      const node = createNode(def, 0, 0);
      const configured = { ...node, params: { ...node.params, ...config } };
      const ports = nodePorts(def, configured);
      // Same configuration, fresh params object → the very same ports.
      const again = nodePorts(def, { ...configured, params: { ...configured.params } });
      expect(again).toBe(ports);

      const check = (list: readonly PortDef[], side: string): void => {
        const seen = new Set<string>();
        for (const p of list) {
          expect(seen.has(p.id), `duplicate ${side} port ${p.id}`).toBe(false);
          seen.add(p.id);
          if (p.type === "exec") expect(def.domains, `exec port ${p.id}`).toContain("automation");
          if (p.value) {
            expect(side, `output ${p.id} has an inline value`).toBe("input");
            expect(fits(p.value.default, p.value), `inline default of ${p.id}`).toBe(true);
            expect(inRange(p.value.default, p.value), `inline default of ${p.id} in range`).toBe(true);
          }
        }
      };
      check(ports.inputs, "input");
      check(ports.outputs, "output");
      for (const id of def.requiredInputs ?? []) {
        expect(ports.inputs.some((p) => p.id === id), `required input ${id}`).toBe(true);
      }
    },
  );

  it("creates nodes with every param and inline value filled in", () => {
    const node = createNode(def, 10, 20);
    expect(node.type).toBe(def.type);
    expect([node.x, node.y]).toEqual([10, 20]);
    for (const p of def.params ?? []) expect(node.params[p.id]).toEqual(p.spec.default);
    for (const p of nodePorts(def, node).inputs) {
      if (p.value) expect(node.params[p.id], p.id).toEqual(p.value.default);
    }
    if (def.subgraph) {
      expect(node.body?.subgraph?.kind).toBe(def.type);
      expect(node.body?.subgraph?.sockets.length).toBe(def.subgraph.defaultSockets.length);
    } else {
      expect(node.body).toBeUndefined();
    }
  });
});
