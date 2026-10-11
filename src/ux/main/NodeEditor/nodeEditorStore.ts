/**
 * UI scratchpad for the node editor: which domain is shown, which Custom
 * Shader layer the Shader tab edits, and the editable documents.
 *
 * A shader graph belongs to its Custom Shader layer (`params.graph`); the
 * document here is only the editing session (graph-level undo, viewport)
 * and is kept in sync with the layer by `ShaderLayerEditor`. The automation
 * workflow is an in-memory scratch graph until workflows can be saved.
 */
import "@/core/nodes";
import { nodeRegistry } from "@/core/nodes/nodeRegistry";
import { NodeGraphDocument } from "@/core/nodes/NodeGraphDocument";
import { createNode } from "@/core/nodes/graphOps";
import { newGraphId, type GraphDomain, type NodeGraph } from "@/core/nodes/graphTypes";

class NodeEditorStore {
  private _domain: GraphDomain = "shader";
  private _shaderLayerId: string | null = null;
  private _propertiesOpen = true;
  private _automation: NodeGraphDocument | null = null;
  private _layerDocs = new Map<string, NodeGraphDocument>();
  private _listeners = new Set<() => void>();

  readonly subscribe = (fn: () => void): (() => void) => {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  };

  readonly getDomain = (): GraphDomain => this._domain;

  /** Custom Shader layer the Shader tab edits. */
  readonly getShaderLayerId = (): string | null => this._shaderLayerId;

  /** Whether the shader editor shows its properties panel. */
  readonly getPropertiesOpen = (): boolean => this._propertiesOpen;

  setPropertiesOpen(open: boolean): void {
    if (open === this._propertiesOpen) return;
    this._propertiesOpen = open;
    this._emit();
  }

  setDomain(domain: GraphDomain): void {
    if (domain === this._domain) return;
    this._domain = domain;
    this._emit();
  }

  /** Show the Shader tab editing `layerId`'s graph. */
  openShaderLayer(layerId: string): void {
    if (this._domain === "shader" && this._shaderLayerId === layerId) return;
    this._domain = "shader";
    this._shaderLayerId = layerId;
    this._emit();
  }

  /** Editing session for a layer's graph, created from `graph` on first use. */
  layerDocument(layerId: string, graph: NodeGraph): NodeGraphDocument {
    let doc = this._layerDocs.get(layerId);
    if (!doc) {
      doc = new NodeGraphDocument(graph);
      this._layerDocs.set(layerId, doc);
    }
    return doc;
  }

  automationDocument(): NodeGraphDocument {
    this._automation ??= new NodeGraphDocument({
      id: newGraphId(),
      name: "Workflow",
      domain: "automation",
      nodes: [createNode(nodeRegistry.get("onRun")!, 0, 0)],
      edges: [],
    });
    return this._automation;
  }

  private _emit(): void {
    this._listeners.forEach((fn) => fn());
  }
}

export const nodeEditorStore = new NodeEditorStore();
