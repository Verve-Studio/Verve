import { useAppContext } from "@/core/store/AppContext";
import type { RGBAColor, ShapeType, Tool } from "@/types";
import { ColorPickerDialog } from "@/ux/modals/ColorPickerDialog/ColorPickerDialog";
import { IndexedPaletteColorPicker } from "@/ux/widgets/IndexedPaletteColorPicker/IndexedPaletteColorPicker";
import React, { useEffect, useRef, useState } from "react";
import styles from "./Toolbar.module.scss";

// ─── Asset icons ──────────────────────────────────────────────────────────────

import burnIcon from "@/ux/assets/burn.svg?raw";
import brushIcon from "@/ux/assets/brush.svg?raw";
import cloneStampIcon from "@/ux/assets/clone-stamp.svg?raw";
import colorPickerIcon from "@/ux/assets/color-picker.svg?raw";
import cropIcon from "@/ux/assets/crop.svg?raw";
import dodgeIcon from "@/ux/assets/dodge.svg?raw";
import eraserIcon from "@/ux/assets/eraser.svg?raw";
import frameIcon from "@/ux/assets/frame.svg?raw";
import gradientIcon from "@/ux/assets/gradient.svg?raw";
import lassoIcon from "@/ux/assets/lasso.svg?raw";
import magicWandIcon from "@/ux/assets/magic-wand.svg?raw";
import marqueeRectIcon from "@/ux/assets/marquee-rect.svg?raw";
import moveIcon from "@/ux/assets/move.svg?raw";
import objectSelectIcon from "@/ux/assets/object-select.svg?raw";
import paintBucketIcon from "@/ux/assets/paint-bucket.svg?raw";
import pencilIcon from "@/ux/assets/pencil.svg?raw";
import polygonSelectIcon from "@/ux/assets/polygon-select.svg?raw";
import shapeIcon from "@/ux/assets/shape.svg?raw";
import textIcon from "@/ux/assets/text.svg?raw";

function SvgIcon({ src }: { src: string }): React.JSX.Element {
  const svg = src
    .replace(/width="\d+(\.\d+)?"/, 'width="100%"')
    .replace(/height="\d+(\.\d+)?"/, 'height="100%"');
  return (
    <span
      style={{ display: "block", width: "100%", height: "100%" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

const Icon = {
  move: <SvgIcon src={moveIcon} />,
  select: <SvgIcon src={marqueeRectIcon} />,
  lasso: <SvgIcon src={lassoIcon} />,
  polygonalLasso: <SvgIcon src={polygonSelectIcon} />,
  objectSelection: <SvgIcon src={objectSelectIcon} />,
  magicWand: <SvgIcon src={magicWandIcon} />,
  crop: <SvgIcon src={cropIcon} />,
  frame: <SvgIcon src={frameIcon} />,
  eyedropper: <SvgIcon src={colorPickerIcon} />,
  pencil: <SvgIcon src={pencilIcon} />,
  brush: <SvgIcon src={brushIcon} />,
  eraser: <SvgIcon src={eraserIcon} />,
  fill: <SvgIcon src={paintBucketIcon} />,
  gradient: <SvgIcon src={gradientIcon} />,
  dodge: <SvgIcon src={dodgeIcon} />,
  burn: <SvgIcon src={burnIcon} />,
  text: <SvgIcon src={textIcon} />,
  shape: <SvgIcon src={shapeIcon} />,
  cloneStamp: <SvgIcon src={cloneStampIcon} />,
  // Hand (pan): outline of an open hand.
  hand: (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        <path
          d="M5 8 V4.2 a1 1 0 0 1 2 0 V7.5 M7 4 V3 a1 1 0 0 1 2 0 V7.5 M9 3.5 V3 a1 1 0 0 1 2 0 V8 M11 5 V4.2 a1 1 0 0 1 2 0 V10 a4 4 0 0 1 -8 0 V7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  ),
  // Zoom: magnifying glass with plus.
  zoom: (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        <circle
          cx="7"
          cy="7"
          r="4.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path
          d="M10 10 L13.5 13.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M5 7 L9 7 M7 5 L7 9"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </svg>
    </span>
  ),
  // Blur: water-droplet shape.
  blur: (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        <path
          d="M8 2.5 C 5 6.5, 4 8.5, 4 11 a4 4 0 0 0 8 0 c 0 -2.5 -1 -4.5 -4 -8.5 z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  ),
  // Sharpen: triangular cone (point up).
  sharpen: (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        <path
          d="M8 2.5 L4.5 13.5 L11.5 13.5 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path
          d="M6.5 9 L9.5 9"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
        />
      </svg>
    </span>
  ),
  // Quick Select: brush + dashed-selection arc, evoking the PS quick select
  // tool icon (a wand-like brush over a marquee curve).
  quickSelect: (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        {/* Dashed selection-style arc */}
        <path
          d="M2 11 C 4 6, 12 6, 14 11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeDasharray="1.6 1.6"
        />
        {/* Brush stroke */}
        <path
          d="M9 3 L13 7"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        {/* Brush tip */}
        <circle cx="9" cy="3" r="1.4" fill="currentColor" />
      </svg>
    </span>
  ),
  // Measure / Ruler: classic ruler with tick marks.
  measure: (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        <g transform="rotate(-30 8 8)">
          <rect
            x="1.5"
            y="6.2"
            width="13"
            height="3.6"
            rx="0.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
          />
          {/* Ticks */}
          <path
            d="M3 6.2 L3 8 M5 6.2 L5 7.4 M7 6.2 L7 8 M9 6.2 L9 7.4 M11 6.2 L11 8 M13 6.2 L13 7.4"
            stroke="currentColor"
            strokeWidth="0.9"
          />
        </g>
      </svg>
    </span>
  ),
  // Healing Brush: classic band-aid (PS-style).
  healingBrush: (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        <g transform="rotate(-45 8 8)">
          {/* Bandage body */}
          <rect
            x="2.2"
            y="6.2"
            width="11.6"
            height="3.6"
            rx="1.2"
            ry="1.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          {/* Pad in the middle */}
          <rect
            x="6"
            y="6.6"
            width="4"
            height="2.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="0.8"
            opacity="0.6"
          />
          {/* Dots on each end */}
          <circle cx="3.6" cy="7.4" r="0.4" fill="currentColor" />
          <circle cx="3.6" cy="8.6" r="0.4" fill="currentColor" />
          <circle cx="12.4" cy="7.4" r="0.4" fill="currentColor" />
          <circle cx="12.4" cy="8.6" r="0.4" fill="currentColor" />
        </g>
      </svg>
    </span>
  ),
  // Patch: dashed-outline patch shape (selection rect with stitched edge).
  patch: (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        <path
          d="M3 5 L3 13 L11 13 L13 11 L13 3 L5 3 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
          strokeDasharray="1.6 1.6"
        />
        <path
          d="M5 3 L3 5 M11 13 L13 11"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  ),
  // Smudge: hand with extended pointing finger pushing leftward (PS-style).
  smudge: (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        {/* Extended index finger pointing up-left */}
        <path
          d="M2 7.5 L7 5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        {/* Hand body */}
        <path
          d="M7 5
             C 7 3.6, 8 3, 8.7 3
             C 9.4 3, 10 3.6, 10 4.3
             L 10 6.5
             C 10.6 6.3, 11.2 6.6, 11.3 7.2
             L 11.5 8
             C 12.1 7.9, 12.7 8.3, 12.7 8.9
             L 12.7 11.5
             C 12.7 12.6, 11.8 13.5, 10.7 13.5
             L 8.5 13.5
             C 7.4 13.5, 6.5 12.6, 6.5 11.5
             L 6.5 7.5
             C 6.5 6.5, 6.7 5.7, 7 5
             Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  ),
  // Liquify: stylised swirl indicating distortion.
  liquify: (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        <path
          d="M3 11 C 3 6, 13 6, 13 11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <path
          d="M3 8 C 3 4, 13 4, 13 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          opacity="0.5"
        />
        <circle cx="8" cy="11" r="1.3" fill="currentColor" />
      </svg>
    </span>
  ),
  // Pick (universal select): black-and-white arrow cursor.
  pick: (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      <svg
        viewBox="0 0 16 16"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "100%" }}
      >
        <path
          d="M2.5 2 L2.5 12.5 L5.2 9.8 L7.0 13.6 L8.6 12.8 L6.8 9.0 L10.5 9.0 Z"
          fill="currentColor"
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth="1"
        />
      </svg>
    </span>
  ),
};

// ─── Shape picker definitions ─────────────────────────────────────────────────

interface ShapeDef {
  id: ShapeType;
  label: string;
  icon: React.JSX.Element;
}

const SHAPE_DEFS: ShapeDef[] = [
  {
    id: "rectangle",
    label: "Rectangle",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <rect x="1.5" y="3.5" width="13" height="9" rx="0.5" />
      </svg>
    ),
  },
  {
    id: "ellipse",
    label: "Ellipse",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <ellipse cx="8" cy="8" rx="6.5" ry="4.5" />
      </svg>
    ),
  },
  {
    id: "triangle",
    label: "Triangle",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      >
        <polygon points="8,1.5 14.5,14.5 1.5,14.5" />
      </svg>
    ),
  },
  {
    id: "line",
    label: "Line",
    icon: (
      <svg
        viewBox="0 0 16 16"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <line x1="2.5" y1="13.5" x2="13.5" y2="2.5" />
      </svg>
    ),
  },
  {
    id: "diamond",
    label: "Diamond",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      >
        <polygon points="8,1.5 14.5,8 8,14.5 1.5,8" />
      </svg>
    ),
  },
  {
    id: "star",
    label: "Star",
    icon: (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      >
        <polygon points="8,1.5 9.47,5.98 13.23,6.3 10.38,8.77 11.23,12.45 8,10.5 4.77,12.45 5.62,8.77 2.77,6.3 6.53,5.98" />
      </svg>
    ),
  },
];

function getShapeIcon(shape: ShapeType): React.JSX.Element {
  return SHAPE_DEFS.find((s) => s.id === shape)?.icon ?? SHAPE_DEFS[0].icon;
}

interface ToolDef {
  id: Tool;
  label: string;
  shortcut: string;
  icon: React.JSX.Element;
}

type ToolRow = (ToolDef | null)[];
type ToolGroup = ToolRow[];

/**
 * Toolbar layout: a list of groups, each group a list of 2-column rows.
 * Visual separators are drawn between groups by the renderer; a group's rows
 * sit flush against each other. Order roughly mirrors Photoshop.
 */
const TOOL_GROUPS: ToolGroup[] = [
  // ── Move & Pick ────────────────────────────────────────────
  [[
    { id: "move", label: "Move", shortcut: "V", icon: Icon.move },
    { id: "pick", label: "Pick", shortcut: "A", icon: Icon.pick },
  ]],
  // ── Selection tools (marquee / lasso / smart-selection) ────
  [
    [
      { id: "select", label: "Marquee", shortcut: "M", icon: Icon.select },
      { id: "lasso", label: "Lasso", shortcut: "L", icon: Icon.lasso },
    ],
    [
      {
        id: "polygonal-selection",
        label: "Polygonal Lasso",
        shortcut: "L",
        icon: Icon.polygonalLasso,
      },
      {
        id: "quick-select",
        label: "Quick Selection",
        shortcut: "W",
        icon: Icon.quickSelect,
      },
    ],
    [
      {
        id: "magic-wand",
        label: "Magic Wand",
        shortcut: "W",
        icon: Icon.magicWand,
      },
      {
        id: "object-selection",
        label: "Object Selection",
        shortcut: "W",
        icon: Icon.objectSelection,
      },
    ],
  ],
  // ── Painting (brush / pencil / eraser) ─────────────────────
  [
    [
      { id: "brush", label: "Brush", shortcut: "B", icon: Icon.brush },
      { id: "pencil", label: "Pencil", shortcut: "N", icon: Icon.pencil },
    ],
    [{ id: "eraser", label: "Eraser", shortcut: "E", icon: Icon.eraser }, null],
  ],
  // ── Fills (bucket / gradient) ──────────────────────────────
  [[
    { id: "fill", label: "Paint Bucket", shortcut: "G", icon: Icon.fill },
    { id: "gradient", label: "Gradient", shortcut: "G", icon: Icon.gradient },
  ]],
  // ── Type & Shape (vector) ──────────────────────────────────
  [[
    { id: "text", label: "Type", shortcut: "T", icon: Icon.text },
    { id: "shape", label: "Shape", shortcut: "U", icon: Icon.shape },
  ]],
  // ── Crop & Frame ───────────────────────────────────────────
  [[
    { id: "crop", label: "Crop", shortcut: "C", icon: Icon.crop },
    { id: "frame", label: "Frame", shortcut: "K", icon: Icon.frame },
  ]],
  // ── Sampling & Measurement ─────────────────────────────────
  [[
    {
      id: "eyedropper",
      label: "Eyedropper",
      shortcut: "I",
      icon: Icon.eyedropper,
    },
    { id: "measure", label: "Measure", shortcut: "I", icon: Icon.measure },
  ]],
  // ── Retouching (clone / heal / patch) ──────────────────────
  [
    [
      {
        id: "clone-stamp",
        label: "Clone Stamp",
        shortcut: "S",
        icon: Icon.cloneStamp,
      },
      {
        id: "healing-brush",
        label: "Healing Brush",
        shortcut: "J",
        icon: Icon.healingBrush,
      },
    ],
    [{ id: "patch", label: "Patch", shortcut: "J", icon: Icon.patch }, null],
  ],
  // ── Tonal brushes (dodge / burn) ───────────────────────────
  [[
    { id: "dodge", label: "Dodge", shortcut: "O", icon: Icon.dodge },
    { id: "burn", label: "Burn", shortcut: "O", icon: Icon.burn },
  ]],
  // ── Local-effect brushes (blur / sharpen / smudge) ─────────
  [
    [
      { id: "blur", label: "Blur", shortcut: "R", icon: Icon.blur },
      { id: "sharpen", label: "Sharpen", shortcut: "R", icon: Icon.sharpen },
    ],
    [{ id: "smudge", label: "Smudge", shortcut: "R", icon: Icon.smudge }, null],
  ],
  // ── Distortion ─────────────────────────────────────────────
  [[
    { id: "liquify", label: "Liquify", shortcut: "Q", icon: Icon.liquify },
    null,
  ]],
  // ── Navigation (hand / zoom) ───────────────────────────────
  [[
    { id: "hand", label: "Hand", shortcut: "H", icon: Icon.hand },
    { id: "zoom", label: "Zoom", shortcut: "Z", icon: Icon.zoom },
  ]],
];

/** Tools that can only operate on a pixel layer. */
const PIXEL_ONLY_TOOLS = new Set<Tool>([
  "brush",
  "pencil",
  "eraser",
  "clone-stamp",
  "fill",
  "gradient",
  "dodge",
  "burn",
  "liquify",
  "blur",
  "sharpen",
  "smudge",
  "patch",
  "healing-brush",
]);

/** Tools that have no indexed8 implementation. */
const INDEXED8_UNSUPPORTED_TOOLS = new Set<Tool>([
  "brush",
  "dodge",
  "burn",
  "clone-stamp",
  "text",
  "frame",
  "blur",
  "sharpen",
  "smudge",
  "liquify",
  "patch",
  "healing-brush",
]);

// ─── Component ────────────────────────────────────────────────────────────────

interface ToolbarProps {
  activeTool?: Tool;
  onToolChange?: (tool: Tool) => void;
}

export function Toolbar({
  activeTool = "pencil",
  onToolChange,
}: ToolbarProps): React.JSX.Element {
  const { state, dispatch } = useAppContext();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTarget, setDialogTarget] = useState<"fg" | "bg">("fg");
  const [dialogIsSwatchAdd, setDialogIsSwatchAdd] = useState(false);
  const [indexedPickerTarget, setIndexedPickerTarget] = useState<
    "fg" | "bg" | null
  >(null);
  const [indexedPickerAnchor, setIndexedPickerAnchor] = useState<{
    x: number;
    y: number;
  }>({ x: 0, y: 0 });
  const [shapePickerOpen, setShapePickerOpen] = useState(false);
  const [flyoutY, setFlyoutY] = useState(0);
  const shapePickerOpenRef = useRef(false);
  const shapeButtonRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);

  const activeLayer =
    state.layers.find((l) => l.id === state.activeLayerId) ?? null;
  const pixelToolsDisabled =
    activeLayer == null ||
    ("type" in activeLayer && activeLayer.type !== "mask");
  const indexedModeActive = state.pixelFormat === "indexed8";

  // Single always-mounted listener — no mount/unmount race on each toggle
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!shapePickerOpenRef.current) return;
      const target = e.target as Node;
      if (
        flyoutRef.current?.contains(target) ||
        shapeButtonRef.current?.contains(target)
      )
        return;
      shapePickerOpenRef.current = false;
      setShapePickerOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const openShapePicker = () => {
    if (shapeButtonRef.current) {
      const rect = shapeButtonRef.current.getBoundingClientRect();
      setFlyoutY(rect.top);
    }
    const next = !shapePickerOpenRef.current;
    shapePickerOpenRef.current = next;
    setShapePickerOpen(next);
  };

  const selectShape = (shape: ShapeType) => {
    dispatch({ type: "SET_SHAPE", payload: shape });
    onToolChange?.("shape");
    shapePickerOpenRef.current = false;
    setShapePickerOpen(false);
  };

  const fgColor = state.primaryColor;
  const bgColor = state.secondaryColor;
  // primaryColor/secondaryColor are float [0,∞). Convert to 0-255 for CSS.
  const fgStyle = `rgb(${Math.round(Math.min(fgColor.r, 1) * 255)},${Math.round(Math.min(fgColor.g, 1) * 255)},${Math.round(Math.min(fgColor.b, 1) * 255)})`;
  const bgStyle = `rgb(${Math.round(Math.min(bgColor.r, 1) * 255)},${Math.round(Math.min(bgColor.g, 1) * 255)},${Math.round(Math.min(bgColor.b, 1) * 255)})`;
  // ColorPickerDialog now accepts/emits float colors directly

  const openPicker = (target: "fg" | "bg", e: React.MouseEvent): void => {
    if (state.pixelFormat === "indexed8") {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setIndexedPickerAnchor({ x: rect.right + 8, y: rect.top });
      setIndexedPickerTarget(target);
      return;
    }
    setDialogTarget(target);
    setDialogOpen(true);
  };

  const handleConfirm = (color: RGBAColor): void => {
    // color is float [0,1] from ColorPickerDialog
    if (dialogIsSwatchAdd) {
      dispatch({
        type: "ADD_SWATCH",
        payload: {
          r: Math.round(color.r * 255),
          g: Math.round(color.g * 255),
          b: Math.round(color.b * 255),
          a: Math.round(color.a * 255),
        },
      });
    } else {
      dispatch({
        type:
          dialogTarget === "fg" ? "SET_PRIMARY_COLOR" : "SET_SECONDARY_COLOR",
        payload: color,
      });
    }
    setDialogIsSwatchAdd(false);
    setDialogOpen(false);
  };

  const handleSwap = (): void => {
    dispatch({ type: "SET_PRIMARY_COLOR", payload: bgColor });
    dispatch({ type: "SET_SECONDARY_COLOR", payload: fgColor });
  };

  const handleReset = (): void => {
    dispatch({
      type: "SET_PRIMARY_COLOR",
      payload: { r: 0, g: 0, b: 0, a: 1 },
    });
    dispatch({
      type: "SET_SECONDARY_COLOR",
      payload: { r: 1, g: 1, b: 1, a: 1 },
    });
  };

  return (
    <>
      <nav className={styles.toolbar} aria-label="Drawing tools">
        <ul className={styles.grid} role="list">
          {TOOL_GROUPS.map((group, groupIdx) => (
            <React.Fragment key={`g-${groupIdx}`}>
              {groupIdx !== 0 && (
                <li className={styles.separator} aria-hidden="true" />
              )}
              {group.map((row, rowIdx) => (
                <li className={styles.row} key={`g-${groupIdx}-r-${rowIdx}`}>
                  {row.map((tool, colIdx) =>
                    tool ? (
                      tool.id === "shape" ? (
                        <div
                          key="shape-cell"
                          className={styles.shapeCell}
                          ref={shapeButtonRef}
                        >
                          <button
                            className={`${styles.toolBtn} ${activeTool === "shape" ? styles.active : ""}`}
                            onClick={() => onToolChange?.("shape")}
                            aria-label="Shape (U)"
                            aria-pressed={activeTool === "shape"}
                            title="Shape  U"
                          >
                            {getShapeIcon(state.activeShape)}
                          </button>
                          <button
                            className={styles.shapeCaret}
                            onClick={openShapePicker}
                            tabIndex={-1}
                            aria-label="Pick shape"
                            title="Choose shape"
                          >
                            <svg
                              viewBox="0 0 5 3"
                              fill="currentColor"
                              width="5"
                              height="3"
                            >
                              <polygon points="0,0 5,0 2.5,3" />
                            </svg>
                          </button>
                        </div>
                      ) : (
                        <button
                          key={tool.id}
                          className={`${styles.toolBtn} ${activeTool === tool.id ? styles.active : ""}`}
                          onClick={() => {
                            if (
                              PIXEL_ONLY_TOOLS.has(tool.id as Tool) &&
                              pixelToolsDisabled
                            )
                              return;
                            if (
                              INDEXED8_UNSUPPORTED_TOOLS.has(tool.id as Tool) &&
                              indexedModeActive
                            )
                              return;
                            onToolChange?.(tool.id);
                          }}
                          disabled={
                            (PIXEL_ONLY_TOOLS.has(tool.id as Tool) &&
                              pixelToolsDisabled) ||
                            (INDEXED8_UNSUPPORTED_TOOLS.has(tool.id as Tool) &&
                              indexedModeActive)
                          }
                          aria-label={`${tool.label}  (${tool.shortcut})`}
                          aria-pressed={activeTool === tool.id}
                          title={`${tool.label}  ${tool.shortcut}`}
                        >
                          {tool.icon}
                        </button>
                      )
                    ) : (
                      <div
                        key={`empty-${colIdx}`}
                        className={styles.emptyCell}
                        aria-hidden="true"
                      />
                    ),
                  )}
                </li>
              ))}
            </React.Fragment>
          ))}
        </ul>

        {/* ── Foreground / Background color swatches ───────────────────── */}
        <div className={styles.swatches}>
          <button
            className={styles.swatchBg}
            style={{ background: bgStyle }}
            title="Background color (click to edit)"
            aria-label="Background color"
            onClick={(e) => openPicker("bg", e)}
          />
          <button
            className={styles.swatchFg}
            style={{ background: fgStyle }}
            title="Foreground color (click to edit)"
            aria-label="Foreground color"
            onClick={(e) => openPicker("fg", e)}
          />
          <button
            className={styles.swatchReset}
            title="Reset to Default (D)"
            aria-label="Reset colors to default"
            onClick={handleReset}
          />
          <button
            className={styles.swatchSwap}
            title="Swap Colors (X)"
            aria-label="Swap foreground/background"
            onClick={handleSwap}
          >
            <svg viewBox="0 0 10 10" fill="currentColor" width="9" height="9">
              <path d="M6.5 1L9 3.5 6.5 6V4.5H2V3h4.5zM3.5 9L1 6.5 3.5 4v1.5H8V7H3.5z" />
            </svg>
          </button>
        </div>
      </nav>

      {shapePickerOpen && (
        <div
          ref={flyoutRef}
          className={styles.shapeFlyout}
          style={{ top: flyoutY }}
        >
          {SHAPE_DEFS.map((shape) => (
            <button
              key={shape.id}
              className={`${styles.shapeFlyoutBtn} ${state.activeShape === shape.id ? styles.active : ""}`}
              onClick={() => selectShape(shape.id)}
              title={shape.label}
              aria-label={shape.label}
            >
              {shape.icon}
            </button>
          ))}
        </div>
      )}

      <ColorPickerDialog
        open={dialogOpen}
        title={
          dialogIsSwatchAdd
            ? "Add Color to Palette"
            : `Color Picker (${dialogTarget === "fg" ? "Foreground" : "Background"} Color)`
        }
        initialColor={dialogTarget === "fg" ? fgColor : bgColor}
        onConfirm={handleConfirm}
        onCancel={() => {
          setDialogIsSwatchAdd(false);
          setDialogOpen(false);
        }}
        onAddSwatch={(c) =>
          dispatch({
            type: "ADD_SWATCH",
            payload: {
              r: Math.round(c.r * 255),
              g: Math.round(c.g * 255),
              b: Math.round(c.b * 255),
              a: Math.round(c.a * 255),
            },
          })
        }
        pixelFormat={state.pixelFormat}
      />
      {indexedPickerTarget !== null && (
        <IndexedPaletteColorPicker
          palette={state.swatches}
          activeIndex={state.activePaletteIndex}
          anchorPos={indexedPickerAnchor}
          onSelect={(index, color) => {
            dispatch({ type: "SET_ACTIVE_SWATCH", payload: index });
            // color comes from swatches (0-255); convert to float for AppState.
            dispatch({
              type:
                indexedPickerTarget === "fg"
                  ? "SET_PRIMARY_COLOR"
                  : "SET_SECONDARY_COLOR",
              payload: {
                r: color.r / 255,
                g: color.g / 255,
                b: color.b / 255,
                a: color.a / 255,
              },
            });
          }}
          onClose={() => setIndexedPickerTarget(null)}
          onAddColor={() => {
            setDialogIsSwatchAdd(true);
            setDialogOpen(true);
          }}
        />
      )}
    </>
  );
}
