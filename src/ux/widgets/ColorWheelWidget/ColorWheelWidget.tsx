import React, { useRef, useEffect, useCallback } from "react";
import type { ColorGradingWheelParams } from "@/types";
import styles from "./ColorWheelWidget.module.scss";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ColorWheelWidgetProps {
  label: string;
  value: ColorGradingWheelParams;
  onChange: (value: ColorGradingWheelParams) => void;
}

// ─── Drawing helpers ──────────────────────────────────────────────────────────

const DISK_RADIUS = 44; // px, inside 96px canvas
const CANVAS_SIZE = 96;
const CENTER = CANVAS_SIZE / 2;

function drawWheel(
  canvas: HTMLCanvasElement,
  value: ColorGradingWheelParams,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Spectrum disk via conic gradient
  const grd = ctx.createConicGradient(0, CENTER, CENTER);
  grd.addColorStop(0 / 12, "hsl(0,   100%, 50%)");
  grd.addColorStop(1 / 12, "hsl(30,  100%, 50%)");
  grd.addColorStop(2 / 12, "hsl(60,  100%, 50%)");
  grd.addColorStop(3 / 12, "hsl(90,  100%, 50%)");
  grd.addColorStop(4 / 12, "hsl(120, 100%, 50%)");
  grd.addColorStop(5 / 12, "hsl(150, 100%, 50%)");
  grd.addColorStop(6 / 12, "hsl(180, 100%, 50%)");
  grd.addColorStop(7 / 12, "hsl(210, 100%, 50%)");
  grd.addColorStop(8 / 12, "hsl(240, 100%, 50%)");
  grd.addColorStop(9 / 12, "hsl(270, 100%, 50%)");
  grd.addColorStop(10 / 12, "hsl(300, 100%, 50%)");
  grd.addColorStop(11 / 12, "hsl(330, 100%, 50%)");
  grd.addColorStop(1, "hsl(360, 100%, 50%)");

  ctx.beginPath();
  ctx.arc(CENTER, CENTER, DISK_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();

  // Radial overlay: white in center fading to transparent at rim
  const radial = ctx.createRadialGradient(
    CENTER,
    CENTER,
    0,
    CENTER,
    CENTER,
    DISK_RADIUS,
  );
  radial.addColorStop(0, "rgba(0,0,0,0.85)");
  radial.addColorStop(0.4, "rgba(0,0,0,0.2)");
  radial.addColorStop(1, "rgba(0,0,0,0)");

  ctx.beginPath();
  ctx.arc(CENTER, CENTER, DISK_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = radial;
  ctx.fill();

  // Crosshairs
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(CENTER - DISK_RADIUS, CENTER);
  ctx.lineTo(CENTER + DISK_RADIUS, CENTER);
  ctx.moveTo(CENTER, CENTER - DISK_RADIUS);
  ctx.lineTo(CENTER, CENTER + DISK_RADIUS);
  ctx.stroke();
  ctx.restore();

  // Puck — convert r/g/b to x/y, exact inverse of the drag mapping.
  // From: r=cos(h)·c, g=cos(h-2π/3)·c, b=cos(h+2π/3)·c
  //   px = normX = cos(h)·c = (r - 0.5g - 0.5b) / 1.5
  //   py = normY = sin(h)·c = (g - b) / sqrt(3)
  const { r, g, b } = value;
  const px = (r - 0.5 * g - 0.5 * b) / 1.5;
  const py = (g - b) / Math.sqrt(3);
  const chroma = Math.min(Math.hypot(px, py), 1);
  const puckX = CENTER + px * DISK_RADIUS;
  const puckY = CENTER + py * DISK_RADIUS;

  ctx.beginPath();
  ctx.arc(puckX, puckY, 5, 0, Math.PI * 2);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.fillStyle =
    chroma > 0.02 ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.5)";
  ctx.fill();
  ctx.stroke();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ColorWheelWidget({
  label,
  value,
  onChange,
}: ColorWheelWidgetProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);
  const masterRef = useRef<HTMLDivElement>(null);
  const masterDraggingRef = useRef(false);

  useEffect(() => {
    if (canvasRef.current) drawWheel(canvasRef.current, value);
  }, [value]);

  // ── Master slider (vertical, top=+1, bottom=−1, centre=0) ────────────────────
  const updateMasterFromPointer = useCallback(
    (e: React.PointerEvent<HTMLDivElement> | PointerEvent): void => {
      const el = masterRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const t = (e.clientY - rect.top) / rect.height;
      const raw = 1 - t * 2;
      const clamped = Math.max(-1, Math.min(1, raw));
      onChange({ ...value, master: parseFloat(clamped.toFixed(3)) });
    },
    [value, onChange],
  );

  const onMasterDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return;
      masterDraggingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      updateMasterFromPointer(e);
    },
    [updateMasterFromPointer],
  );

  const onMasterMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!masterDraggingRef.current) return;
      updateMasterFromPointer(e);
    },
    [updateMasterFromPointer],
  );

  const onMasterUp = useCallback((): void => {
    masterDraggingRef.current = false;
  }, []);

  const onMasterDoubleClick = useCallback((): void => {
    onChange({ ...value, master: 0 });
  }, [value, onChange]);

  // Drag handling
  const updateFromPointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement> | PointerEvent): void => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = CANVAS_SIZE / rect.width;
      const scaleY = CANVAS_SIZE / rect.height;
      const cx = (e.clientX - rect.left) * scaleX - CENTER;
      const cy = (e.clientY - rect.top) * scaleY - CENTER;
      const dist = Math.hypot(cx, cy);
      const clampedDist = Math.min(dist, DISK_RADIUS);
      const angle = Math.atan2(cy, cx);
      const normX = (Math.cos(angle) * clampedDist) / DISK_RADIUS;
      const normY = (Math.sin(angle) * clampedDist) / DISK_RADIUS;

      // Convert 2D position back to r/g/b using inverse of drawWheel projection
      const px = normX;
      const py = normY;
      const newR = px * Math.sqrt(1.5);
      const newG =
        -py * (2 / Math.sqrt(3)) +
        (-px * Math.sqrt(1.5) * 0.5 - py * (Math.sqrt(3) / 2) * -1);
      // Simpler: reconstruct via hue+chroma directly
      const chroma = Math.hypot(normX, normY);
      const hue = Math.atan2(normY, normX);
      const r = Math.cos(hue) * chroma;
      const g = Math.cos(hue - (2 * Math.PI) / 3) * chroma;
      const b = Math.cos(hue + (2 * Math.PI) / 3) * chroma;

      void newR;
      void newG; // suppress unused warning from the earlier attempt
      onChange({ ...value, r, g, b });
    },
    [value, onChange],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      if (e.button !== 0) return;
      draggingRef.current = true;
      canvasRef.current?.setPointerCapture(e.pointerId);
      updateFromPointer(e);
    },
    [updateFromPointer],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      if (!draggingRef.current) return;
      updateFromPointer(e);
    },
    [updateFromPointer],
  );

  const onPointerUp = useCallback((): void => {
    draggingRef.current = false;
  }, []);

  const handleNumInput = useCallback(
    (field: keyof ColorGradingWheelParams, raw: string): void => {
      const v = parseFloat(raw);
      if (isNaN(v)) return;
      const clamped =
        field === "master"
          ? Math.max(-1, Math.min(1, v))
          : Math.max(-1, Math.min(1, v));
      onChange({ ...value, [field]: parseFloat(clamped.toFixed(3)) });
    },
    [value, onChange],
  );

  const handleReset = useCallback((): void => {
    onChange({ r: 0, g: 0, b: 0, master: 0 });
  }, [onChange]);

  const fmt = (n: number): string => n.toFixed(2);

  return (
    <div className={styles.block}>
      <div className={styles.header}>
        <span className={styles.label}>{label}</span>
        <button
          className={styles.resetBtn}
          onClick={handleReset}
          title="Reset"
          aria-label={`Reset ${label}`}
        >
          ↺
        </button>
      </div>
      <div className={styles.canvasRow}>
        <div
          ref={masterRef}
          className={styles.masterSlider}
          onPointerDown={onMasterDown}
          onPointerMove={onMasterMove}
          onPointerUp={onMasterUp}
          onDoubleClick={onMasterDoubleClick}
          role="slider"
          aria-label={`${label} master`}
          aria-valuemin={-1}
          aria-valuemax={1}
          aria-valuenow={value.master}
          title="Master (double-click to reset)"
        >
          <div className={styles.masterTrack} />
          <div className={styles.masterCenter} />
          <div
            className={styles.masterFill}
            style={
              value.master >= 0
                ? {
                    top: `${(1 - value.master) * 50}%`,
                    height: `${value.master * 50}%`,
                  }
                : { top: "50%", height: `${-value.master * 50}%` }
            }
          />
          <div
            className={styles.masterThumb}
            style={{ top: `${(1 - value.master) * 50}%` }}
          />
        </div>
        <div className={styles.canvasWrap}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        </div>
      </div>
      <div className={styles.fields}>
        {(["master", "r", "g", "b"] as const).map((ch) => (
          <div key={ch} className={styles.fieldGroup}>
            <input
              type="number"
              className={styles.numInput}
              step={0.01}
              value={fmt(value[ch])}
              onChange={(e) => handleNumInput(ch, e.target.value)}
            />
            <div className={`${styles.fieldCh} ${styles["ch_" + ch]}`}>
              {ch === "master" ? "M" : ch.toUpperCase()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
