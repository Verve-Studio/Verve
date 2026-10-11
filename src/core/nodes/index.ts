// Importing `@/core/nodes` registers every node. Adding a node is one file
// under `library/{Category}/` plus one line here.
import { nodeRegistry } from "./nodeRegistry";
import { layerInputNode } from "./library/Input/LayerInputNode";
import { sampleLayerNode } from "./library/Input/SampleLayerNode";
import { uvNode } from "./library/Input/UvNode";
import { valueNode } from "./library/Input/ValueNode";
import { colorNode } from "./library/Input/ColorNode";
import { textNode } from "./library/Input/TextNode";
import { mathNode } from "./library/Math/MathNode";
import { clampNode } from "./library/Math/ClampNode";
import { mapRangeNode } from "./library/Math/MapRangeNode";
import { compareNode } from "./library/Logic/CompareNode";
import { booleanMathNode } from "./library/Logic/BooleanMathNode";
import { ifElseNode } from "./library/Logic/IfElseNode";
import { forLoopNode } from "./library/Loop/ForLoopNode";
import { subgraphInputNode } from "./library/Subgraph/SubgraphInputNode";
import { subgraphOutputNode } from "./library/Subgraph/SubgraphOutputNode";
import { documentInfoNode } from "./library/Info/DocumentInfoNode";
import { layerInfoNode } from "./library/Info/LayerInfoNode";
import { layerPropertiesNode } from "./library/Info/LayerPropertiesNode";
import { uvTransformNode } from "./library/Vector/UvTransformNode";
import { vectorMathNode } from "./library/Vector/VectorMathNode";
import { separateXyNode } from "./library/Vector/SeparateXyNode";
import { combineXyNode } from "./library/Vector/CombineXyNode";
import { uvToPixelNode } from "./library/Vector/UvToPixelNode";
import { pixelToUvNode } from "./library/Vector/PixelToUvNode";
import { sampleKernelNode } from "./library/Filter/SampleKernelNode";
import { mixNode } from "./library/Color/MixNode";
import { brightnessContrastNode } from "./library/Color/BrightnessContrastNode";
import { hueSaturationNode } from "./library/Color/HueSaturationNode";
import { invertNode } from "./library/Color/InvertNode";
import { separateRgbaNode } from "./library/Color/SeparateRgbaNode";
import { combineRgbaNode } from "./library/Color/CombineRgbaNode";
import { noiseNode } from "./library/Texture/NoiseNode";
import { checkerNode } from "./library/Texture/CheckerNode";
import { layerOutputNode } from "./library/Output/LayerOutputNode";
import { onRunNode } from "./library/Events/OnRunNode";
import { branchNode } from "./library/Flow/BranchNode";
import { forEachLayerNode } from "./library/Flow/ForEachLayerNode";
import { activeLayerNode } from "./library/Layers/ActiveLayerNode";
import { newLayerNode } from "./library/Layers/NewLayerNode";
import { setLayerOpacityNode } from "./library/Layers/SetLayerOpacityNode";
import { renameLayerNode } from "./library/Layers/RenameLayerNode";
import { exportImageNode } from "./library/File/ExportImageNode";
import { printNode } from "./library/Debug/PrintNode";

for (const node of [
  layerInputNode,
  sampleLayerNode,
  uvNode,
  valueNode,
  colorNode,
  textNode,
  mathNode,
  clampNode,
  mapRangeNode,
  compareNode,
  booleanMathNode,
  ifElseNode,
  forLoopNode,
  subgraphInputNode,
  subgraphOutputNode,
  documentInfoNode,
  layerInfoNode,
  layerPropertiesNode,
  uvTransformNode,
  vectorMathNode,
  separateXyNode,
  combineXyNode,
  uvToPixelNode,
  pixelToUvNode,
  sampleKernelNode,
  mixNode,
  brightnessContrastNode,
  hueSaturationNode,
  invertNode,
  separateRgbaNode,
  combineRgbaNode,
  noiseNode,
  checkerNode,
  layerOutputNode,
  onRunNode,
  branchNode,
  forEachLayerNode,
  activeLayerNode,
  newLayerNode,
  setLayerOpacityNode,
  renameLayerNode,
  exportImageNode,
  printNode,
]) {
  nodeRegistry.register(node);
}

export { nodeRegistry };
