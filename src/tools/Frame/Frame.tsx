import React, { useCallback, useRef, useState } from "react";
import type {
  FrameLayerState,
  FrameType,
  FrameContentFit,
  RGBAColor,
} from "@/types";
import { useAppContext } from "@/core/store/AppContext";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";
import { loadImagePixels } from "@/core/io/imageLoader";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import frameIconSvg from "./frame.svg?raw";
import { resizeCursorForHandle } from "../_shared/resizeCursor";

// ─── Module-level defaults for new frames ─────────────────────────────────────

export const frameOptions = {
  frameType: "rectangle" as FrameType,
  fit: "fill" as FrameContentFit,
  useStroke: false,
  strokeColor: { r: 0, g: 0, b: 0, a: 255 } as RGBAColor,
  strokeWidth: 2,
};

// ─── Color helpers ────────────────────────────────────────────────────────────

function rgbaToHex(c: RGBAColor): string {
  return (
    "#" +
    [c.r, c.g, c.b]
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")
  );
}

function hexToRgba(hex: string, a = 255): RGBAColor {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
    a,
  };
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function rotatePoint(
  px: number,
  py: number,
  angleRad: number,
): [number, number] {
  const cos = Math.cos(angleRad),
    sin = Math.sin(angleRad);
  return [px * cos - py * sin, px * sin + py * cos];
}

function worldToLocal(
  wx: number,
  wy: number,
  cx: number,
  cy: number,
  angleRad: number,
): [number, number] {
  const dx = wx - cx,
    dy = wy - cy;
  return rotatePoint(dx, dy, -angleRad);
}

const ROTATION_OFFSET = 20;

function getHandleWorldPositions(ls: FrameLayerState): [number, number][] {
  const rad = (ls.rotation * Math.PI) / 180;
  const { cx, cy, w, h } = ls;
  const hw = w / 2,
    hh = h / 2;
  const locals: [number, number][] = [
    [-hw, -hh],
    [0, -hh],
    [hw, -hh],
    [-hw, 0],
    [hw, 0],
    [-hw, hh],
    [0, hh],
    [hw, hh],
    [0, -hh - ROTATION_OFFSET],
  ];
  return locals.map(([lx, ly]) => {
    const [rx, ry] = rotatePoint(lx, ly, rad);
    return [cx + rx, cy + ry];
  });
}

function hitTestHandles(
  ls: FrameLayerState,
  x: number,
  y: number,
  zoom: number,
): number | null {
  const dpr = window.devicePixelRatio;
  const r = Math.max(4, (5 * dpr) / zoom) + 2;
  const handles = getHandleWorldPositions(ls);
  for (let i = 0; i < handles.length; i++) {
    const [hx, hy] = handles[i];
    if ((x - hx) ** 2 + (y - hy) ** 2 <= r * r) return i;
  }
  return null;
}

function hitTestFrameInterior(
  ls: FrameLayerState,
  x: number,
  y: number,
): boolean {
  const [lx, ly] = worldToLocal(
    x,
    y,
    ls.cx,
    ls.cy,
    (ls.rotation * Math.PI) / 180,
  );
  return Math.abs(lx) <= ls.w / 2 + 4 && Math.abs(ly) <= ls.h / 2 + 4;
}

const OPPOSITE: number[] = [7, 6, 5, 4, 3, 2, 1, 0];

function applyResize(
  ls: FrameLayerState,
  handleIdx: number,
  worldDragX: number,
  worldDragY: number,
): FrameLayerState {
  const rad = (ls.rotation * Math.PI) / 180;
  const hw = ls.w / 2,
    hh = ls.h / 2;
  const LOCAL: [number, number][] = [
    [-hw, -hh],
    [0, -hh],
    [hw, -hh],
    [-hw, 0],
    [hw, 0],
    [-hw, hh],
    [0, hh],
    [hw, hh],
  ];
  const [ax, ay] = LOCAL[OPPOSITE[handleIdx]];
  const [lx, ly] = worldToLocal(worldDragX, worldDragY, ls.cx, ls.cy, rad);
  let xMin: number, xMax: number, yMin: number, yMax: number;
  if (handleIdx === 1 || handleIdx === 6) {
    xMin = -hw;
    xMax = hw;
    yMin = Math.min(ay, ly);
    yMax = Math.max(ay, ly);
  } else if (handleIdx === 3 || handleIdx === 4) {
    yMin = -hh;
    yMax = hh;
    xMin = Math.min(ax, lx);
    xMax = Math.max(ax, lx);
  } else {
    xMin = Math.min(ax, lx);
    xMax = Math.max(ax, lx);
    yMin = Math.min(ay, ly);
    yMax = Math.max(ay, ly);
  }
  const newW = Math.max(1, xMax - xMin);
  const newH = Math.max(1, yMax - yMin);
  const newLocalCx = (xMin + xMax) / 2;
  const newLocalCy = (yMin + yMax) / 2;
  const [rwx, rwy] = rotatePoint(newLocalCx, newLocalCy, rad);
  return { ...ls, cx: ls.cx + rwx, cy: ls.cy + rwy, w: newW, h: newH };
}

// ─── Overlay drawing ──────────────────────────────────────────────────────────

function clearOverlay(oc: HTMLCanvasElement): void {
  const c = oc.getContext("2d");
  if (c) c.clearRect(0, 0, oc.width, oc.height);
}

function buildFrameOverlayPath(
  c: CanvasRenderingContext2D,
  ls: FrameLayerState,
): void {
  const hw = ls.w / 2;
  const hh = ls.h / 2;
  c.beginPath();
  if (ls.frameType === "ellipse") {
    c.ellipse(0, 0, Math.max(0.5, hw), Math.max(0.5, hh), 0, 0, Math.PI * 2);
  } else {
    c.rect(-hw, -hh, ls.w, ls.h);
  }
}

function _drawHandlesBody(
  c: CanvasRenderingContext2D,
  ls: FrameLayerState,
  zoom: number,
): void {
  const dpr = window.devicePixelRatio;
  const handleR = Math.max(3.5, (5 * dpr) / zoom);

  const rad = (ls.rotation * Math.PI) / 180;
  const handles = getHandleWorldPositions(ls);
  const hw = ls.w / 2,
    hh = ls.h / 2;

  c.save();
  c.translate(ls.cx, ls.cy);
  c.rotate(rad);
  c.strokeStyle = "rgba(0,120,255,0.85)";
  c.lineWidth = Math.max(0.5, dpr / zoom);
  c.setLineDash([Math.max(2, (4 * dpr) / zoom), Math.max(2, (3 * dpr) / zoom)]);
  buildFrameOverlayPath(c, ls);
  c.stroke();
  if (ls.frameType === "ellipse") {
    c.beginPath();
    c.rect(-hw, -hh, ls.w, ls.h);
    c.stroke();
  }
  c.setLineDash([]);
  c.restore();

  const [tcx, tcy] = handles[1];
  const [rhx, rhy] = handles[8];
  c.save();
  c.strokeStyle = "rgba(0,120,255,0.6)";
  c.lineWidth = Math.max(0.5, dpr / zoom);
  c.beginPath();
  c.moveTo(tcx, tcy);
  c.lineTo(rhx, rhy);
  c.stroke();
  c.restore();

  for (let i = 0; i < handles.length; i++) {
    const [hx, hy] = handles[i];
    c.save();
    if (i === 8) {
      c.beginPath();
      c.arc(hx, hy, handleR, 0, Math.PI * 2);
      c.fillStyle = "#ffffff";
      c.fill();
      c.strokeStyle = "#0078ff";
      c.lineWidth = Math.max(0.8, (1.5 * dpr) / zoom);
      c.stroke();
      c.beginPath();
      c.arc(hx, hy, handleR * 0.55, Math.PI * 0.2, Math.PI * 1.8);
      c.strokeStyle = "#0078ff";
      c.lineWidth = Math.max(0.5, dpr / zoom);
      c.stroke();
    } else {
      const s = handleR * 1.4;
      c.translate(hx, hy);
      c.rotate(rad);
      c.fillStyle = "#ffffff";
      c.fillRect(-s / 2, -s / 2, s, s);
      c.strokeStyle = "#0078ff";
      c.lineWidth = Math.max(0.8, (1.5 * dpr) / zoom);
      c.strokeRect(-s / 2, -s / 2, s, s);
    }
    c.restore();
  }
}

function drawHandles(
  oc: HTMLCanvasElement,
  ls: FrameLayerState,
  zoom: number,
): void {
  const c = oc.getContext("2d");
  if (!c) return;
  c.clearRect(0, 0, oc.width, oc.height);
  _drawHandlesBody(c, ls, zoom);
}

function drawCreationPreview(
  oc: HTMLCanvasElement,
  ls: FrameLayerState,
): void {
  const c = oc.getContext("2d");
  if (!c) return;
  c.clearRect(0, 0, oc.width, oc.height);
  c.save();
  c.translate(ls.cx, ls.cy);
  c.strokeStyle = "rgba(0,120,255,0.85)";
  c.lineWidth = 1;
  c.setLineDash([4, 3]);
  buildFrameOverlayPath(c, ls);
  c.stroke();
  c.setLineDash([]);
  c.save();
  c.clip();
  c.strokeStyle = "rgba(150,150,150,0.7)";
  c.lineWidth = 1;
  const hw = ls.w / 2,
    hh = ls.h / 2;
  c.beginPath();
  c.moveTo(-hw, -hh);
  c.lineTo(hw, hh);
  c.moveTo(hw, -hh);
  c.lineTo(-hw, hh);
  c.stroke();
  c.restore();
  c.restore();
}

// ─── Drawing-mode state (per handler instance) ────────────────────────────────

type Mode =
  | { t: "idle" }
  | { t: "draw"; id: string; sx: number; sy: number }
  | {
      t: "move";
      id: string;
      gx: number;
      gy: number;
      ocx: number;
      ocy: number;
      last: FrameLayerState;
    }
  | { t: "resize"; id: string; hi: number; last: FrameLayerState }
  | { t: "rotate"; id: string; ga: number; or: number; last: FrameLayerState };

// ─── Handler ──────────────────────────────────────────────────────────────────

function frameName(t: FrameType): string {
  return t === "ellipse" ? "Elliptical Frame" : "Frame";
}

function createFrameHandler(): ToolHandler {
  let mode: Mode = { t: "idle" };
  let drawPreview: FrameLayerState | null = null;
  let editLayer: { visible: boolean } | null = null;

  function getActive(ctx: ToolContext): FrameLayerState | null {
    return ctx.activeFrameLayer;
  }

  function modeFrame(ctx: ToolContext): FrameLayerState | null {
    const m = mode;
    if (m.t === "idle" || m.t === "draw") return null;
    return ctx.frameLayers.find((f) => f.id === m.id) ?? null;
  }

  return {
    onActivate(ctx: ToolContext): void {
      // Draw handles for the active frame immediately so the user lands in
      // edit mode (e.g. after double-clicking the frame via the pick tool).
      const active = getActive(ctx);
      if (active && ctx.overlayCanvas) {
        drawHandles(ctx.overlayCanvas, active, ctx.zoom);
      } else if (ctx.overlayCanvas) {
        const c2d = ctx.overlayCanvas.getContext("2d");
        c2d?.clearRect(
          0,
          0,
          ctx.overlayCanvas.width,
          ctx.overlayCanvas.height,
        );
      }
    },
    onPointerDown({ x, y }: ToolPointerPos, ctx: ToolContext): void {
      const active = getActive(ctx);
      if (active) {
        const hi = hitTestHandles(active, x, y, ctx.zoom);
        if (hi !== null) {
          if (hi === 8) {
            const ga =
              (Math.atan2(y - active.cy, x - active.cx) * 180) / Math.PI;
            mode = {
              t: "rotate",
              id: active.id,
              ga,
              or: active.rotation,
              last: active,
            };
          } else {
            mode = { t: "resize", id: active.id, hi, last: active };
          }
          if (ctx.layer && ctx.overlayCanvas) {
            drawHandles(ctx.overlayCanvas, active, ctx.zoom);
            editLayer = ctx.layer;
            ctx.renderer.setPreviewMode(true);
            ctx.render();
          }
          return;
        }
        if (hitTestFrameInterior(active, x, y)) {
          mode = {
            t: "move",
            id: active.id,
            gx: x,
            gy: y,
            ocx: active.cx,
            ocy: active.cy,
            last: active,
          };
          if (ctx.layer && ctx.overlayCanvas) {
            drawHandles(ctx.overlayCanvas, active, ctx.zoom);
            editLayer = ctx.layer;
            ctx.renderer.setPreviewMode(true);
            ctx.render();
          }
          return;
        }
      }

      // Otherwise: start drawing a brand-new frame.
      const id = `frame-${Date.now()}`;
      drawPreview = {
        id,
        name: frameName(frameOptions.frameType),
        visible: true,
        opacity: 1,
        locked: false,
        blendMode: "normal",
        type: "frame",
        frameType: frameOptions.frameType,
        cx: x,
        cy: y,
        w: 1,
        h: 1,
        rotation: 0,
        content: null,
        fit: frameOptions.fit,
        contentOffsetX: 0,
        contentOffsetY: 0,
        contentScale: 1,
        strokeColor: frameOptions.useStroke ? frameOptions.strokeColor : null,
        strokeWidth: frameOptions.strokeWidth,
      };
      mode = { t: "draw", id, sx: x, sy: y };
      if (ctx.overlayCanvas) drawCreationPreview(ctx.overlayCanvas, drawPreview);
    },

    onPointerMove({ x, y, shiftKey }: ToolPointerPos, ctx: ToolContext): void {
      if (mode.t === "draw" && drawPreview) {
        let dx = x - mode.sx,
          dy = y - mode.sy;
        if (shiftKey) {
          const s = Math.max(Math.abs(dx), Math.abs(dy));
          dx = Math.sign(dx) * s;
          dy = Math.sign(dy) * s;
        }
        const w = Math.max(1, Math.abs(dx));
        const h = Math.max(1, Math.abs(dy));
        const cx = mode.sx + dx / 2;
        const cy = mode.sy + dy / 2;
        const updated: FrameLayerState = { ...drawPreview, cx, cy, w, h };
        drawPreview = updated;
        if (ctx.overlayCanvas) drawCreationPreview(ctx.overlayCanvas, updated);
        return;
      }

      const frame = modeFrame(ctx);
      if (!frame) return;

      let updated: FrameLayerState | null = null;

      if (mode.t === "move") {
        const dx = x - mode.gx,
          dy = y - mode.gy;
        updated = {
          ...frame,
          cx: mode.ocx + dx,
          cy: mode.ocy + dy,
        };
        mode = { ...mode, last: updated };
      } else if (mode.t === "resize") {
        updated = applyResize(frame, mode.hi, x, y);
        mode = { ...mode, last: updated };
      } else if (mode.t === "rotate") {
        const ga = (Math.atan2(y - frame.cy, x - frame.cx) * 180) / Math.PI;
        const rot = mode.or + (ga - mode.ga);
        updated = { ...frame, rotation: rot };
        mode = { ...mode, last: updated };
      }

      if (updated) {
        ctx.previewFrameLayer(updated);
        if (ctx.overlayCanvas)
          drawHandles(ctx.overlayCanvas, updated, ctx.zoom);
      }
    },

    onPointerUp(_pos: ToolPointerPos, ctx: ToolContext): void {
      if (mode.t === "draw" && drawPreview) {
        if (ctx.overlayCanvas) clearOverlay(ctx.overlayCanvas);
        const ls = drawPreview;
        const hasSize = ls.w > 2 && ls.h > 2;
        if (hasSize) {
          ctx.addFrameLayer(ls);
          ctx.commitStroke(`Frame (${ls.frameType})`);
          if (ctx.overlayCanvas) drawHandles(ctx.overlayCanvas, ls, ctx.zoom);
        }
        drawPreview = null;
        mode = { t: "idle" };
        return;
      }

      const frame = modeFrame(ctx);
      const finalState = (mode as { last?: FrameLayerState }).last ?? frame;
      if (finalState && mode.t !== "idle") {
        editLayer = null;
        ctx.renderer.setPreviewMode(false);
        ctx.previewFrameLayer(finalState);
        ctx.updateFrameLayer(finalState);
        ctx.commitStroke("Edit frame");
        if (ctx.overlayCanvas)
          drawHandles(ctx.overlayCanvas, finalState, ctx.zoom);
      } else if (editLayer) {
        editLayer = null;
        ctx.renderer.setPreviewMode(false);
        ctx.render();
      }
      mode = { t: "idle" };
    },

    onHover(pos: ToolPointerPos, ctx: ToolContext): void {
      // Skip hover handling while in an interactive drag — onPointerMove owns
      // the overlay during move/resize/rotate and a stale getActive() here
      // would flash the handles at the pre-drag position.
      if (mode.t !== "idle" && mode.t !== "draw") return;
      const active = getActive(ctx);
      if (ctx.overlayCanvas) {
        if (active) drawHandles(ctx.overlayCanvas, active, ctx.zoom);
        else clearOverlay(ctx.overlayCanvas);
      }
      // Direction-aware resize cursor when hovering a handle.
      let cursor = "";
      if (active) {
        const hi = hitTestHandles(active, pos.x, pos.y, ctx.zoom);
        if (hi !== null) {
          if (hi === 8) cursor = "grab";
          else cursor = resizeCursorForHandle(hi, active.rotation) ?? "";
        }
      }
      ctx.setCursor(cursor);
    },

    onLeave(ctx: ToolContext): void {
      if (ctx.overlayCanvas) clearOverlay(ctx.overlayCanvas);
      ctx.setCursor("");
    },
  };
}

// ─── Image-loading helpers (used by the Place button) ─────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function mimeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "tga":
      return "image/x-tga";
    case "exr":
      return "image/x-exr";
    case "hdr":
      return "image/vnd.radiance";
    case "dds":
      return "image/vnd.ms-dds";
    default:
      return "image/png";
  }
}

async function loadImageFromDataUrl(
  dataUrl: string,
): Promise<{ rgba: string; width: number; height: number } | null> {
  try {
    const loaded = await loadImagePixels(dataUrl);
    let bytes: Uint8Array;
    if (loaded.data instanceof Uint8Array) {
      bytes = loaded.data;
    } else {
      // Convert HDR float pixels to clamped 8-bit; frames don't preserve HDR.
      const f32 = loaded.data;
      bytes = new Uint8Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        bytes[i] = Math.max(0, Math.min(255, Math.round(f32[i] * 255)));
      }
    }
    return {
      rgba: uint8ArrayToBase64(bytes),
      width: loaded.width,
      height: loaded.height,
    };
  } catch (err) {
    console.error("Frame: failed to load image:", err);
    return null;
  }
}

async function pickImageFromDisk(): Promise<{
  rgba: string;
  width: number;
  height: number;
} | null> {
  const path = await window.api.openFile();
  if (!path) return null;
  const base64 = await window.api.readFileBase64(path);
  const ext = path.split(".").pop() ?? "png";
  const dataUrl = `data:${mimeForExtension(ext)};base64,${base64}`;
  return loadImageFromDataUrl(dataUrl);
}

// ─── Options UI ───────────────────────────────────────────────────────────────

const FRAME_TYPES: { id: FrameType; label: string }[] = [
  { id: "rectangle", label: "Rect" },
  { id: "ellipse", label: "Ellipse" },
];

const FIT_MODES: { id: FrameContentFit; label: string }[] = [
  { id: "fill", label: "Fill" },
  { id: "fit", label: "Fit" },
  { id: "stretch", label: "Stretch" },
  { id: "center", label: "Centre" },
];

function FrameOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const { state, dispatch } = useAppContext();
  // Bumped whenever module-level options change so the bar re-renders even
  // without an active frame to dispatch UPDATE_FRAME_LAYER on.
  const [, setTick] = useState(0);
  const refreshOptions = useCallback(() => setTick((n) => n + 1), []);

  const activeFrame =
    state.layers.find(
      (l): l is FrameLayerState =>
        "type" in l && l.type === "frame" && l.id === state.activeLayerId,
    ) ?? null;

  const curType = activeFrame?.frameType ?? frameOptions.frameType;
  const curFit = activeFrame?.fit ?? frameOptions.fit;
  const curUseStroke = activeFrame
    ? activeFrame.strokeColor !== null
    : frameOptions.useStroke;
  const curStrokeColor: RGBAColor =
    activeFrame?.strokeColor ?? frameOptions.strokeColor;
  const curStrokeWidth = activeFrame?.strokeWidth ?? frameOptions.strokeWidth;

  const update = useCallback(
    (patch: Partial<FrameLayerState>) => {
      if (!activeFrame) return;
      dispatch({
        type: "UPDATE_FRAME_LAYER",
        payload: { ...activeFrame, ...patch },
      });
    },
    [activeFrame, dispatch],
  );

  const setType = useCallback(
    (t: FrameType) => {
      frameOptions.frameType = t;
      if (activeFrame) update({ frameType: t });
      else refreshOptions();
    },
    [activeFrame, update, refreshOptions],
  );

  const setFit = useCallback(
    (f: FrameContentFit) => {
      frameOptions.fit = f;
      if (activeFrame)
        update({
          fit: f,
          contentOffsetX: 0,
          contentOffsetY: 0,
          contentScale: 1,
        });
      else refreshOptions();
    },
    [activeFrame, update, refreshOptions],
  );

  const toggleStroke = useCallback(() => {
    const next = !curUseStroke;
    frameOptions.useStroke = next;
    if (activeFrame) {
      update({
        strokeColor: next
          ? (activeFrame.strokeColor ?? frameOptions.strokeColor)
          : null,
      });
    } else {
      refreshOptions();
    }
  }, [curUseStroke, activeFrame, update, refreshOptions]);

  const setStrokeWidth = useCallback(
    (v: number) => {
      const w = Math.max(0, Math.round(v));
      frameOptions.strokeWidth = w;
      if (activeFrame) update({ strokeWidth: w });
      else refreshOptions();
    },
    [activeFrame, update, refreshOptions],
  );

  const setStrokeColor = useCallback(
    (hex: string) => {
      const color = hexToRgba(hex, curStrokeColor.a);
      frameOptions.strokeColor = color;
      if (activeFrame && activeFrame.strokeColor) update({ strokeColor: color });
      else refreshOptions();
    },
    [curStrokeColor.a, activeFrame, update, refreshOptions],
  );

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePlace = useCallback(async () => {
    if (!activeFrame) return;
    if (typeof window.api?.openFile === "function") {
      const result = await pickImageFromDisk();
      if (!result) return;
      dispatch({
        type: "UPDATE_FRAME_LAYER",
        payload: {
          ...activeFrame,
          content: result,
          contentOffsetX: 0,
          contentOffsetY: 0,
          contentScale: 1,
        },
      });
    } else {
      fileInputRef.current?.click();
    }
  }, [activeFrame, dispatch]);

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !activeFrame) return;
      const buf = await file.arrayBuffer();
      const dataUrl = `data:${file.type || "image/png"};base64,${uint8ArrayToBase64(new Uint8Array(buf))}`;
      const result = await loadImageFromDataUrl(dataUrl);
      if (!result) return;
      dispatch({
        type: "UPDATE_FRAME_LAYER",
        payload: {
          ...activeFrame,
          content: result,
          contentOffsetX: 0,
          contentOffsetY: 0,
          contentScale: 1,
        },
      });
    },
    [activeFrame, dispatch],
  );

  const handleClear = useCallback(() => {
    if (!activeFrame) return;
    dispatch({
      type: "UPDATE_FRAME_LAYER",
      payload: {
        ...activeFrame,
        content: null,
        contentOffsetX: 0,
        contentOffsetY: 0,
        contentScale: 1,
      },
    });
  }, [activeFrame, dispatch]);

  return (
    <>
      <span className={styles.optLabel}>Shape</span>
      <select
        className={styles.optSelect}
        value={curType}
        onChange={(e) => setType(e.target.value as FrameType)}
        style={{ width: 90 }}
      >
        {FRAME_TYPES.map(({ id, label }) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>

      <div className={styles.optSep} />

      <span className={styles.optLabel}>Fit</span>
      <select
        className={styles.optSelect}
        value={curFit}
        onChange={(e) => setFit(e.target.value as FrameContentFit)}
        style={{ width: 90 }}
      >
        {FIT_MODES.map(({ id, label }) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>

      <div className={styles.optSep} />

      <label className={styles.optCheckLabel}>
        <input
          type="checkbox"
          checked={curUseStroke}
          onChange={toggleStroke}
        />
        Stroke
      </label>
      {curUseStroke && (
        <ColorSwatch
          value={rgbaToHex(curStrokeColor)}
          title="Stroke color"
          onChange={setStrokeColor}
        />
      )}
      {curUseStroke && (
        <>
          <span className={styles.optLabel}>W</span>
          <SliderInput
            value={curStrokeWidth}
            min={0}
            max={50}
            onChange={setStrokeWidth}
          />
        </>
      )}

      <div className={styles.optSep} />

      <button
        type="button"
        className={styles.optBtn}
        onClick={handlePlace}
        disabled={!activeFrame}
        title={
          activeFrame
            ? "Place an image inside this frame"
            : "Draw a frame first to place an image"
        }
      >
        Place image…
      </button>
      {activeFrame && activeFrame.content && (
        <button
          type="button"
          className={styles.optBtn}
          onClick={handleClear}
          title="Remove the image from this frame"
        >
          Clear
        </button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleFileInputChange}
      />
    </>
  );
}

// ─── Tool definition ──────────────────────────────────────────────────────────

class FrameTool implements ITool {
  readonly id = "frame";
  readonly label = "Frame";
  readonly shortcut = "K";
  readonly icon = <SvgIcon src={frameIconSvg} />;
  readonly placement = { group: ToolGroup.Crop, row: 0, column: 1 } as const;
  // Frame layers are parametric and rasterized by the canvas — the tool needs
  // to be allowed to operate on its own (non-pixel) layer type.
  readonly worksOnAllLayers = true;
  readonly indexed8Unsupported = true;
  createHandler(): ToolHandler {
    return createFrameHandler();
  }
  readonly Options = FrameOptions;
}

export const frameTool: ITool = new FrameTool();
