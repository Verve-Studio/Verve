import type { ComponentType, ReactElement } from "react";
import type { Tool } from "@/types";
import type { ToolHandler, ToolOptionsStyles } from "./types";

/**
 * Visual groupings on the side toolbar. Order matches Photoshop and is
 * the source of truth for top-to-bottom group ordering. Visual separators
 * are drawn between groups by the toolbar renderer.
 */
export enum ToolGroup {
  Move = 0,
  Selection = 1,
  Painting = 2,
  Fill = 3,
  Type = 4,
  Crop = 5,
  Sampling = 6,
  Retouching = 7,
  Tonal = 8,
  LocalEffect = 9,
  Distortion = 10,
  Navigation = 11,
}

/**
 * Where a tool sits in the toolbar grid. Tools without a `placement` are
 * not surfaced on the toolbar (e.g. transform — invoked via Ctrl+T —
 * and the noop placeholder).
 */
export interface ToolPlacement {
  group: ToolGroup;
  /** Row within the group (0-based, ascending top → bottom). */
  row: number;
  /** Column within the row (0 = left, 1 = right). */
  column: 0 | 1;
}

/**
 * Props handed to a tool's optional `customRender`. Returning a ReactElement
 * here replaces the default toolbar button entirely. Used by the shape tool
 * to attach a flyout caret next to the standard activate button.
 */
export interface ToolButtonRenderProps {
  active: boolean;
  disabled: boolean;
  /** CSS-module class names from `Toolbar.module.scss`. */
  styles: { [key: string]: string };
  onActivate: () => void;
}

/**
 * One tool — pencil, brush, eraser, etc. — registered in `toolRegistry`.
 * Implementations co-locate every responsibility for a single tool: pointer
 * handler factory, options panel component, toolbar metadata (icon, label,
 * shortcut, placement) and execution constraints (pixel-only, etc.). Mirrors
 * `IPipelineEffect` so adding a new tool is one registration step.
 */
export interface ITool {
  // ── Identity ───────────────────────────────────────────────────────
  /** Stable id; matches the `Tool` union member in `@/types`. */
  readonly id: Tool;
  /** Display label in tooltips and the macOS native menu. */
  readonly label: string;

  // ── Toolbar presentation ───────────────────────────────────────────
  /** Single-letter primary keyboard shortcut (uppercase). Empty string =
   *  no shortcut (tool is invoked via menu / ctrl-combo / programmatically). */
  readonly shortcut: string;
  /** Icon shown in the toolbar button. */
  readonly icon: ReactElement;
  /** Toolbar placement. `null` excludes this tool from the toolbar. */
  readonly placement: ToolPlacement | null;
  /** Optional custom button renderer (Shape uses this for its flyout caret). */
  customRender?(props: ToolButtonRenderProps): ReactElement;

  // ── Shortcut cycling ───────────────────────────────────────────────
  /**
   * Tool to switch to when this tool's shortcut is pressed while it is
   * already active. Used to cycle between tools that share a key (e.g.
   * lasso ↔ polygonal-lasso on `L`, magic-wand ↔ object-selection on `W`).
   * Cycles can chain; the keyboard handler walks the chain at most once.
   */
  readonly shortcutCycle?: Tool;

  // ── Behaviour flags ────────────────────────────────────────────────
  /** True for tools that write pixels; Canvas uses this to block locked
   *  layers and trigger history capture on pointer up. */
  readonly modifiesPixels?: boolean;
  /** True for async tools that call `ctx.commitStroke()` themselves;
   *  suppresses the automatic pointer-up history capture. */
  readonly skipAutoHistory?: boolean;
  /** True for tools that paint new pixels and therefore need a real pixel
   *  layer — Canvas auto-creates one above text/shape layers on first stroke. */
  readonly paintsOntoPixelLayer?: boolean;
  /** True for tools with their own handling for parametric layers (text,
   *  shape, group); skips Canvas's parametric-layer guard. The move tool
   *  is the canonical example. */
  readonly worksOnAllLayers?: boolean;
  /** True for tools that can only operate on a real pixel layer — toolbar
   *  disables them when the active layer is text/shape/group/adjustment. */
  readonly pixelOnly?: boolean;
  /** True for tools that have no indexed8 implementation — toolbar
   *  disables them when the document is in indexed8 mode. */
  readonly indexed8Unsupported?: boolean;

  // ── Runtime hooks ──────────────────────────────────────────────────
  /** Build a fresh stateful pointer handler for one activation. */
  createHandler(): ToolHandler;
  /** Right-side options bar component shown while this tool is active. */
  readonly Options: ComponentType<{ styles: ToolOptionsStyles }>;
}
