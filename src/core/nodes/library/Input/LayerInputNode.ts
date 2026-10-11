import type {
  INode,
  NodePorts,
  PortDef,
  PortScope,
  ShaderContext,
  ShaderOutputs,
} from "../../INode";
import type { GraphArgument, ParamValue } from "../../graphTypes";

const BASE_OUTPUTS: readonly PortDef[] = [
  { id: "color", label: "Color", type: "color" },
  { id: "alpha", label: "Alpha", type: "float" },
];

// Argument lists are immutable: memoize the ports on them.
const portsByArguments = new WeakMap<readonly GraphArgument[], NodePorts>();

/**
 * The start node of a shader graph: the layer's pixel, plus one output per
 * effect argument (`NodeGraph.arguments`, defined in the shader editor's
 * properties panel and set per layer in the effect's settings window).
 */
class LayerInputNode implements INode {
  readonly type = "layerInput";
  readonly label = "Layer Input";
  readonly category = "Input";
  readonly domains = ["shader"] as const;
  readonly description = "The layer's pixel at the current position, and the effect's arguments.";
  readonly inputs = [];
  readonly outputs = BASE_OUTPUTS;
  readonly unique = true;

  ports(_params: Readonly<Record<string, ParamValue>>, scope: PortScope): NodePorts {
    const args = scope.graph?.arguments;
    if (!args || args.length === 0) return this;
    let ports = portsByArguments.get(args);
    if (!ports) {
      ports = {
        inputs: [],
        outputs: [...BASE_OUTPUTS, ...args.map((a): PortDef => ({ id: a.id, label: a.name, type: a.type }))],
      };
      portsByArguments.set(args, ports);
    }
    return ports;
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    const out: Record<string, string> = { color: ctx.source, alpha: `${ctx.source}.a` };
    for (const p of ctx.ports.outputs) {
      if (p.id !== "color" && p.id !== "alpha") out[p.id] = ctx.argument(p.id);
    }
    return out;
  }
}

export const layerInputNode: INode = new LayerInputNode();
