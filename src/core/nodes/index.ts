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
import { normalFromHeightNode } from "./library/Surface/NormalFromHeightNode";
import { normalMapNode } from "./library/Surface/NormalMapNode";
import { lightingNode } from "./library/Surface/LightingNode";
import { vector3MathNode } from "./library/Vector/Vector3MathNode";
import { separateXyzNode } from "./library/Vector/SeparateXyzNode";
import { combineXyzNode } from "./library/Vector/CombineXyzNode";
import { polarCoordinatesNode } from "./library/Vector/PolarCoordinatesNode";
import { distortUvNode } from "./library/Vector/DistortUvNode";
import { gradientTextureNode } from "./library/Texture/GradientTextureNode";
import { shapeNode } from "./library/Texture/ShapeNode";
import { voronoiNode } from "./library/Texture/VoronoiNode";
import { waveTextureNode } from "./library/Texture/WaveTextureNode";
import { colorRampNode } from "./library/Color/ColorRampNode";
import { levelsNode } from "./library/Color/LevelsNode";
import { luminanceNode } from "./library/Color/LuminanceNode";
import { posterizeNode } from "./library/Color/PosterizeNode";
import { separateHsvNode } from "./library/Color/SeparateHsvNode";
import { combineHsvNode } from "./library/Color/CombineHsvNode";
import { blurNode } from "./library/Filter/BlurNode";
import { blurColorNode } from "./library/Filter/BlurColorNode";
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
import { concatNode } from "./library/Text/ConcatNode";
import { substringNode } from "./library/Text/SubstringNode";
import { lengthOfNode } from "./library/Text/LengthOfNode";
import { toUpperNode } from "./library/Text/ToUpperNode";
import { toLowerNode } from "./library/Text/ToLowerNode";
import { splitNode } from "./library/Text/SplitNode";
import { joinNode } from "./library/Text/JoinNode";
import { replaceNode } from "./library/Text/ReplaceNode";
import { trimNode } from "./library/Text/TrimNode";
import { textCompareNode } from "./library/Text/TextCompareNode";
import { formatNumberNode } from "./library/Text/FormatNumberNode";
import { parseNumberNode } from "./library/Text/ParseNumberNode";
import { makeListNode } from "./library/List/MakeListNode";
import { listLengthNode } from "./library/List/ListLengthNode";
import { getItemNode } from "./library/List/GetItemNode";
import { setItemNode } from "./library/List/SetItemNode";
import { appendNode } from "./library/List/AppendNode";
import { removeItemNode } from "./library/List/RemoveItemNode";
import { concatListsNode } from "./library/List/ConcatListsNode";
import { sliceNode } from "./library/List/SliceNode";
import { reverseNode } from "./library/List/ReverseNode";
import { findItemNode } from "./library/List/FindItemNode";
import { sortNode } from "./library/List/SortNode";
import { uniqueNode } from "./library/List/UniqueNode";
import { rangeNode } from "./library/List/RangeNode";
import { filterTextNode } from "./library/List/FilterTextNode";
import { forEachItemNode } from "./library/List/ForEachItemNode";
import { setVariableNode } from "./library/Variables/SetVariableNode";
import { getVariableNode } from "./library/Variables/GetVariableNode";
import { repeatNode } from "./library/Flow/RepeatNode";
import { whileNode } from "./library/Flow/WhileNode";
import { sequenceNode } from "./library/Flow/SequenceNode";
import { stopNode } from "./library/Flow/StopNode";
import { joinPathNode } from "./library/File/JoinPathNode";
import { splitPathNode } from "./library/File/SplitPathNode";
import { changeExtensionNode } from "./library/File/ChangeExtensionNode";
import { activeDocumentNode } from "./library/Document/ActiveDocumentNode";
import { closeDocumentNode } from "./library/Document/CloseDocumentNode";
import { newDocumentNode } from "./library/Document/NewDocumentNode";
import { openDocumentNode } from "./library/Document/OpenDocumentNode";
import { setActiveDocumentNode } from "./library/Document/SetActiveDocumentNode";
import { createFolderNode } from "./library/File/CreateFolderNode";
import { fileInfoNode } from "./library/File/FileInfoNode";
import { listFilesNode } from "./library/File/ListFilesNode";
import { listFoldersNode } from "./library/File/ListFoldersNode";
import { convertColorModeNode } from "./library/Image/ConvertColorModeNode";
import { cropImageNode } from "./library/Image/CropImageNode";
import { cropToSelectionNode } from "./library/Image/CropToSelectionNode";
import { flipImageNode } from "./library/Image/FlipImageNode";
import { rescaleImageNode } from "./library/Image/RescaleImageNode";
import { resizeCanvasNode } from "./library/Image/ResizeCanvasNode";
import { resizeImageNode } from "./library/Image/ResizeImageNode";
import { restoreImageNode } from "./library/Image/RestoreImageNode";
import { rotateImageNode } from "./library/Image/RotateImageNode";
import { trimImageNode } from "./library/Image/TrimImageNode";
import { addLayerMaskNode } from "./library/Layers/AddLayerMaskNode";
import { alignLayersNode } from "./library/Layers/AlignLayersNode";
import { arrangeLayersNode } from "./library/Layers/ArrangeLayersNode";
import { clearLayerNode } from "./library/Edit/ClearLayerNode";
import { deleteLayerNode } from "./library/Layers/DeleteLayerNode";
import { distributeLayersNode } from "./library/Layers/DistributeLayersNode";
import { duplicateLayerNode } from "./library/Layers/DuplicateLayerNode";
import { fillLayerNode } from "./library/Layers/FillLayerNode";
import { findLayerNode } from "./library/Layers/FindLayerNode";
import { flattenImageNode } from "./library/Layers/FlattenImageNode";
import { flipLayersNode } from "./library/Layers/FlipLayersNode";
import { getLayersNode } from "./library/Layers/GetLayersNode";
import { groupLayersNode } from "./library/Layers/GroupLayersNode";
import { importImageAsLayerNode } from "./library/File/ImportImageAsLayerNode";
import { layerChildrenNode } from "./library/Layers/LayerChildrenNode";
import { layerParentNode } from "./library/Layers/LayerParentNode";
import { mergeDownNode } from "./library/Layers/MergeDownNode";
import { mergeGroupNode } from "./library/Layers/MergeGroupNode";
import { mergeLayersNode } from "./library/Layers/MergeLayersNode";
import { mergeVisibleNode } from "./library/Layers/MergeVisibleNode";
import { moveLayerNode } from "./library/Layers/MoveLayerNode";
import { moveToGroupNode } from "./library/Layers/MoveToGroupNode";
import { newLinkedLayerNode } from "./library/Layers/NewLinkedLayerNode";
import { rasterizeLayerNode } from "./library/Layers/RasterizeLayerNode";
import { rotateLayersNode } from "./library/Layers/RotateLayersNode";
import { selectLayersNode } from "./library/Layers/SelectLayersNode";
import { setActiveLayerNode } from "./library/Layers/SetActiveLayerNode";
import { setBlendModeNode } from "./library/Layers/SetBlendModeNode";
import { setLayerColorSpaceNode } from "./library/Layers/SetLayerColorSpaceNode";
import { setLayerLockedNode } from "./library/Layers/SetLayerLockedNode";
import { setLayerVisibilityNode } from "./library/Layers/SetLayerVisibilityNode";
import { ungroupLayersNode } from "./library/Layers/UngroupLayersNode";
import { deselectNode } from "./library/Selection/DeselectNode";
import { invertSelectionNode } from "./library/Selection/InvertSelectionNode";
import { selectAllNode } from "./library/Selection/SelectAllNode";
import { selectLayerPixelsNode } from "./library/Selection/SelectLayerPixelsNode";
import { selectRectangleNode } from "./library/Selection/SelectRectangleNode";
import { selectionInfoNode } from "./library/Selection/SelectionInfoNode";
import { contentAwareFillNode } from "./library/Edit/ContentAwareFillNode";
import { copyNode } from "./library/Edit/CopyNode";
import { cutNode } from "./library/Edit/CutNode";
import { pasteNode } from "./library/Edit/PasteNode";
import { saveACopyNode } from "./library/Document/SaveACopyNode";
import { saveAsNode } from "./library/Document/SaveAsNode";
import { saveNode } from "./library/Document/SaveNode";
import { contentAwareDeleteNode } from "./library/Edit/ContentAwareDeleteNode";
import { copyMergedNode } from "./library/Edit/CopyMergedNode";
import { pasteIntoNode } from "./library/Edit/PasteIntoNode";
import { customEffectsNode } from "./library/Effects/CustomEffectsNode";
import { openEffectFileNode } from "./library/Effects/OpenEffectFileNode";
import { newCompositeLayerNode } from "./library/Layers/NewCompositeLayerNode";
import { newLayerGroupNode } from "./library/Layers/NewLayerGroupNode";
import { refreshLinkedLayerNode } from "./library/Layers/RefreshLinkedLayerNode";
import { allLayersNode } from "./library/Selection/AllLayersNode";
import { deselectLayersNode } from "./library/Selection/DeselectLayersNode";
import { effectNodes } from "./library/Effects/EffectNode";

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
  normalFromHeightNode,
  normalMapNode,
  lightingNode,
  vector3MathNode,
  separateXyzNode,
  combineXyzNode,
  polarCoordinatesNode,
  distortUvNode,
  gradientTextureNode,
  shapeNode,
  voronoiNode,
  waveTextureNode,
  colorRampNode,
  levelsNode,
  luminanceNode,
  posterizeNode,
  separateHsvNode,
  combineHsvNode,
  blurNode,
  blurColorNode,
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
  concatNode,
  substringNode,
  lengthOfNode,
  toUpperNode,
  toLowerNode,
  splitNode,
  joinNode,
  replaceNode,
  trimNode,
  textCompareNode,
  formatNumberNode,
  parseNumberNode,
  makeListNode,
  listLengthNode,
  getItemNode,
  setItemNode,
  appendNode,
  removeItemNode,
  concatListsNode,
  sliceNode,
  reverseNode,
  findItemNode,
  sortNode,
  uniqueNode,
  rangeNode,
  filterTextNode,
  forEachItemNode,
  setVariableNode,
  getVariableNode,
  repeatNode,
  whileNode,
  sequenceNode,
  stopNode,
  joinPathNode,
  splitPathNode,
  changeExtensionNode,
  activeDocumentNode,
  closeDocumentNode,
  newDocumentNode,
  openDocumentNode,
  setActiveDocumentNode,
  createFolderNode,
  fileInfoNode,
  listFilesNode,
  listFoldersNode,
  convertColorModeNode,
  cropImageNode,
  cropToSelectionNode,
  flipImageNode,
  rescaleImageNode,
  resizeCanvasNode,
  resizeImageNode,
  restoreImageNode,
  rotateImageNode,
  trimImageNode,
  addLayerMaskNode,
  alignLayersNode,
  arrangeLayersNode,
  clearLayerNode,
  deleteLayerNode,
  distributeLayersNode,
  duplicateLayerNode,
  fillLayerNode,
  findLayerNode,
  flattenImageNode,
  flipLayersNode,
  getLayersNode,
  groupLayersNode,
  importImageAsLayerNode,
  layerChildrenNode,
  layerParentNode,
  mergeDownNode,
  mergeGroupNode,
  mergeLayersNode,
  mergeVisibleNode,
  moveLayerNode,
  moveToGroupNode,
  newLinkedLayerNode,
  rasterizeLayerNode,
  rotateLayersNode,
  selectLayersNode,
  setActiveLayerNode,
  setBlendModeNode,
  setLayerColorSpaceNode,
  setLayerLockedNode,
  setLayerVisibilityNode,
  ungroupLayersNode,
  deselectNode,
  invertSelectionNode,
  selectAllNode,
  selectLayerPixelsNode,
  selectRectangleNode,
  selectionInfoNode,
  contentAwareFillNode,
  copyNode,
  cutNode,
  pasteNode,
  saveACopyNode,
  saveAsNode,
  saveNode,
  contentAwareDeleteNode,
  copyMergedNode,
  pasteIntoNode,
  customEffectsNode,
  openEffectFileNode,
  newCompositeLayerNode,
  newLayerGroupNode,
  refreshLinkedLayerNode,
  allLayersNode,
  deselectLayersNode,
]) {
  nodeRegistry.register(node);
}

// One node per registered effect (generated from its param schema).
nodeRegistry.registerProvider(effectNodes);

export { nodeRegistry };
