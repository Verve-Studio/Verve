import React, { useEffect, useState, useCallback } from "react";

import type {
  TransformParams,
  Point,
  TransformHandleMode,
  TransformInterpolation,
} from "@/types";
import styles from "./transform.module.scss";
import { resizeCursorForHandle } from "../_shared/resizeCursor";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { activeScope } from "@/core/store/scope";
import type { TransformStore } from "@/core/store/transformStore";

// ─── Matrix helpers ───────────────────────────────────────────────────────────

type M3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

function m3mul(A: M3, B: M3): M3 {
  return [
    A[0] * B[0] + A[1] * B[3] + A[2] * B[6],
    A[0] * B[1] + A[1] * B[4] + A[2] * B[7],
    A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
    A[3] * B[0] + A[4] * B[3] + A[5] * B[6],
    A[3] * B[1] + A[4] * B[4] + A[5] * B[7],
    A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
    A[6] * B[0] + A[7] * B[3] + A[8] * B[6],
    A[6] * B[1] + A[7] * B[4] + A[8] * B[7],
    A[6] * B[2] + A[7] * B[5] + A[8] * B[8],
  ] as unknown as M3;
}

function t3(tx: number, ty: number): M3 {
  return [1, 0, tx, 0, 1, ty, 0, 0, 1] as unknown as M3;
}

function s3(sx: number, sy: number): M3 {
  return [sx, 0, 0, 0, sy, 0, 0, 0, 1] as unknown as M3;
}

function r3(rad: number): M3 {
  const cos = Math.cos(rad),
    sin = Math.sin(rad);
  return [cos, -sin, 0, sin, cos, 0, 0, 0, 1] as unknown as M3;
}

function sh3(shX: number, shY: number): M3 {
  return [1, shX, 0, shY, 1, 0, 0, 0, 1] as unknown as M3;
}

function invertM3(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, k] = m;
  const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-10)
    return [1, 0, 0, 0, 1, 0, 0, 0, 1] as unknown as M3;
  const inv = 1 / det;
  return [
    (e * k - f * h) * inv,
    (c * h - b * k) * inv,
    (b * f - c * e) * inv,
    (f * g - d * k) * inv,
    (a * k - c * g) * inv,
    (c * d - a * f) * inv,
    (d * h - e * g) * inv,
    (b * g - a * h) * inv,
    (a * e - b * d) * inv,
  ] as unknown as M3;
}

/**
 * Compute the 3×3 forward affine matrix mapping content pixel (u,v) → canvas (x,y).
 *
 * setTransform(a_set, b_set, c_set, d_set, e_set, f_set) where:
 *   x_canvas = a_set * u + c_set * v + e_set
 *   y_canvas = b_set * u + d_set * v + f_set
 *
 * Returns row-major [M00, M01, M02, M10, M11, M12, M20, M21, M22].
 */
export function computeForwardMatrix(
  params: TransformParams,
  origW: number,
  origH: number,
): M3 {
  const rad = (params.rotation * Math.PI) / 180;
  const sx = origW > 0 ? params.w / origW : 1;
  const sy = origH > 0 ? params.h / origH : 1;
  const shX = Math.tan((params.shearX * Math.PI) / 180);
  const shY = Math.tan((params.shearY * Math.PI) / 180);
  // T(pivot) · R · T(box_tl - pivot) · S · Sh
  // Maps content pixel (u,v) → rotateAround(x + u*sx, y + v*sy, pivotX, pivotY, rad)
  return m3mul(
    t3(params.pivotX, params.pivotY),
    m3mul(
      r3(rad),
      m3mul(
        t3(params.x - params.pivotX, params.y - params.pivotY),
        m3mul(s3(sx, sy), sh3(shX, shY)),
      ),
    ),
  );
}

/**
 * Compute the 6-element inverse affine vector for WASM:
 *   [a, b, tx, c, d, ty]
 *   srcX = a*dstX + b*dstY + tx
 *   srcY = c*dstX + d*dstY + ty
 */
export function computeInverseAffine(
  params: TransformParams,
  origW: number,
  origH: number,
): Float32Array {
  const fwd = computeForwardMatrix(params, origW, origH);
  const inv = invertM3(fwd);
  return new Float32Array([inv[0], inv[1], inv[2], inv[3], inv[4], inv[5]]);
}

/**
 * Compute the 9-element inverse homography for perspective WASM.
 * srcQuad and dstQuad are [TL, TR, BR, BL].
 * Returns H_inv as Float32Array(9) row-major.
 */
export function computeInverseHomography(
  srcQuad: [Point, Point, Point, Point],
  dstQuad: [Point, Point, Point, Point],
): Float32Array {
  const H = computeHomographyDLT(srcQuad, dstQuad);
  const inv = invertM3(H);
  return new Float32Array(inv as unknown as number[]);
}

function computeHomographyDLT(
  src: [Point, Point, Point, Point],
  dst: [Point, Point, Point, Point],
): M3 {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const sx = src[i].x,
      sy = src[i].y;
    const dx = dst[i].x,
      dy = dst[i].y;
    A.push([-sx, -sy, -1, 0, 0, 0, dx * sx, dx * sy, dx]);
    A.push([0, 0, 0, -sx, -sy, -1, dy * sx, dy * sy, dy]);
  }
  const b = A.map((row) => -row[8]);
  const M8 = A.map((row) => row.slice(0, 8));
  const h8 = gaussianElim8(M8, b);
  return [
    h8[0],
    h8[1],
    h8[2],
    h8[3],
    h8[4],
    h8[5],
    h8[6],
    h8[7],
    1,
  ] as unknown as M3;
}

function gaussianElim8(A: number[][], b: number[]): number[] {
  const n = 8;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    if (Math.abs(aug[col][col]) < 1e-10) continue;
    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / aug[col][col];
      for (let k = col; k <= n; k++) aug[row][k] -= factor * aug[col][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = aug[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= aug[i][j] * x[j];
    x[i] /= aug[i][i];
  }
  return x;
}

// ─── Handle geometry ──────────────────────────────────────────────────────────

const ROTATION_OFFSET = 34;

/**
 * Handle indices:
 *   0 TL, 1 TC, 2 TR
 *   3 ML,        4 MR
 *   5 BL, 6 BC, 7 BR
 *   8 rotation (above TC)
 *   9 pivot
 *  10 perspective TL, 11 TR, 12 BR, 13 BL
 */
export const HANDLE_TRANSLATE = 99;

function rotateAround(
  px: number,
  py: number,
  cx: number,
  cy: number,
  rad: number,
): Point {
  const dx = px - cx,
    dy = py - cy;
  const cos = Math.cos(rad),
    sin = Math.sin(rad);
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

export function getHandleWorldPositions(params: TransformParams): Point[] {
  const { x, y, w, h, rotation, pivotX, pivotY } = params;
  const rad = (rotation * Math.PI) / 180;
  const rot = (px: number, py: number): Point =>
    rotateAround(px, py, pivotX, pivotY, rad);

  const handles: Point[] = [
    rot(x, y), // 0 TL
    rot(x + w / 2, y), // 1 TC
    rot(x + w, y), // 2 TR
    rot(x, y + h / 2), // 3 ML
    rot(x + w, y + h / 2), // 4 MR
    rot(x, y + h), // 5 BL
    rot(x + w / 2, y + h), // 6 BC
    rot(x + w, y + h), // 7 BR
    rot(x + w / 2, y - ROTATION_OFFSET), // 8 rotation
    { x: pivotX, y: pivotY }, // 9 pivot
  ];

  if (params.perspectiveCorners) {
    handles.push(...params.perspectiveCorners); // 10-13
  }

  return handles;
}

function hitTestHandle(
  handles: Point[],
  px: number,
  py: number,
  zoom: number,
  handleMode: "scale" | "perspective" | "shear" = "scale",
): number | null {
  const dpr = window.devicePixelRatio;
  const r = Math.max(5, (6 * dpr) / zoom);
  for (let i = 0; i < handles.length; i++) {
    // In perspective mode, the perspective-corner handles (10-13) sit on top
    // of the scale corner handles (0,2,5,7). Disable scale + rotation + pivot
    // so the corners 10-13 win the hit-test and the user can drag them.
    if (handleMode === "perspective" && i >= 0 && i <= 9) continue;
    if ((px - handles[i].x) ** 2 + (py - handles[i].y) ** 2 <= r * r) return i;
  }
  return null;
}

function isInsideBox(params: TransformParams, px: number, py: number): boolean {
  const { x, y, w, h, rotation, pivotX, pivotY } = params;
  const rad = -(rotation * Math.PI) / 180;
  const local = rotateAround(px, py, pivotX, pivotY, rad);
  return (
    local.x >= x - 2 &&
    local.x <= x + w + 2 &&
    local.y >= y - 2 &&
    local.y <= y + h + 2
  );
}

// ─── Drag math helpers ────────────────────────────────────────────────────────

const OPPOSITE = [7, 6, 5, 4, 3, 2, 1, 0];

function applyScaleDrag(
  params: TransformParams,
  handleIdx: number,
  currentPos: Point,
  startParams: TransformParams,
  shiftKey: boolean,
): TransformParams {
  const { x, y, w, h, rotation, pivotX, pivotY } = startParams;
  const rad = (rotation * Math.PI) / 180;
  // Unrotate drag point into box-local space
  const localCurrent = rotateAround(
    currentPos.x,
    currentPos.y,
    pivotX,
    pivotY,
    -rad,
  );

  const boxLocalHandles: Point[] = [
    { x, y }, // 0 TL
    { x: x + w / 2, y }, // 1 TC
    { x: x + w, y }, // 2 TR
    { x, y: y + h / 2 }, // 3 ML
    { x: x + w, y: y + h / 2 }, // 4 MR
    { x, y: y + h }, // 5 BL
    { x: x + w / 2, y: y + h }, // 6 BC
    { x: x + w, y: y + h }, // 7 BR
  ];

  const anchor = boxLocalHandles[OPPOSITE[handleIdx]];
  const drag = localCurrent;

  let xMin: number, xMax: number, yMin: number, yMax: number;

  if (handleIdx === 1 || handleIdx === 6) {
    xMin = anchor.x - w / 2;
    xMax = anchor.x + w / 2;
    yMin = Math.min(anchor.y, drag.y);
    yMax = Math.max(anchor.y, drag.y);
  } else if (handleIdx === 3 || handleIdx === 4) {
    yMin = anchor.y - h / 2;
    yMax = anchor.y + h / 2;
    xMin = Math.min(anchor.x, drag.x);
    xMax = Math.max(anchor.x, drag.x);
  } else {
    xMin = Math.min(anchor.x, drag.x);
    xMax = Math.max(anchor.x, drag.x);
    yMin = Math.min(anchor.y, drag.y);
    yMax = Math.max(anchor.y, drag.y);
  }

  let newW = Math.max(1, xMax - xMin);
  let newH = Math.max(1, yMax - yMin);

  const isCorner =
    handleIdx === 0 || handleIdx === 2 || handleIdx === 5 || handleIdx === 7;
  if ((shiftKey || activeScope().transform.aspectLocked) && isCorner) {
    const origAspect = startParams.w / startParams.h;
    const constrainBy = Math.max(newW / origAspect, newH) > newH ? "w" : "h";
    if (constrainBy === "w") newH = newW / origAspect;
    else newW = newH * origAspect;
  }

  // Maintain pivot's proportional position within the bounding box.
  // fx/fy is the pivot's fractional position in the old box (model space).
  // Rotate the new model-space pivot back to canvas space using the old rotation center.
  const fx = w > 0 ? (pivotX - x) / w : 0.5;
  const fy = h > 0 ? (pivotY - y) / h : 0.5;
  const newPivotCanvas = rotateAround(
    xMin + fx * newW,
    yMin + fy * newH,
    pivotX,
    pivotY,
    rad,
  );

  return {
    ...params,
    ...startParams,
    x: newPivotCanvas.x - newW / 2,
    y: newPivotCanvas.y - newH / 2,
    w: newW,
    h: newH,
    pivotX: newPivotCanvas.x,
    pivotY: newPivotCanvas.y,
  };
}

function applyRotateDrag(
  params: TransformParams,
  currentPos: Point,
  dragStartPos: Point,
  startParams: TransformParams,
  shiftKey: boolean,
): TransformParams {
  const { pivotX, pivotY } = startParams;
  const startAngle = Math.atan2(
    dragStartPos.y - pivotY,
    dragStartPos.x - pivotX,
  );
  const currentAngle = Math.atan2(currentPos.y - pivotY, currentPos.x - pivotX);
  let delta = (currentAngle - startAngle) * (180 / Math.PI);
  if (shiftKey) delta = Math.round(delta / 15) * 15;
  let rotation = startParams.rotation + delta;
  rotation = rotation % 360;
  if (rotation > 180) rotation -= 360;
  if (rotation < -180) rotation += 360;
  return { ...params, ...startParams, rotation };
}

function applyTranslateDrag(
  params: TransformParams,
  delta: Point,
  startParams: TransformParams,
): TransformParams {
  return {
    ...params,
    ...startParams,
    x: startParams.x + delta.x,
    y: startParams.y + delta.y,
    pivotX: startParams.pivotX + delta.x,
    pivotY: startParams.pivotY + delta.y,
  };
}

function applyPivotDrag(
  params: TransformParams,
  currentPos: Point,
  _startParams: TransformParams,
): TransformParams {
  return { ...params, pivotX: currentPos.x, pivotY: currentPos.y };
}

/**
 * Strict-convexity test for the 4 perspective corners. All four signed
 * cross-products at each vertex must share the same sign — any zero crossing
 * (three collinear points) or sign flip (concave / self-intersecting) fails.
 */
function isStrictlyConvexQuad(corners: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p = corners[(i + 3) % 4];
    const c = corners[i];
    const n = corners[(i + 1) % 4];
    const cr = (c.x - p.x) * (n.y - c.y) - (c.y - p.y) * (n.x - c.x);
    if (cr === 0) return false;
    if (sign === 0) sign = Math.sign(cr);
    else if (Math.sign(cr) !== sign) return false;
  }
  return true;
}

/**
 * Clamp the dragged-to position so the resulting quadrilateral stays strictly
 * convex. If the user tries to push the corner past the point where three
 * vertices become collinear, we walk backward along the drag vector until
 * convexity is regained — i.e. we pin the corner at the "straight line"
 * boundary rather than letting it cross over.
 */
function clampPerspectiveCornerToConvex(
  otherCorners: readonly [Point, Point, Point, Point],
  cornerIdx: number,
  startPos: Point,
  targetPos: Point,
): Point {
  const trial: [Point, Point, Point, Point] = [
    otherCorners[0],
    otherCorners[1],
    otherCorners[2],
    otherCorners[3],
  ];
  trial[cornerIdx] = targetPos;
  if (isStrictlyConvexQuad(trial)) return targetPos;

  // Binary-search the largest t in [0, 1] along (startPos → targetPos) for
  // which the quad is still strictly convex.
  let lo = 0;
  let hi = 1;
  for (let iter = 0; iter < 24; iter++) {
    const mid = (lo + hi) / 2;
    trial[cornerIdx] = {
      x: startPos.x + (targetPos.x - startPos.x) * mid,
      y: startPos.y + (targetPos.y - startPos.y) * mid,
    };
    if (isStrictlyConvexQuad(trial)) lo = mid;
    else hi = mid;
  }
  return {
    x: startPos.x + (targetPos.x - startPos.x) * lo,
    y: startPos.y + (targetPos.y - startPos.y) * lo,
  };
}

function applyPerspectiveDrag(
  params: TransformParams,
  cornerIdx: number, // 0-3 within perspectiveCorners
  currentPos: Point,
  shiftKey: boolean,
  startParams: TransformParams,
): TransformParams {
  if (!startParams.perspectiveCorners) return params;
  const corners = [...startParams.perspectiveCorners] as [
    Point,
    Point,
    Point,
    Point,
  ];
  const start = corners[cornerIdx];
  let nx = currentPos.x,
    ny = currentPos.y;
  if (shiftKey) {
    const dx = Math.abs(nx - start.x),
      dy = Math.abs(ny - start.y);
    if (dx > dy) ny = start.y;
    else nx = start.x;
  }
  // Convexity clamp: prevent the user from making the quad concave (or
  // self-intersecting). At worst the dragged corner sits on the line through
  // the two non-moved neighbours — i.e. three points become collinear.
  const clamped = clampPerspectiveCornerToConvex(
    corners,
    cornerIdx,
    start,
    { x: nx, y: ny },
  );
  corners[cornerIdx] = clamped;
  return { ...params, perspectiveCorners: corners };
}

function applyShearDrag(
  params: TransformParams,
  edgeIdx: number, // 1=TC, 3=ML, 4=MR, 6=BC
  currentPos: Point,
  dragStartPos: Point,
  startParams: TransformParams,
): TransformParams {
  const dx = currentPos.x - dragStartPos.x;
  const dy = currentPos.y - dragStartPos.y;
  const rad = (startParams.rotation * Math.PI) / 180;
  const cos = Math.cos(rad),
    sin = Math.sin(rad);
  // Transform delta into unrotated box space
  const localDx = dx * cos + dy * sin;
  const localDy = -dx * sin + dy * cos;

  let shearX = startParams.shearX;
  let shearY = startParams.shearY;
  if (edgeIdx === 1 || edgeIdx === 6) {
    const shearPx = localDx / Math.max(1, startParams.h);
    shearX = Math.max(
      -85,
      Math.min(85, startParams.shearX + shearPx * (180 / Math.PI)),
    );
  } else if (edgeIdx === 3 || edgeIdx === 4) {
    const shearPy = localDy / Math.max(1, startParams.w);
    shearY = Math.max(
      -85,
      Math.min(85, startParams.shearY + shearPy * (180 / Math.PI)),
    );
  }
  return { ...params, ...startParams, shearX, shearY };
}

// ─── Overlay drawing ──────────────────────────────────────────────────────────

const HANDLE_SIZE = 5;
const DASHED_BOX_COLOR = "#0699fb";
const PERSPECTIVE_CORNER_COLOR = "#ff8c00";
const SHEAR_EDGE_COLOR = "rgba(120,220,80,0.9)";

export function drawTransformOverlay(
  overlayCanvas: HTMLCanvasElement,
  store: TransformStore,
  zoom: number,
): void {
  const ctx = overlayCanvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!store.isActive) return;

  const { params, handleMode, floatCanvas, originalW, originalH } = store;
  const dpr = window.devicePixelRatio;
  const lw = Math.max(0.5, dpr / zoom);

  // 1. Draw live preview
  if (floatCanvas && params.perspectiveCorners === null) {
    // Affine modes: use canvas setTransform (fast, exact)
    const fwd = computeForwardMatrix(params, originalW, originalH);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(fwd[0], fwd[3], fwd[1], fwd[4], fwd[2], fwd[5]);
    ctx.drawImage(floatCanvas, 0, 0);
    ctx.restore();
  } else if (floatCanvas && params.perspectiveCorners !== null) {
    // Perspective mode: mesh-based subdivision preview
    drawPerspectivePreview(
      ctx,
      floatCanvas,
      originalW,
      originalH,
      params.perspectiveCorners,
    );
  }

  const handles = getHandleWorldPositions(params);

  if (handleMode === "perspective" && params.perspectiveCorners) {
    // Draw quad outline
    const corners = params.perspectiveCorners;
    ctx.save();
    ctx.strokeStyle = PERSPECTIVE_CORNER_COLOR;
    ctx.lineWidth = lw;
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // Draw 4 corner handles (10-13)
    for (let i = 10; i <= 13; i++) {
      drawSquareHandle(
        ctx,
        handles[i],
        HANDLE_SIZE,
        zoom,
        PERSPECTIVE_CORNER_COLOR,
      );
    }
  } else if (handleMode === "shear") {
    // Draw dashed bounding box
    drawDashedBoundingBox(ctx, params, lw, zoom);
    // Edge handles only (1, 3, 4, 6) — elongated bars oriented to their axis
    const shearEdges: Array<[number, boolean]> = [
      [1, true],
      [3, false],
      [4, false],
      [6, true],
    ];
    for (const [idx, isHoriz] of shearEdges) {
      drawShearHandle(ctx, handles[idx], zoom, SHEAR_EDGE_COLOR, isHoriz);
    }
    // Pivot
    drawPivotCrosshair(ctx, params.pivotX, params.pivotY, zoom);
  } else {
    // Scale mode
    drawDashedBoundingBox(ctx, params, lw, zoom);
    // Draw corner + edge handles (0-7)
    for (let i = 0; i <= 7; i++) {
      drawSquareHandle(ctx, handles[i], HANDLE_SIZE, zoom, "#ffffff");
    }
    // Rotation handle (8)
    const rotH = handles[8];
    const tc = handles[1];
    ctx.save();
    ctx.strokeStyle = DASHED_BOX_COLOR;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(tc.x, tc.y);
    ctx.lineTo(rotH.x, rotH.y);
    ctx.stroke();
    ctx.restore();
    drawCircleHandle(ctx, rotH, HANDLE_SIZE, zoom, DASHED_BOX_COLOR);
    // Pivot
    drawPivotCrosshair(ctx, params.pivotX, params.pivotY, zoom);
  }
}

function drawDashedBoundingBox(
  ctx: CanvasRenderingContext2D,
  params: TransformParams,
  lw: number,
  zoom: number,
): void {
  const handles = getHandleWorldPositions(params);
  const corners = [handles[0], handles[2], handles[7], handles[5]];
  ctx.save();
  ctx.strokeStyle = DASHED_BOX_COLOR;
  ctx.lineWidth = lw;
  ctx.setLineDash([4 / zoom, 4 / zoom]);
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++)
    ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// ─── Perspective mesh preview helpers ─────────────────────────────────────────

/**
 * Draw a single textured triangle using clip + affine setTransform.
 * (su0,sv0), (su1,sv1), (su2,sv2) are the source corners in floatCanvas pixel space.
 * dp0, dp1, dp2 are the corresponding destination corners in overlay canvas pixel space.
 */
function drawTexturedTri(
  ctx: CanvasRenderingContext2D,
  img: OffscreenCanvas,
  su0: number,
  sv0: number,
  su1: number,
  sv1: number,
  su2: number,
  sv2: number,
  dp0: Point,
  dp1: Point,
  dp2: Point,
): void {
  const dx1 = su1 - su0,
    dy1 = sv1 - sv0;
  const dx2 = su2 - su0,
    dy2 = sv2 - sv0;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-6) return;
  const invDet = 1 / det;

  const ddx1 = dp1.x - dp0.x,
    ddy1 = dp1.y - dp0.y;
  const ddx2 = dp2.x - dp0.x,
    ddy2 = dp2.y - dp0.y;

  // Affine matrix M: src → canvas
  //   x_canvas = a*su + b*sv + tx
  //   y_canvas = c*su + d*sv + ty
  const a = (ddx1 * dy2 - ddx2 * dy1) * invDet;
  const b = (ddx2 * dx1 - ddx1 * dx2) * invDet;
  const c = (ddy1 * dy2 - ddy2 * dy1) * invDet;
  const d = (ddy2 * dx1 - ddy1 * dx2) * invDet;
  const tx = dp0.x - a * su0 - b * sv0;
  const ty = dp0.y - c * su0 - d * sv0;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dp0.x, dp0.y);
  ctx.lineTo(dp1.x, dp1.y);
  ctx.lineTo(dp2.x, dp2.y);
  ctx.closePath();
  ctx.clip();
  // canvas setTransform(a_c, b_c, c_c, d_c, e, f):
  //   x' = a_c*x + c_c*y + e,  y' = b_c*x + d_c*y + f
  ctx.setTransform(a, c, b, d, tx, ty);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/**
 * Perspective-correct preview by subdividing floatCanvas into a mesh and drawing
 * each cell as two triangles with affine setTransform.
 * Uses the true projective homography (not bilinear) for grid vertices.
 */
function drawPerspectivePreview(
  ctx: CanvasRenderingContext2D,
  floatCanvas: OffscreenCanvas,
  origW: number,
  origH: number,
  corners: [Point, Point, Point, Point], // TL, TR, BR, BL in canvas coords
): void {
  const srcQuad: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: origW, y: 0 },
    { x: origW, y: origH },
    { x: 0, y: origH },
  ];
  let H: M3;
  try {
    H = computeHomographyDLT(srcQuad, corners);
  } catch {
    return;
  }

  const project = (u: number, v: number): Point => {
    const w = H[6] * u + H[7] * v + H[8];
    if (Math.abs(w) < 1e-9) return { x: 0, y: 0 };
    return {
      x: (H[0] * u + H[1] * v + H[2]) / w,
      y: (H[3] * u + H[4] * v + H[5]) / w,
    };
  };

  const DIVS = 16;
  const cellW = origW / DIVS;
  const cellH = origH / DIVS;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  for (let j = 0; j < DIVS; j++) {
    for (let i = 0; i < DIVS; i++) {
      const u0 = i * cellW,
        v0 = j * cellH;
      const u1 = u0 + cellW,
        v1 = v0 + cellH;
      const p00 = project(u0, v0),
        p10 = project(u1, v0);
      const p11 = project(u1, v1),
        p01 = project(u0, v1);
      drawTexturedTri(ctx, floatCanvas, u0, v0, u1, v0, u1, v1, p00, p10, p11);
      drawTexturedTri(ctx, floatCanvas, u0, v0, u1, v1, u0, v1, p00, p11, p01);
    }
  }
  ctx.restore();
}

function drawSquareHandle(
  ctx: CanvasRenderingContext2D,
  pos: Point,
  size: number,
  zoom: number,
  fillColor: string,
): void {
  const dpr = window.devicePixelRatio;
  const half = Math.max(3, (size * dpr) / zoom);
  ctx.save();
  ctx.fillStyle = fillColor;
  ctx.strokeStyle = DASHED_BOX_COLOR;
  ctx.lineWidth = Math.max(0.5, window.devicePixelRatio / zoom);
  ctx.beginPath();
  ctx.rect(pos.x - half, pos.y - half, half * 2, half * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawCircleHandle(
  ctx: CanvasRenderingContext2D,
  pos: Point,
  size: number,
  zoom: number,
  color: string,
): void {
  const dpr = window.devicePixelRatio;
  const r = Math.max(3, (size * dpr) / zoom);
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.5, dpr / zoom);
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawShearHandle(
  ctx: CanvasRenderingContext2D,
  pos: Point,
  zoom: number,
  color: string,
  isHorizontal: boolean,
): void {
  const dpr = window.devicePixelRatio;
  const baseSize = Math.max(3, (5 * dpr) / zoom);
  const longSide = baseSize * 3.2;
  const shortSide = baseSize * 1.0;
  const w = isHorizontal ? longSide : shortSide;
  const h = isHorizontal ? shortSide : longSide;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.8, (1.5 * dpr) / zoom);
  ctx.fillRect(pos.x - w / 2, pos.y - h / 2, w, h);
  ctx.strokeRect(pos.x - w / 2, pos.y - h / 2, w, h);
  ctx.restore();
}

function drawPivotCrosshair(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
): void {
  const dpr = window.devicePixelRatio;
  const r = Math.max(5, (7 * dpr) / zoom);
  const lw = Math.max(0.5, dpr / zoom);
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = lw * 2;
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r);
  ctx.lineTo(x, y + r);
  ctx.stroke();
  ctx.strokeStyle = DASHED_BOX_COLOR;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r);
  ctx.lineTo(x, y + r);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ─── Handler factory ──────────────────────────────────────────────────────────

export function createTransformHandler(): ToolHandler {
  let activeHandle: number | null = null;
  let dragStartPos: Point = { x: 0, y: 0 };
  let paramsAtDragStart: TransformParams | null = null;

  return {
    onActivate(ctx: ToolContext): void {
      // `useCanvasPointerInput` clears the overlay canvas on every tool /
      // active-layer change before invoking `onActivate`. Repaint the
      // transform handles + live preview straight away so the user sees
      // them on the very first frame after Ctrl+T — without this the
      // overlay stays blank until the next param tweak (drag a handle,
      // toggle aspect lock, etc.) re-fires the transform store's notify.
      if (!activeScope().transform.isActive || !ctx.overlayCanvas) return;
      drawTransformOverlay(
        ctx.overlayCanvas,
        activeScope().transform,
        ctx.zoom,
      );
    },
    onPointerDown(pos: ToolPointerPos, ctx: ToolContext): void {
      if (!activeScope().transform.isActive) return;
      if (
        "button" in (pos as unknown as PointerEvent) &&
        (pos as unknown as PointerEvent).button !== 0
      )
        return;

      const handles = getHandleWorldPositions(activeScope().transform.params);
      const hit = hitTestHandle(
        handles,
        pos.x,
        pos.y,
        ctx.zoom,
        activeScope().transform.handleMode,
      );

      if (hit !== null) {
        activeHandle = hit;
      } else if (isInsideBox(activeScope().transform.params, pos.x, pos.y)) {
        activeHandle = HANDLE_TRANSLATE;
      } else {
        activeHandle = null;
        return;
      }

      dragStartPos = { x: pos.x, y: pos.y };
      paramsAtDragStart = { ...activeScope().transform.params };
      if (paramsAtDragStart.perspectiveCorners) {
        paramsAtDragStart = {
          ...paramsAtDragStart,
          perspectiveCorners: [...paramsAtDragStart.perspectiveCorners] as [
            Point,
            Point,
            Point,
            Point,
          ],
        };
      }
    },

    onPointerMove(pos: ToolPointerPos, ctx: ToolContext): void {
      if (
        !activeScope().transform.isActive ||
        activeHandle === null ||
        !paramsAtDragStart
      )
        return;

      const p = paramsAtDragStart;
      const { handleMode } = activeScope().transform;
      let newParams: TransformParams;

      if (activeHandle === HANDLE_TRANSLATE) {
        newParams = applyTranslateDrag(
          activeScope().transform.params,
          { x: pos.x - dragStartPos.x, y: pos.y - dragStartPos.y },
          p,
        );
      } else if (activeHandle === 8) {
        newParams = applyRotateDrag(
          activeScope().transform.params,
          pos,
          dragStartPos,
          p,
          pos.shiftKey,
        );
      } else if (activeHandle === 9) {
        newParams = applyPivotDrag(activeScope().transform.params, pos, p);
      } else if (activeHandle >= 10 && activeHandle <= 13) {
        newParams = applyPerspectiveDrag(
          activeScope().transform.params,
          activeHandle - 10,
          pos,
          pos.shiftKey,
          p,
        );
      } else if (handleMode === "shear") {
        newParams = applyShearDrag(
          activeScope().transform.params,
          activeHandle,
          pos,
          dragStartPos,
          p,
        );
      } else {
        newParams = applyScaleDrag(
          activeScope().transform.params,
          activeHandle,
          pos,
          p,
          pos.shiftKey,
        );
      }

      void ctx;
      activeScope().transform.updateParams(newParams);
    },

    onPointerUp(_pos: ToolPointerPos, _ctx: ToolContext): void {
      activeHandle = null;
      paramsAtDragStart = null;
    },

    onHover(pos: ToolPointerPos, ctx: ToolContext): void {
      if (!activeScope().transform.isActive || !ctx.overlayCanvas) return;
      const handles = getHandleWorldPositions(activeScope().transform.params);
      const hit = hitTestHandle(
        handles,
        pos.x,
        pos.y,
        ctx.zoom,
        activeScope().transform.handleMode,
      );
      const inside = isInsideBox(activeScope().transform.params, pos.x, pos.y);
      let cursor = "default";
      if (hit !== null) {
        if (hit === 8) cursor = "grab";
        else if (hit === 9) cursor = "move";
        else if (hit >= 10) cursor = "move";
        else
          cursor =
            resizeCursorForHandle(hit, activeScope().transform.params.rotation) ??
            "nwse-resize";
      } else if (inside) {
        cursor = "move";
      }
      ctx.setCursor(cursor);
    },

    onLeave(ctx: ToolContext): void {
      ctx.setCursor("");
    },
  };
}

// ─── Lock icon SVG ────────────────────────────────────────────────────────────

function LockIcon({ locked }: { locked: boolean }): React.JSX.Element {
  return locked ? (
    // Closed chain link
    <svg
      viewBox="0 0 14 14"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <rect x="1" y="5" width="4" height="4" rx="1.2" />
      <rect x="9" y="5" width="4" height="4" rx="1.2" />
      <line x1="5" y1="7" x2="9" y2="7" />
    </svg>
  ) : (
    // Broken chain link
    <svg
      viewBox="0 0 14 14"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <rect x="1" y="5" width="4" height="4" rx="1.2" />
      <rect x="9" y="5" width="4" height="4" rx="1.2" />
      <line x1="5" y1="7" x2="6.2" y2="7" />
      <line x1="7.8" y1="7" x2="9" y2="7" />
    </svg>
  );
}

// ─── Toolbar component ────────────────────────────────────────────────────────

export function TransformToolbar(): React.JSX.Element {
  const [params, setParams] = useState(() => activeScope().transform.params);
  const [aspectLocked, setAspectLocked] = useState(false);
  const [handleMode, setHandleMode] = useState<TransformHandleMode>("scale");
  const [interpolation, setInterpolation] =
    useState<TransformInterpolation>("bilinear");

  useEffect(() => {
    const sync = (): void => {
      setParams({ ...activeScope().transform.params });
      setAspectLocked(activeScope().transform.aspectLocked);
      setHandleMode(activeScope().transform.handleMode);
      setInterpolation(activeScope().transform.interpolation);
    };
    activeScope().transform.subscribe(sync);
    sync();
    return () => activeScope().transform.unsubscribe(sync);
  }, []);

  const origAspect =
    activeScope().transform.originalH > 0
      ? activeScope().transform.originalW / activeScope().transform.originalH
      : 1;

  const commitX = useCallback((raw: string): void => {
    const v = parseFloat(raw);
    if (!isNaN(v)) activeScope().transform.updateParams({ x: v });
  }, []);

  const commitY = useCallback((raw: string): void => {
    const v = parseFloat(raw);
    if (!isNaN(v)) activeScope().transform.updateParams({ y: v });
  }, []);

  const commitW = useCallback(
    (raw: string): void => {
      const v = Math.max(1, parseFloat(raw) || 1);
      if (activeScope().transform.aspectLocked) {
        activeScope().transform.updateParams({ w: v, h: Math.round(v / origAspect) });
      } else {
        activeScope().transform.updateParams({ w: v });
      }
    },
    [origAspect],
  );

  const commitH = useCallback(
    (raw: string): void => {
      const v = Math.max(1, parseFloat(raw) || 1);
      if (activeScope().transform.aspectLocked) {
        activeScope().transform.updateParams({ h: v, w: Math.round(v * origAspect) });
      } else {
        activeScope().transform.updateParams({ h: v });
      }
    },
    [origAspect],
  );

  const commitRotation = useCallback((raw: string): void => {
    const v = parseFloat(raw);
    if (!isNaN(v)) {
      let r = v % 360;
      if (r > 180) r -= 360;
      if (r < -180) r += 360;
      activeScope().transform.updateParams({ rotation: r });
    }
  }, []);

  const toggleLock = useCallback((): void => {
    activeScope().transform.aspectLocked = !activeScope().transform.aspectLocked;
    activeScope().transform.notify();
  }, []);

  const setMode = useCallback((mode: TransformHandleMode): void => {
    const prev = activeScope().transform.handleMode;
    activeScope().transform.handleMode = mode;
    if (mode === "perspective" && prev !== "perspective") {
      const p = activeScope().transform.params;
      activeScope().transform.params = {
        ...p,
        perspectiveCorners: [
          { x: p.x, y: p.y },
          { x: p.x + p.w, y: p.y },
          { x: p.x + p.w, y: p.y + p.h },
          { x: p.x, y: p.y + p.h },
        ],
      };
    } else if (mode !== "perspective" && prev === "perspective") {
      activeScope().transform.params = {
        ...activeScope().transform.params,
        perspectiveCorners: null,
      };
    }
    activeScope().transform.notify();
  }, []);

  const setInterp = useCallback((interp: TransformInterpolation): void => {
    activeScope().transform.interpolation = interp;
    activeScope().transform.notify();
  }, []);

  const isPerspective = handleMode === "perspective";

  return (
    <div className={styles.toolbar}>
      {/* X / Y */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>X</span>
        <input
          type="number"
          className={styles.numInputNarrow}
          value={Math.round(params.x)}
          onChange={(e) => commitX(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className={styles.group}>
        <span className={styles.groupLabel}>Y</span>
        <input
          type="number"
          className={styles.numInputNarrow}
          value={Math.round(params.y)}
          onChange={(e) => commitY(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>

      <div className={styles.sep} />

      {/* W / H with lock */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>W</span>
        <input
          type="number"
          className={styles.numInput}
          value={Math.round(params.w)}
          onChange={(e) => commitW(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          min={1}
        />
        <button
          className={aspectLocked ? styles.lockBtnLocked : styles.lockBtn}
          onClick={toggleLock}
          title={aspectLocked ? "Unlock aspect ratio" : "Lock aspect ratio"}
          type="button"
        >
          <LockIcon locked={aspectLocked} />
        </button>
        <span className={styles.groupLabel}>H</span>
        <input
          type="number"
          className={styles.numInput}
          value={Math.round(params.h)}
          onChange={(e) => commitH(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          min={1}
        />
      </div>

      <div className={styles.sep} />

      {/* Rotation */}
      <div className={styles.group}>
        <svg
          viewBox="0 0 12 12"
          width="11"
          height="11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          style={{ opacity: isPerspective ? 0.35 : 1 }}
        >
          <path d="M9.5 2.5A5 5 0 1 0 11 6" />
          <polyline points="11,2 11,6 7,6" />
        </svg>
        <input
          type="number"
          className={styles.numInputNarrow}
          value={parseFloat(params.rotation.toFixed(1))}
          onChange={(e) => commitRotation(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          disabled={isPerspective}
          step={0.1}
          min={-180}
          max={180}
        />
        <span className={styles.groupLabel}>°</span>
      </div>

      <div className={styles.sep} />

      {/* Interpolation */}
      <span className={styles.groupLabel}>Interp</span>
      <select
        className={styles.selectInput}
        value={interpolation}
        onChange={(e) => setInterp(e.target.value as TransformInterpolation)}
      >
        <option value="bilinear">Bilinear</option>
        <option value="nearest">Nearest Neighbour</option>
        <option value="bicubic">Bicubic</option>
      </select>

      <div className={styles.sep} />

      {/* Mode toggles */}
      <div className={styles.modeGroup}>
        <button
          className={
            handleMode === "scale" ? styles.modeBtnActive : styles.modeBtn
          }
          onClick={() => setMode("scale")}
          type="button"
        >
          Scale
        </button>
        <button
          className={
            handleMode === "perspective" ? styles.modeBtnActive : styles.modeBtn
          }
          onClick={() => setMode("perspective")}
          type="button"
        >
          Perspective
        </button>
        <button
          className={
            handleMode === "shear" ? styles.modeBtnActive : styles.modeBtn
          }
          onClick={() => setMode("shear")}
          type="button"
        >
          Shear
        </button>
      </div>

      <div className={styles.spacer} />

      {/* Cancel / Apply */}
      <button
        className={styles.cancelBtn}
        onClick={() => activeScope().transform.triggerCancel()}
        type="button"
      >
        Cancel
      </button>
      <button
        className={styles.applyBtn}
        onClick={() => activeScope().transform.triggerApply()}
        type="button"
      >
        Apply
      </button>
    </div>
  );
}

// ─── Options wrapper ──────────────────────────────────────────────────────────

function TransformOptions(_props: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  return <TransformToolbar />;
}

class TransformTool implements ITool {
  readonly id = "transform";
  readonly label = "Free Transform";
  readonly shortcut = "";
  // Transform is invoked via Ctrl+T / menu — never appears on the toolbar,
  // so we use a no-op icon and null placement.
  readonly icon = <></>;
  readonly placement = null;
  createHandler(): ToolHandler {
    return createTransformHandler();
  }
  readonly Options = TransformOptions;
}

export const transformTool: ITool = new TransformTool();
