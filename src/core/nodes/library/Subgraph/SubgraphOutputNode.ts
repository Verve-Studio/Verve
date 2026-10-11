import type { INode, NodePorts, PortScope, ShaderContext, ShaderOutputs } from "../../INode";
import type { ParamValue } from "../../graphTypes";
import { SUBGRAPH_OUTPUT, outputBoundaryPorts, specOfBody } from "../../subgraphs";

/**
 * Where results leave a subgraph body (e.g. "Loop End"). Generic for every
 * subgraph kind: one input per outgoing interface socket.
 */
class SubgraphOutputNode implements INode {
  readonly type = SUBGRAPH_OUTPUT;
  readonly label = "Subgraph Output";
  readonly category = "Subgraph";
  readonly domains = ["shader"] as const;
  readonly boundary = "output";
  readonly width = 170;
  readonly inputs = [];
  readonly outputs = [];

  ports(_params: Readonly<Record<string, ParamValue>>, scope: PortScope): NodePorts {
    const spec = specOfBody(scope.graph);
    const sockets = scope.graph?.subgraph?.sockets;
    return spec && sockets ? outputBoundaryPorts(sockets) : this;
  }

  title(scope: PortScope): string {
    return specOfBody(scope.graph)?.outputTitle ?? this.label;
  }

  generateShader(ctx: ShaderContext): ShaderOutputs {
    ctx.setBodyOutputs(Object.fromEntries(ctx.ports.inputs.map((p) => [p.id, ctx.input(p.id)])));
    return {};
  }
}

export const subgraphOutputNode: INode = new SubgraphOutputNode();
