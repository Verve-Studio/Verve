import { dockStore } from "@/ux/main/RightPanel/Dock/dockStore";
import { nodeEditorStore } from "@/ux/main/NodeEditor/nodeEditorStore";

/** Show a Custom Shader layer's graph in the node editor. */
export function openShaderGraph(layerId: string): void {
  nodeEditorStore.openShaderLayer(layerId);
  dockStore.setNodeEditorOpen(true);
}
