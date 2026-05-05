import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CurvesChannel,
  CurvesControlPoint,
  CurvesVisualAids,
} from "@/types";
import {
  buildCurveLut,
  detectLutClipping,
} from "@/core/operations/adjustments/curves";
import styles from "./CurvesGraph.module.scss";

// ─── Constants ────────────────────────────────────────────────────────────────

const GRAPH_SIZE = 216;

// ─── Props ────────────────────────────────────────────────────────────────────

interface CurvesGraphProps {
  channel: CurvesChannel;
  points: CurvesControlPoint[];
  histogram: Float32Array | null;
  visualAids: CurvesVisualAids;
  selectedPointId: string | null;
  onAddPoint: (input: number, output: number) => void;
  onMovePoint: (pointId: string, input: number, output: number) => void;
  onSelectPoint: (pointId: string | null) => void;
  onDeletePoint: (pointId: string) => void;
  onNudgePoint: (pointId: string, dx: number, dy: number) => void;
  onHoverChange?: (input: number, output: number) => void;
}

// ─── Coordinate helpers ───────────────────────────────────────────────────────

function getDivCoords(e: React.PointerEvent<HTMLDivElement>): {
  x: number;
  y: number;
} {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (GRAPH_SIZE / rect.width);
  const y = (e.clientY - rect.top) * (GRAPH_SIZE / rect.height);
  return {
    x: Math.max(0, Math.min(GRAPH_SIZE, x)),
    y: Math.max(0, Math.min(GRAPH_SIZE, y)),
  };
}

function svgX(val: number): number {
  return (val / 255) * GRAPH_SIZE;
}

function svgY(val: number): number {
  return GRAPH_SIZE - (val / 255) * GRAPH_SIZE;
}

function toInput(x: number): number {
  return Math.max(0, Math.min(255, Math.round((x / GRAPH_SIZE) * 255)));
}

function toOutput(y: number): number {
  return Math.max(
    0,
    Math.min(255, Math.round(((GRAPH_SIZE - y) / GRAPH_SIZE) * 255)),
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CurvesGraph({
  channel,
  points,
  histogram,
  visualAids,
  selectedPointId,
  onAddPoint,
  onMovePoint,
  onSelectPoint,
  onDeletePoint,
  onNudgePoint,
  onHoverChange,
}: CurvesGraphProps): React.JSX.Element {
  // Keep callback refs so the rAF closure is always current
  const onMovePointRef = useRef(onMovePoint);
  useEffect(() => {
    onMovePointRef.current = onMovePoint;
  });

  const onHoverChangeRef = useRef(onHoverChange);
  useEffect(() => {
    onHoverChangeRef.current = onHoverChange;
  });

  // Drag state (never React state — avoids re-renders during drag)
  const dragRef = useRef<{
    pointId: string;
    isEndpoint: boolean;
    startX: number;
    startY: number;
    lockAxis: "x" | "y" | null;
  } | null>(null);

  const rafIdRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<{ id: string; x: number; y: number } | null>(
    null,
  );

  const [hoverSvg, setHoverSvg] = useState<{ x: number; y: number } | null>(
    null,
  );

  // ─── Derived data ──────────────────────────────────────────────────────────

  const lut = useMemo(() => buildCurveLut(points), [points]);
  const clipping = useMemo(() => detectLutClipping(lut), [lut]);

  const curvePath = useMemo(() => {
    let path = "";
    for (let i = 0; i <= 255; i++) {
      const sx = ((i / 255) * GRAPH_SIZE).toFixed(2);
      const sy = (GRAPH_SIZE - (lut[i] / 255) * GRAPH_SIZE).toFixed(2);
      path += i === 0 ? `M ${sx} ${sy}` : ` L ${sx} ${sy}`;
    }
    return path;
  }, [lut]);

  const histBars = useMemo(() => {
    if (!histogram) return null;
    const max = Math.max(...histogram) || 1;
    const barW = GRAPH_SIZE / 256;
    return Array.from(histogram, (count, i) => {
      const h = Math.max(2, Math.round((count / max) * (GRAPH_SIZE - 12)));
      const bx = i * barW;
      const by = GRAPH_SIZE - h;
      return (
        <rect
          key={i}
          className={styles.histBar}
          x={bx}
          y={by}
          width={barW + 0.5}
          height={h}
        />
      );
    });
  }, [histogram]);

  const gridCount = visualAids.gridDensity === "8x8" ? 8 : 4;

  const gridLines = useMemo(() => {
    const lines: React.JSX.Element[] = [];
    for (let i = 0; i <= gridCount; i++) {
      const coord = (i / gridCount) * GRAPH_SIZE;
      const isMajor = i === 0 || i === gridCount || i === gridCount / 2;
      const cls = isMajor ? styles.gridMajor : styles.gridMinor;
      lines.push(
        <line
          key={`v${i}`}
          className={cls}
          x1={coord}
          y1={0}
          x2={coord}
          y2={GRAPH_SIZE}
        />,
        <line
          key={`h${i}`}
          className={cls}
          x1={0}
          y1={coord}
          x2={GRAPH_SIZE}
          y2={coord}
        />,
      );
    }
    return lines;
  }, [gridCount]);

  const isLinearIdentity =
    points.length === 2 &&
    points[0].x === 0 &&
    points[0].y === 0 &&
    points[1].x === 255 &&
    points[1].y === 255;

  // ─── Pointer handlers ──────────────────────────────────────────────────────

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as SVGElement;
      const pointId = target.getAttribute("data-point-id");
      const coords = getDivCoords(e);

      if (pointId) {
        const idx = points.findIndex((p) => p.id === pointId);
        const isEndpoint = idx === 0 || idx === points.length - 1;
        onSelectPoint(pointId);
        dragRef.current = {
          pointId,
          isEndpoint,
          startX: coords.x,
          startY: coords.y,
          lockAxis: null,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      } else {
        onAddPoint(toInput(coords.x), toOutput(coords.y));
      }
    },
    [points, onSelectPoint, onAddPoint],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Detect silent pen-lift
      if (dragRef.current && !(e.buttons & 1)) {
        dragRef.current = null;
        return;
      }

      const coords = getDivCoords(e);

      if (dragRef.current) {
        const { pointId, isEndpoint, startX, startY } = dragRef.current;

        // Determine shift-drag axis lock
        if (e.shiftKey) {
          if (!dragRef.current.lockAxis) {
            const dx = coords.x - startX;
            const dy = coords.y - startY;
            if (Math.sqrt(dx * dx + dy * dy) > 4) {
              dragRef.current.lockAxis =
                Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
            }
          }
        } else {
          dragRef.current.lockAxis = null;
        }

        const currentPoint = points.find((p) => p.id === pointId);
        if (!currentPoint) return;

        let newInput = toInput(coords.x);
        let newOutput = toOutput(coords.y);

        if (dragRef.current.lockAxis === "x") {
          newOutput = currentPoint.y;
        } else if (dragRef.current.lockAxis === "y") {
          newInput = currentPoint.x;
        }

        if (isEndpoint) newInput = currentPoint.x;

        newInput = Math.max(0, Math.min(255, newInput));
        newOutput = Math.max(0, Math.min(255, newOutput));

        pendingMoveRef.current = { id: pointId, x: newInput, y: newOutput };

        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = null;
            const pm = pendingMoveRef.current;
            if (pm) {
              onMovePointRef.current(pm.id, pm.x, pm.y);
              pendingMoveRef.current = null;
            }
          });
        }
      }

      // Update crosshair / hover readout
      if (visualAids.showReadout) {
        setHoverSvg({ x: coords.x, y: coords.y });
        onHoverChangeRef.current?.(toInput(coords.x), toOutput(coords.y));
      }
    },
    [points, visualAids.showReadout],
  );

  const handlePointerUp = useCallback(
    (_e: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = null;
    },
    [],
  );

  const handlePointerLeave = useCallback(
    (_e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) {
        setHoverSvg(null);
      }
    },
    [],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as SVGElement;
      const pointId = target.getAttribute("data-point-id");
      if (!pointId) return;
      const idx = points.findIndex((p) => p.id === pointId);
      if (idx === 0 || idx === points.length - 1) return;
      onDeletePoint(pointId);
    },
    [points, onDeletePoint],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!selectedPointId) return;
      const nudge = e.shiftKey ? 10 : 1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") {
        dx = -nudge;
        e.preventDefault();
      }
      if (e.key === "ArrowRight") {
        dx = +nudge;
        e.preventDefault();
      }
      if (e.key === "ArrowUp") {
        dy = +nudge;
        e.preventDefault();
      }
      if (e.key === "ArrowDown") {
        dy = -nudge;
        e.preventDefault();
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const idx = points.findIndex((p) => p.id === selectedPointId);
        if (idx > 0 && idx < points.length - 1) onDeletePoint(selectedPointId);
        e.preventDefault();
      }
      if (dx !== 0 || dy !== 0) onNudgePoint(selectedPointId, dx, dy);
    },
    [selectedPointId, points, onNudgePoint, onDeletePoint],
  );

  // Cancel any pending rAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={styles.wrapper} tabIndex={0} onKeyDown={handleKeyDown}>
      <div className={styles.graphWrap}>
        <div className={styles.yAxis}>
          {[0, 64, 128, 192, 255].map((v) => (
            <span key={v}>{v}</span>
          ))}
        </div>

        <div className={styles.graphColumn}>
          <div
            className={styles.graphStage}
            data-channel={channel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
            onDoubleClick={handleDoubleClick}
          >
            <svg
              viewBox={`0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}`}
              aria-label="Curves graph"
            >
              <g>{gridLines}</g>
              {histBars && <g>{histBars}</g>}
              <line
                className={styles.baseline}
                x1={0}
                y1={GRAPH_SIZE}
                x2={GRAPH_SIZE}
                y2={0}
              />
              {visualAids.showReadout && hoverSvg && (
                <>
                  <line
                    className={styles.crosshair}
                    x1={hoverSvg.x}
                    y1={0}
                    x2={hoverSvg.x}
                    y2={GRAPH_SIZE}
                  />
                  <line
                    className={styles.crosshair}
                    x1={0}
                    y1={hoverSvg.y}
                    x2={GRAPH_SIZE}
                    y2={hoverSvg.y}
                  />
                </>
              )}
              <path className={styles.curvePath} d={curvePath} />
              <g>
                {points.map((p, idx) => {
                  const isEndpt = idx === 0 || idx === points.length - 1;
                  const isSelected = p.id === selectedPointId;
                  let cls: string;
                  if (isEndpt && isSelected) cls = styles.pointEndpointSelected;
                  else if (isEndpt) cls = styles.pointEndpoint;
                  else if (isSelected) cls = styles.pointNormalSelected;
                  else cls = styles.pointNormal;
                  return (
                    <circle
                      key={p.id}
                      className={cls}
                      cx={svgX(p.x)}
                      cy={svgY(p.y)}
                      r={isEndpt ? 4 : 4.2}
                      data-point-id={p.id}
                    />
                  );
                })}
              </g>
            </svg>
            {visualAids.showClippingIndicators && clipping.low && (
              <div className={styles.clippingLow} />
            )}
            {visualAids.showClippingIndicators && clipping.high && (
              <div className={styles.clippingHigh} />
            )}
            {isLinearIdentity && (
              <div className={styles.linearHint}>
                Linear identity: click the curve to add a point.
              </div>
            )}
          </div>
          <div className={styles.axisCaption}>
            <span>Output</span>
            <span>Input</span>
          </div>
        </div>

        <div className={styles.xAxis}>
          {[0, 64, 128, 192, 255].map((v) => (
            <span key={v}>{v}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
