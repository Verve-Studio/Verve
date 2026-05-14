import type { Tool } from "@/types";
import type { ITool } from "./_shared/ITool";
import { toolRegistry } from "./toolRegistry";

import { pencilTool } from "./Pencil/Pencil";
import { brushTool } from "./Brush/Brush";
import { eraserTool } from "./Eraser/Eraser";
import { selectTool } from "./Select/Select";
import { lassoTool } from "./Lasso/Lasso";
import { magicWandTool } from "./MagicWand/MagicWand";
import { polygonalSelectionTool } from "./PolygonalSelection/PolygonalSelection";
import { autoMaskTool } from "./AutoMask/AutoMask";
import { fillTool } from "./Fill/Fill";
import { eyedropperTool } from "./Eyedropper/Eyedropper";
import { zoomTool } from "./Zoom/Zoom";
import { cropTool } from "./Crop/Crop";
import { moveTool } from "./Move/Move";
import { pickTool } from "./Pick/Pick";
import { gradientTool } from "./Gradient/Gradient";
import { dodgeTool, burnTool } from "./Dodge/Dodge";
import { textTool } from "./Text/Text";
import { shapeTool } from "./Shape/Shape";
import { penTool } from "./Pen/Pen";
import { transformTool } from "./Transform/Transform";
import { cloneStampTool } from "./CloneStamp/CloneStamp";
import { frameTool } from "./Frame/Frame";
import { liquifyTool } from "./Liquify/Liquify";
import { handTool } from "./Hand/Hand";
import { blurTool } from "./Blur/Blur";
import { sharpenTool } from "./Sharpen/Sharpen";
import { smudgeTool } from "./Smudge/Smudge";
import { patchTool } from "./Patch/Patch";
import { healingBrushTool } from "./HealingBrush/HealingBrush";
import { objectRemovalTool } from "./ObjectRemoval/ObjectRemoval";
import { measureTool } from "./Measure/Measure";
import { quickSelectTool } from "./QuickSelect/QuickSelect";
import { linkedTool } from "./Linked/Linked";

const ALL_TOOLS: readonly ITool[] = [
  moveTool,
  pickTool,
  selectTool,
  lassoTool,
  polygonalSelectionTool,
  quickSelectTool,
  magicWandTool,
  autoMaskTool,
  brushTool,
  pencilTool,
  eraserTool,
  fillTool,
  gradientTool,
  textTool,
  shapeTool,
  penTool,
  cropTool,
  frameTool,
  eyedropperTool,
  measureTool,
  cloneStampTool,
  healingBrushTool,
  objectRemovalTool,
  patchTool,
  dodgeTool,
  burnTool,
  blurTool,
  sharpenTool,
  smudgeTool,
  liquifyTool,
  handTool,
  zoomTool,
  transformTool,
  linkedTool,
];

for (const tool of ALL_TOOLS) {
  toolRegistry.register(tool);
}

/**
 * Back-compat lookup map. New code should call `toolRegistry.get(id)` /
 * `toolRegistry.require(id)` directly; this re-exposes the registry as a
 * `Record<Tool, ITool>` for callers that index by tool id.
 */
export const TOOL_REGISTRY: Record<Tool, ITool> = ALL_TOOLS.reduce(
  (acc, t) => {
    acc[t.id] = t;
    return acc;
  },
  {} as Record<Tool, ITool>,
);

export { toolRegistry } from "./toolRegistry";
export type { ITool, ToolPlacement, ToolButtonRenderProps } from "./_shared/ITool";
export { ToolGroup } from "./_shared/ITool";
export type {
  ToolDefinition,
  ToolHandler,
  ToolContext,
  ToolPointerPos,
  ToolOptionsStyles,
} from "./_shared/types";
