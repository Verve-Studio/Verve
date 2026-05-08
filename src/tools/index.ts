import type { Tool } from "@/types";
import type { ToolDefinition } from "./types";
import { pencilTool } from "./pencil";
import { brushTool } from "./brush";
import { eraserTool } from "./eraser";
import { selectTool } from "./select";
import { lassoTool } from "./lasso";
import { magicWandTool } from "./magicWand";
import { polygonalSelectionTool } from "./polygonalSelection";
import { objectSelectionTool } from "./objectSelection";
import { fillTool } from "./fill";
import { eyedropperTool } from "./eyedropper";
import { zoomTool } from "./zoom";
import { cropTool } from "./crop";
import { moveTool } from "./move";
import { pickTool } from "./pick";
import { gradientTool } from "./gradient";
import { dodgeTool, burnTool } from "./dodge";
import { textTool } from "./text";
import { shapeTool } from "./shape";
import { transformTool } from "./transform";
import { cloneStampTool } from "./cloneStamp";
import { frameTool } from "./frame";
import { liquifyTool } from "./liquify";
import { handTool } from "./hand";
import { blurTool } from "./blur";
import { sharpenTool } from "./sharpen";
import { smudgeTool } from "./smudge";
import { patchTool } from "./patch";
import { healingBrushTool } from "./healingBrush";

export const TOOL_REGISTRY: Record<Tool, ToolDefinition> = {
  pencil: pencilTool,
  brush: brushTool,
  eraser: eraserTool,
  "clone-stamp": cloneStampTool,
  select: selectTool,
  lasso: lassoTool,
  "polygonal-selection": polygonalSelectionTool,
  "object-selection": objectSelectionTool,
  "magic-wand": magicWandTool,
  fill: fillTool,
  eyedropper: eyedropperTool,
  zoom: zoomTool,
  // ── Not yet implemented ────────────────────────────────────────────────────
  move: moveTool,
  pick: pickTool,
  crop: cropTool,
  frame: frameTool,
  gradient: gradientTool,
  dodge: dodgeTool,
  burn: burnTool,
  text: textTool,
  shape: shapeTool,
  liquify: liquifyTool,
  blur: blurTool,
  sharpen: sharpenTool,
  smudge: smudgeTool,
  patch: patchTool,
  "healing-brush": healingBrushTool,
  hand: handTool,
  transform: transformTool,
};

export type {
  ToolDefinition,
  ToolHandler,
  ToolContext,
  ToolPointerPos,
  ToolOptionsStyles,
} from "./types";
