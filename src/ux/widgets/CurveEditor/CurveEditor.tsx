import React, { useCallback, useRef, useState } from "react";
import { evaluateCurve } from "@/utils/dynamicCurve";
import styles from "./CurveEditor.module.scss";

interface Point {
  x: number;
  y: number;
}

interface CurveEditorProps {
  points: Point[];
  onChange: (points: Point[]) => void;
  width?: number;
  height?: number;
  /** Optional axis labels — e.g. "pressure" → "size". */
  xLabel?: string;
  yLabel?: string;
}

const HIT_RADIUS = 8;
const POINT_RADIUS = 4;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function sortPoints(pts: Point[]): Point[] {
  return [...pts].sort((a, b) => a.x - b.x);
}

/**
 * Drag-edit curve. Click an empty area to add a point, drag a point to move
 * it, right-click a point to delete it (endpoints are pinned at x=0 and x=1
 * but their y is editable).
 */
export function CurveEditor({
  points,
  onChange,
  width = 180,
  height = 100,
  xLabel,
  yLabel,
}: CurveEditorProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const toUv = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const el = ref.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: clamp01((clientX - r.left) / r.width),
        y: clamp01(1 - (clientY - r.top) / r.height),
      };
    },
    [],
  );

  const findHit = useCallback(
    (uv: Point): number => {
      const el = ref.current;
      if (!el) return -1;
      let best = -1;
      let bestD2 = (HIT_RADIUS / Math.min(width, height)) ** 2;
      for (let i = 0; i < points.length; i++) {
        const dx = points[i].x - uv.x;
        const dy = points[i].y - uv.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = i;
        }
      }
      return best;
    },
    [points, width, height],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const uv = toUv(e.clientX, e.clientY);
      if (!uv) return;

      if (e.button === 2) {
        // Right-click: delete an internal point.
        const idx = findHit(uv);
        if (idx > 0 && idx < points.length - 1) {
          const next = points.filter((_, i) => i !== idx);
          onChange(next);
        }
        return;
      }

      if (e.button !== 0) return;

      const idx = findHit(uv);
      if (idx >= 0) {
        setDragIdx(idx);
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }

      // Insert a new point at uv.
      const next = sortPoints([...points, uv]);
      const newIdx = next.findIndex((p) => p.x === uv.x && p.y === uv.y);
      onChange(next);
      setDragIdx(newIdx);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [toUv, findHit, points, onChange],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragIdx == null) return;
      const uv = toUv(e.clientX, e.clientY);
      if (!uv) return;
      const next = points.map((p, i) => {
        if (i !== dragIdx) return p;
        // Endpoints stay at their x; only y is editable.
        if (i === 0) return { x: 0, y: uv.y };
        if (i === points.length - 1) return { x: 1, y: uv.y };
        // Internal points can't pass their neighbours.
        const lo = points[i - 1].x + 0.001;
        const hi = points[i + 1].x - 0.001;
        return { x: Math.min(hi, Math.max(lo, uv.x)), y: uv.y };
      });
      onChange(next);
    },
    [dragIdx, toUv, points, onChange],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragIdx == null) return;
      setDragIdx(null);
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    [dragIdx],
  );

  const onContextMenu = useCallback((e: React.MouseEvent) => e.preventDefault(), []);

  // Build the SVG path for the curve.
  const samples = 64;
  let pathD = "";
  for (let i = 0; i <= samples; i++) {
    const x = i / samples;
    const y = clamp01(evaluateCurve(points, x));
    const px = x * width;
    const py = (1 - y) * height;
    pathD += i === 0 ? `M${px.toFixed(2)},${py.toFixed(2)}` : `L${px.toFixed(2)},${py.toFixed(2)}`;
  }

  return (
    <div className={styles.wrap} style={{ width, height }}>
      <div
        ref={ref}
        className={styles.surface}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
      >
        <svg width={width} height={height} className={styles.svg}>
          <line x1="0" y1={height / 2} x2={width} y2={height / 2} className={styles.gridLine} />
          <line x1={width / 2} y1="0" x2={width / 2} y2={height} className={styles.gridLine} />
          <path d={pathD} className={styles.curve} fill="none" />
          {points.map((p, i) => (
            <circle
              key={i}
              cx={p.x * width}
              cy={(1 - p.y) * height}
              r={POINT_RADIUS}
              className={i === dragIdx ? styles.pointActive : styles.point}
            />
          ))}
        </svg>
      </div>
      {(xLabel || yLabel) && (
        <div className={styles.labels}>
          {yLabel && <span className={styles.yLabel}>{yLabel}</span>}
          {xLabel && <span className={styles.xLabel}>{xLabel}</span>}
        </div>
      )}
    </div>
  );
}
