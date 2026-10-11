import type {
  INode,
  NodePorts,
  PortScope,
  ShaderContext,
  ShaderOutputs,
  SubgraphSpec,
} from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { ownerPorts } from "../../subgraphs";
import { wgslType } from "../../wgsl";

/** Hard cap on iterations: a runaway loop would hang the GPU. */
export const MAX_LOOP_ITERATIONS = 1024;

const SPEC: SubgraphSpec = {
  inputTitle: "Loop Start",
  outputTitle: "Loop End",
  socketsLabel: "Loop values",
  // Loop values are carried: in as the start value, out as the final value.
  directions: ["both"],
  types: ["float", "int", "bool", "vec2", "vec3", "color"],
  ownerInputs: [
    {
      id: "count",
      label: "Count",
      type: "int",
      value: { kind: "int", default: 8, min: 0, max: MAX_LOOP_ITERATIONS },
    },
  ],
  bodyInputs: [
    { id: "index", label: "Index", type: "int" },
    { id: "count", label: "Count", type: "int" },
  ],
  defaultSockets: [{ name: "Color", type: "color", direction: "both" }],
};

/**
 * `for (index = 0; index < Count; index++) { body }` with loop values.
 *
 * Each loop value starts at the value given on this node. Inside the body
 * (double-click to open), Loop Start provides Index, Count and the current
 * loop values; whatever is linked into Loop End becomes the value for the
 * next iteration (unlinked = unchanged). This node's outputs are the values
 * after the last iteration.
 */
class ForLoopNode implements INode {
  readonly type = "forLoop";
  readonly label = "For Loop";
  readonly category = "Loop";
  readonly domains = ["shader"] as const;
  readonly description =
    "Runs its body Count times, carrying loop values from one iteration to the next. Double-click to edit the body.";
  readonly width = 200;
  readonly subgraph = SPEC;
  readonly inputs = ownerPorts(SPEC).inputs;
  readonly outputs = ownerPorts(SPEC).outputs;

  ports(_params: Readonly<Record<string, ParamValue>>, scope: PortScope): NodePorts {
    return ownerPorts(SPEC, scope.node.body?.subgraph?.sockets);
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const count = ctx.local(
      "i32",
      `clamp(i32(${ctx.input("count") ?? "0.0"}), 0, ${MAX_LOOP_ITERATIONS})`,
    );
    const values = ctx.sockets.map((s) => {
      const t = wgslType(s.type);
      if (!t) throw new Error(`${s.name}: ${s.type} values can't be looped in a shader`);
      return { id: s.id, type: t, v: ctx.variable(t, ctx.input(s.id) ?? `${t}()`) };
    });

    const i = ctx.name("i");
    ctx.block(`for (var ${i}: i32 = 0; ${i} < ${count}; ${i}++)`, () => {
      const next = ctx.compileBody({
        index: `f32(${i})`,
        count: `f32(${count})`,
        ...Object.fromEntries(values.map((x) => [x.id, x.v])),
      });
      // Evaluate every next value before assigning any: they may read
      // each other's current value.
      const updates = values.flatMap((x) => {
        const expr = next[x.id];
        return expr ? [[x.v, ctx.local(x.type, expr)]] : [];
      });
      for (const [v, n] of updates) ctx.statement(`${v} = ${n};`);
    });

    return Object.fromEntries(values.map((x) => [x.id, x.v]));
  }
}

export const forLoopNode: INode = new ForLoopNode();
