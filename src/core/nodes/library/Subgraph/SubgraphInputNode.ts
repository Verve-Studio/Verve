import type { INode, NodePorts, PortScope, ShaderContext, ShaderOutputs } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { SUBGRAPH_INPUT, inputBoundaryPorts, specOfBody } from "../../subgraphs";

/**
 * Where values enter a subgraph body (e.g. "Loop Start"). Generic for every
 * subgraph kind: its outputs are the kind's fixed body inputs (Index, …)
 * plus the interface sockets, and its title comes from the kind's spec.
 */
class SubgraphInputNode implements INode {
  readonly type = SUBGRAPH_INPUT;
  readonly label = "Subgraph Input";
  readonly category = "Subgraph";
  readonly domains = ["shader"] as const;
  readonly boundary = "input";
  readonly width = 170;
  readonly inputs = [];
  readonly outputs = [];

  ports(_params: Readonly<Record<string, ParamValue>>, scope: PortScope): NodePorts {
    const spec = specOfBody(scope.graph);
    const sockets = scope.graph?.subgraph?.sockets;
    return spec && sockets ? inputBoundaryPorts(spec, sockets) : this;
  }

  title(scope: PortScope): string {
    return specOfBody(scope.graph)?.inputTitle ?? this.label;
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    return ctx.bodyInputs();
  }
}

export const subgraphInputNode: INode = new SubgraphInputNode();
