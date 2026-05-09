import React, { useEffect, useState } from "react";
import { measureStore, type Point } from "@/core/tools/Measure/measureStore";
import type {
  ToolHandler,
  ToolPointerPos,
  ToolContext,
  ToolOptionsStyles,
} from "../_shared/types";
import type { ITool } from "../_shared/ITool";
import { ToolGroup } from "../_shared/ITool";
import { SvgIcon } from "../_shared/SvgIcon";
import measureIconSvg from "./measure.svg?raw";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Snap (dx, dy) to the nearest 45° axis when shift is held. The snapped
 *  vector keeps the same Chebyshev distance as the original. */
function constrainTo45(dx: number, dy: number): [number, number] {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [0, 0];
  const angle = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(angle / step) * step;
  return [Math.round(Math.cos(snapped) * len), Math.round(Math.sin(snapped) * len)];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Hit-test: is (x, y) within `r` pixels of point `p`? */
function near(p: Point, x: number, y: number, r: number): boolean {
  return (x - p.x) ** 2 + (y - p.y) ** 2 <= r * r;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

type DragMode =
  | { kind: "draw" }
  | { kind: "extend-start"; fixed: Point }
  | { kind: "extend-end"; fixed: Point }
  | { kind: "protractor"; pivot: Point };

function createMeasureHandler(): ToolHandler {
  let mode: DragMode | null = null;

  return {
    onPointerDown(
      { x, y, altKey, shiftKey }: ToolPointerPos,
      ctx: ToolContext,
    ): void {
      const px = Math.round(x);
      const py = Math.round(y);
      // Endpoint hit-test radius (in canvas pixels). Scale with zoom so it
      // stays a comfortable click target at high zoom.
      const r = Math.max(4, 6 / ctx.zoom);

      // Alt-drag from the current `start` endpoint = protractor (second
      // segment sharing the start vertex). Alt-drag from `end` extends the
      // primary line. Plain click on either endpoint extends it.
      if (measureStore.start && measureStore.end) {
        if (altKey && near(measureStore.start, px, py, r)) {
          mode = { kind: "protractor", pivot: measureStore.start };
          measureStore.setProtractorEnd({ x: px, y: py });
          return;
        }
        if (near(measureStore.start, px, py, r)) {
          mode = { kind: "extend-start", fixed: measureStore.end };
          measureStore.setLine({ x: px, y: py }, measureStore.end);
          return;
        }
        if (near(measureStore.end, px, py, r)) {
          mode = { kind: "extend-end", fixed: measureStore.start };
          measureStore.setLine(measureStore.start, { x: px, y: py });
          return;
        }
        if (
          measureStore.protractorEnd &&
          near(measureStore.protractorEnd, px, py, r)
        ) {
          mode = { kind: "protractor", pivot: measureStore.start };
          measureStore.setProtractorEnd({ x: px, y: py });
          return;
        }
      }

      // Plain click → start a fresh measurement.
      mode = { kind: "draw" };
      measureStore.setLine({ x: px, y: py }, { x: px, y: py });
      void shiftKey;
    },

    onPointerMove(
      { x, y, shiftKey }: ToolPointerPos,
      _ctx: ToolContext,
    ): void {
      if (!mode) return;
      const px = Math.round(x);
      const py = Math.round(y);

      const apply45 = (anchor: Point): Point => {
        if (!shiftKey) return { x: px, y: py };
        const [dx, dy] = constrainTo45(px - anchor.x, py - anchor.y);
        return { x: anchor.x + dx, y: anchor.y + dy };
      };

      if (mode.kind === "draw") {
        const start = measureStore.start!;
        const end = apply45(start);
        measureStore.setLine(start, end);
      } else if (mode.kind === "extend-start") {
        const next = apply45(mode.fixed);
        measureStore.setLine(next, mode.fixed);
      } else if (mode.kind === "extend-end") {
        const next = apply45(mode.fixed);
        measureStore.setLine(mode.fixed, next);
      } else if (mode.kind === "protractor") {
        const next = apply45(mode.pivot);
        measureStore.setProtractorEnd(next);
      }
    },

    onPointerUp(_pos: ToolPointerPos, _ctx: ToolContext): void {
      mode = null;
    },

    onActivate(ctx: ToolContext): void {
      ctx.setCursor("crosshair");
    },
    onLeave(ctx: ToolContext): void {
      ctx.setCursor("");
    },
  };
}

// ─── Options UI ───────────────────────────────────────────────────────────────

function angleDeg(a: Point, b: Point): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

/** Smaller of the two angles between segments (start→end) and (start→protractorEnd). */
function protractorAngleDeg(start: Point, end: Point, p2: Point): number {
  const a1 = angleDeg(start, end);
  const a2 = angleDeg(start, p2);
  let d = Math.abs(a1 - a2);
  if (d > 180) d = 360 - d;
  return d;
}

function MeasureOptions({
  styles,
}: {
  styles: ToolOptionsStyles;
}): React.JSX.Element {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const fn = (): void => setTick((t) => t + 1);
    measureStore.subscribe(fn);
    return () => measureStore.unsubscribe(fn);
  }, []);
  void tick;

  const { start, end, protractorEnd } = measureStore;
  const has = !!(start && end);
  const fmt = (v: number | null): string =>
    v === null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(1);
  const num = (n: number, decimals = 1): number =>
    parseFloat(n.toFixed(decimals));

  const xStart = has ? start.x : null;
  const yStart = has ? start.y : null;
  const dx = has ? end.x - start.x : null;
  const dy = has ? end.y - start.y : null;
  const angle = has ? num(angleDeg(start, end)) : null;
  const length1 = has ? num(distance(start, end)) : null;
  const length2 =
    has && protractorEnd ? num(distance(start, protractorEnd)) : null;
  const angleBetween =
    has && protractorEnd ? num(protractorAngleDeg(start, end, protractorEnd)) : null;

  return (
    <>
      <label className={styles.optLabel}>X:</label>
      <span className={styles.optText}>{fmt(xStart)}</span>
      <label className={styles.optLabel}>Y:</label>
      <span className={styles.optText}>{fmt(yStart)}</span>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>W:</label>
      <span className={styles.optText}>{fmt(dx)}</span>
      <label className={styles.optLabel}>H:</label>
      <span className={styles.optText}>{fmt(dy)}</span>
      <span className={styles.optSep} />
      <label
        className={styles.optLabel}
        title="Angle of the primary line, in degrees from the +X axis."
      >
        A:
      </label>
      <span className={styles.optText}>
        {angle !== null ? `${angle}°` : "—"}
      </span>
      <span className={styles.optSep} />
      <label className={styles.optLabel}>L1:</label>
      <span className={styles.optText}>{fmt(length1)}</span>
      <label
        className={styles.optLabel}
        title="Length of the protractor's second segment. Alt-drag from the start endpoint to create."
      >
        L2:
      </label>
      <span className={styles.optText}>{fmt(length2)}</span>
      {angleBetween !== null && (
        <>
          <span className={styles.optSep} />
          <label
            className={styles.optLabel}
            title="Angle between the two protractor segments."
          >
            ∠:
          </label>
          <span className={styles.optText}>{`${angleBetween}°`}</span>
        </>
      )}
      <span className={styles.optSep} />
      <button
        className={styles.optBtn}
        onClick={() => measureStore.clear()}
        disabled={!has}
      >
        Clear
      </button>
    </>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

class MeasureTool implements ITool {
  readonly id = "measure";
  readonly label = "Measure";
  readonly shortcut = "I";
  readonly icon = <SvgIcon src={measureIconSvg} />;
  readonly placement = {
    group: ToolGroup.Sampling,
    row: 0,
    column: 1,
  } as const;
  // Operate on any layer — this tool reads no pixels and writes no pixels.
  readonly worksOnAllLayers = true;
  createHandler(): ToolHandler {
    return createMeasureHandler();
  }
  readonly Options = MeasureOptions;
}

export const measureTool: ITool = new MeasureTool();
