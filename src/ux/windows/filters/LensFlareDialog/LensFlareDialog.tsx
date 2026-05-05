import React, { useState, useEffect, useCallback, useRef } from "react";
import { renderLensFlare } from "@/graphicspipeline/webgpu/compute/filterCompute";
import type { CanvasHandle } from "@/ux/main/Canvas/canvasHandle";
import { ToolWindow, DialogButton } from "@/ux";
import styles from "./LensFlareDialog.module.scss";

// ─── Constants ────────────────────────────────────────────────────────────────

const PREVIEW_MAX_W = 280;
const PREVIEW_MAX_H = 180;
const DEBOUNCE_BRIGHTNESS_MS = 150;

const LENS_TYPES = [
  { label: "50\u2013300mm Zoom" },
  { label: "35mm Prime" },
  { label: "105mm Prime" },
  { label: "Movie Prime" },
  { label: "Cinematic / Anamorphic" },
];

const LENS_TYPE_STREAK_DEFAULTS: { width: number; rotation: number }[] = [
  { width: 50, rotation: 0 },
  { width: 25, rotation: 0 },
  { width: 75, rotation: 0 },
  { width: 30, rotation: 0 },
  { width: 20, rotation: 0 },
];

// ─── Icon ─────────────────────────────────────────────────────────────────────

const LensFlareIcon = (): React.JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    aria-hidden="true"
  >
    <circle
      cx="6"
      cy="6"
      r="3.5"
      stroke="currentColor"
      strokeWidth="0.75"
      opacity="0.55"
    />
    <line
      x1="0.5"
      y1="6"
      x2="11.5"
      y2="6"
      stroke="currentColor"
      strokeWidth="0.9"
      opacity="0.6"
      strokeLinecap="round"
    />
    <line
      x1="6"
      y1="0.5"
      x2="6"
      y2="11.5"
      stroke="currentColor"
      strokeWidth="0.9"
      opacity="0.6"
      strokeLinecap="round"
    />
    <line
      x1="2.0"
      y1="2.0"
      x2="4.2"
      y2="4.2"
      stroke="currentColor"
      strokeWidth="0.75"
      opacity="0.4"
      strokeLinecap="round"
    />
    <line
      x1="7.8"
      y1="7.8"
      x2="10.0"
      y2="10.0"
      stroke="currentColor"
      strokeWidth="0.75"
      opacity="0.4"
      strokeLinecap="round"
    />
    <line
      x1="10.0"
      y1="2.0"
      x2="7.8"
      y2="4.2"
      stroke="currentColor"
      strokeWidth="0.75"
      opacity="0.4"
      strokeLinecap="round"
    />
    <line
      x1="2.0"
      y1="10.0"
      x2="4.2"
      y2="7.8"
      stroke="currentColor"
      strokeWidth="0.75"
      opacity="0.4"
      strokeLinecap="round"
    />
    <circle cx="6" cy="6" r="1.2" fill="currentColor" opacity="0.9" />
  </svg>
);

// ─── Props ────────────────────────────────────────────────────────────────────

export interface LensFlareDialogProps {
  isOpen: boolean;
  onApply: (pixels: Uint8Array, width: number, height: number) => void;
  onCancel: () => void;
  width: number;
  height: number;
  canvasHandleRef: { readonly current: CanvasHandle | null };
  activeLayerId: string | null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LensFlareDialog({
  isOpen,
  onApply,
  onCancel,
  width,
  height,
  canvasHandleRef,
  activeLayerId,
}: LensFlareDialogProps): React.JSX.Element | null {
  const previewScale = Math.min(
    1,
    Math.min(PREVIEW_MAX_W / width, PREVIEW_MAX_H / height),
  );
  const previewW = Math.round(width * previewScale);
  const previewH = Math.round(height * previewScale);

  const [lensType, setLensType] = useState(0);
  const [brightness, setBrightness] = useState(100);
  const [ringOpacity, setRingOpacity] = useState(20);
  const [streakStrength, setStreakStrength] = useState(50);
  const [streakWidth, setStreakWidth] = useState(
    LENS_TYPE_STREAK_DEFAULTS[0].width,
  );
  const [streakRotation, setStreakRotation] = useState(0);
  const [centerX, setCenterX] = useState(() => Math.round(width / 2));
  const [centerY, setCenterY] = useState(() => Math.round(height / 2));
  const [isBusy, setIsBusy] = useState(false);

  const lensTypeRef = useRef(0);
  const brightnessRef = useRef(100);
  const ringOpacityRef = useRef(20);
  const streakStrengthRef = useRef(50);
  const streakWidthRef = useRef(LENS_TYPE_STREAK_DEFAULTS[0].width);
  const streakRotationRef = useRef(0);
  const centerXRef = useRef(Math.round(width / 2));
  const centerYRef = useRef(Math.round(height / 2));

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── Preview render ───────────────────────────────────────────────
  const runPreview = useCallback(async (): Promise<void> => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const pCx = Math.round(centerXRef.current * previewScale);
    const pCy = Math.round(centerYRef.current * previewScale);
    try {
      const pixels = await renderLensFlare(
        previewW,
        previewH,
        pCx,
        pCy,
        brightnessRef.current,
        lensTypeRef.current,
        ringOpacityRef.current,
        streakStrengthRef.current,
        streakWidthRef.current,
        streakRotationRef.current,
      );
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, previewW, previewH);
      if (backgroundCanvasRef.current) {
        ctx.drawImage(backgroundCanvasRef.current, 0, 0);
      }
      const tmpCanvas = document.createElement("canvas");
      tmpCanvas.width = previewW;
      tmpCanvas.height = previewH;
      const tmpCtx = tmpCanvas.getContext("2d");
      if (tmpCtx) {
        tmpCtx.putImageData(
          new ImageData(
            new Uint8ClampedArray(pixels.buffer as ArrayBuffer),
            previewW,
            previewH,
          ),
          0,
          0,
        );
        ctx.drawImage(tmpCanvas, 0, 0);
      }
    } catch (err) {
      console.error("[LensFlareDialog] Preview render failed:", err);
    }
  }, [previewW, previewH, previewScale]);

  const triggerImmediate = useCallback((): void => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    void runPreview();
  }, [runPreview]);

  const triggerDebounced = useCallback((): void => {
    if (debounceTimerRef.current !== null)
      clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void runPreview();
    }, DEBOUNCE_BRIGHTNESS_MS);
  }, [runPreview]);

  // ── Reset + initial preview on open ─────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const defaultCx = Math.round(width / 2);
    const defaultCy = Math.round(height / 2);
    setLensType(0);
    lensTypeRef.current = 0;
    setBrightness(100);
    brightnessRef.current = 100;
    setRingOpacity(20);
    ringOpacityRef.current = 20;
    setStreakStrength(50);
    streakStrengthRef.current = 50;
    const def = LENS_TYPE_STREAK_DEFAULTS[0];
    setStreakWidth(def.width);
    streakWidthRef.current = def.width;
    setStreakRotation(def.rotation);
    streakRotationRef.current = def.rotation;
    setCenterX(defaultCx);
    centerXRef.current = defaultCx;
    setCenterY(defaultCy);
    centerYRef.current = defaultCy;
    setIsBusy(false);
    // Load and scale background pixels to preview size
    const bgPixels = activeLayerId
      ? canvasHandleRef.current?.getLayerPixels(activeLayerId)
      : null;
    if (bgPixels) {
      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = width;
      fullCanvas.height = height;
      const fullCtx = fullCanvas.getContext("2d");
      if (fullCtx) {
        fullCtx.putImageData(
          new ImageData(
            new Uint8ClampedArray(bgPixels.buffer as ArrayBuffer),
            width,
            height,
          ),
          0,
          0,
        );
        const bgCanvas = document.createElement("canvas");
        bgCanvas.width = previewW;
        bgCanvas.height = previewH;
        const bgCtx = bgCanvas.getContext("2d");
        if (bgCtx) {
          bgCtx.drawImage(fullCanvas, 0, 0, previewW, previewH);
          backgroundCanvasRef.current = bgCanvas;
        }
      }
    } else {
      backgroundCanvasRef.current = null;
    }
    void runPreview();
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, width, height]);

  // ── Escape key ───────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onCancel]);

  // ── Control handlers ─────────────────────────────────────────────
  const handleLensTypeChange = useCallback(
    (type: number): void => {
      setLensType(type);
      lensTypeRef.current = type;
      const def = LENS_TYPE_STREAK_DEFAULTS[type];
      setStreakWidth(def.width);
      streakWidthRef.current = def.width;
      setStreakRotation(def.rotation);
      streakRotationRef.current = def.rotation;
      triggerImmediate();
    },
    [triggerImmediate],
  );

  const handleBrightnessChange = useCallback(
    (value: number): void => {
      const clamped = Math.max(10, Math.min(300, Math.round(value)));
      setBrightness(clamped);
      brightnessRef.current = clamped;
      triggerDebounced();
    },
    [triggerDebounced],
  );

  const handleRingOpacityChange = useCallback(
    (value: number): void => {
      const clamped = Math.max(0, Math.min(100, Math.round(value)));
      setRingOpacity(clamped);
      ringOpacityRef.current = clamped;
      triggerDebounced();
    },
    [triggerDebounced],
  );

  const handleStreakStrengthChange = useCallback(
    (value: number): void => {
      const clamped = Math.max(0, Math.min(100, Math.round(value)));
      setStreakStrength(clamped);
      streakStrengthRef.current = clamped;
      triggerDebounced();
    },
    [triggerDebounced],
  );

  const handleStreakWidthChange = useCallback(
    (value: number): void => {
      const clamped = Math.max(1, Math.min(500, Math.round(value)));
      setStreakWidth(clamped);
      streakWidthRef.current = clamped;
      triggerDebounced();
    },
    [triggerDebounced],
  );

  const handleStreakRotationChange = useCallback(
    (value: number): void => {
      const clamped = Math.max(0, Math.min(359, Math.round(value)));
      setStreakRotation(clamped);
      streakRotationRef.current = clamped;
      triggerDebounced();
    },
    [triggerDebounced],
  );

  // ── Pointer interaction on preview canvas ────────────────────────
  const handlePreviewPointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): void => {
      if (!(e.buttons & 1)) return;
      const canvas = previewCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const relY = e.clientY - rect.top;
      const newCx = Math.round(
        Math.max(0, Math.min(width - 1, relX / previewScale)),
      );
      const newCy = Math.round(
        Math.max(0, Math.min(height - 1, relY / previewScale)),
      );
      setCenterX(newCx);
      centerXRef.current = newCx;
      setCenterY(newCy);
      centerYRef.current = newCy;
      triggerImmediate();
    },
    [width, height, previewScale, triggerImmediate],
  );

  // ── Apply ────────────────────────────────────────────────────────
  const handleApply = useCallback(async (): Promise<void> => {
    setIsBusy(true);
    try {
      const pixels = await renderLensFlare(
        width,
        height,
        centerXRef.current,
        centerYRef.current,
        brightnessRef.current,
        lensTypeRef.current,
        ringOpacityRef.current,
        streakStrengthRef.current,
        streakWidthRef.current,
        streakRotationRef.current,
      );
      onApply(pixels, width, height);
    } catch (err) {
      console.error("[LensFlareDialog] Apply failed:", err);
      setIsBusy(false);
    }
  }, [width, height, onApply]);

  if (!isOpen) return null;

  const crosshairX = Math.round(centerX * previewScale);
  const crosshairY = Math.round(centerY * previewScale);

  return (
    <ToolWindow
      title="Render Lens Flare"
      icon={<LensFlareIcon />}
      onClose={onCancel}
      width={580}
      defaultPosition={{
        x: Math.max(
          80,
          (typeof window !== "undefined" ? window.innerWidth : 1440) / 2 - 290,
        ),
        y: 80,
      }}
    >
      <div className={styles.body}>
        {/* Left column: preview */}
        <div className={styles.previewCol}>
          <div className={styles.previewWrap}>
            <canvas
              ref={previewCanvasRef}
              className={styles.previewCanvas}
              width={previewW}
              height={previewH}
              onPointerDown={handlePreviewPointer}
              onPointerMove={handlePreviewPointer}
            />
            <div
              className={styles.crosshair}
              style={{ left: crosshairX, top: crosshairY }}
              aria-hidden="true"
            >
              <div className={styles.crosshairDot} />
            </div>
          </div>

          <p className={styles.previewHint}>Click or drag to position flare</p>

          <div
            className={styles.positionRow}
            aria-label="Flare center position"
          >
            <div className={styles.posField}>
              <span className={styles.posLabel}>X</span>
              <input
                type="text"
                className={styles.posValue}
                value={centerX}
                readOnly
                tabIndex={-1}
                aria-label="Flare center X coordinate"
              />
              <span className={styles.posUnit}>px</span>
            </div>
            <div className={styles.posSep} />
            <div className={styles.posField}>
              <span className={styles.posLabel}>Y</span>
              <input
                type="text"
                className={styles.posValue}
                value={centerY}
                readOnly
                tabIndex={-1}
                aria-label="Flare center Y coordinate"
              />
              <span className={styles.posUnit}>px</span>
            </div>
          </div>
        </div>

        {/* Right column: controls */}
        <div className={styles.controlsCol}>
          <div>
            <div className={styles.sectionLabel}>Lens Type</div>
            <div
              className={styles.lensTypeGroup}
              role="radiogroup"
              aria-label="Lens type"
            >
              {LENS_TYPES.map((lt, idx) => (
                <div
                  key={idx}
                  className={`${styles.radioOption}${lensType === idx ? ` ${styles.active}` : ""}`}
                  role="radio"
                  aria-checked={lensType === idx}
                  tabIndex={0}
                  onClick={() => handleLensTypeChange(idx)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ")
                      handleLensTypeChange(idx);
                  }}
                >
                  <div className={styles.radioDot} />
                  <span className={styles.radioName}>{lt.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.divider} />

          <div className={styles.row}>
            <span className={styles.label} id="lbl-brightness">
              Brightness
            </span>
            <input
              type="range"
              className={styles.slider}
              style={
                {
                  "--pct": `${(((brightness - 10) / 290) * 100).toFixed(1)}%`,
                } as React.CSSProperties
              }
              min={10}
              max={300}
              step={1}
              value={brightness}
              onChange={(e) => handleBrightnessChange(e.target.valueAsNumber)}
            />
            <input
              type="number"
              className={styles.numberInput}
              min={10}
              max={300}
              step={1}
              value={brightness}
              onChange={(e) => handleBrightnessChange(e.target.valueAsNumber)}
              onBlur={(e) => handleBrightnessChange(e.target.valueAsNumber)}
            />
            <span className={styles.unit}>%</span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Rings</span>
            <input
              type="range"
              className={styles.slider}
              style={{ "--pct": `${ringOpacity}%` } as React.CSSProperties}
              min={0}
              max={100}
              step={1}
              value={ringOpacity}
              onChange={(e) => handleRingOpacityChange(e.target.valueAsNumber)}
            />
            <input
              type="number"
              className={styles.numberInput}
              min={0}
              max={100}
              step={1}
              value={ringOpacity}
              onChange={(e) => handleRingOpacityChange(e.target.valueAsNumber)}
              onBlur={(e) => handleRingOpacityChange(e.target.valueAsNumber)}
            />
            <span className={styles.unit}>%</span>
          </div>
          <div className={styles.streakSection}>
            <div className={styles.sectionLabel}>Streaks</div>
            <div className={styles.streakGroup}>
              <div className={styles.row}>
                <span className={styles.label}>Streaks</span>
                <input
                  type="range"
                  className={styles.slider}
                  style={
                    { "--pct": `${streakStrength}%` } as React.CSSProperties
                  }
                  min={0}
                  max={100}
                  step={1}
                  value={streakStrength}
                  onChange={(e) =>
                    handleStreakStrengthChange(e.target.valueAsNumber)
                  }
                />
                <input
                  type="number"
                  className={styles.numberInput}
                  min={0}
                  max={100}
                  step={1}
                  value={streakStrength}
                  onChange={(e) =>
                    handleStreakStrengthChange(e.target.valueAsNumber)
                  }
                  onBlur={(e) =>
                    handleStreakStrengthChange(e.target.valueAsNumber)
                  }
                />
                <span className={styles.unit}>%</span>
              </div>
              <div className={styles.row}>
                <span className={styles.label}>Width</span>
                <input
                  type="range"
                  className={styles.slider}
                  style={
                    {
                      "--pct": `${(((streakWidth - 1) / 499) * 100).toFixed(1)}%`,
                    } as React.CSSProperties
                  }
                  min={1}
                  max={500}
                  step={1}
                  value={streakWidth}
                  onChange={(e) =>
                    handleStreakWidthChange(e.target.valueAsNumber)
                  }
                />
                <input
                  type="number"
                  className={styles.numberInput}
                  min={1}
                  max={500}
                  step={1}
                  value={streakWidth}
                  onChange={(e) =>
                    handleStreakWidthChange(e.target.valueAsNumber)
                  }
                  onBlur={(e) =>
                    handleStreakWidthChange(e.target.valueAsNumber)
                  }
                />
                <span className={styles.unit}>%</span>
              </div>
              <div className={styles.row}>
                <span className={styles.label}>Rotation</span>
                <input
                  type="range"
                  className={styles.slider}
                  style={
                    {
                      "--pct": `${((streakRotation / 359) * 100).toFixed(1)}%`,
                    } as React.CSSProperties
                  }
                  min={0}
                  max={359}
                  step={1}
                  value={streakRotation}
                  onChange={(e) =>
                    handleStreakRotationChange(e.target.valueAsNumber)
                  }
                />
                <input
                  type="number"
                  className={styles.numberInput}
                  min={0}
                  max={359}
                  step={1}
                  value={streakRotation}
                  onChange={(e) =>
                    handleStreakRotationChange(e.target.valueAsNumber)
                  }
                  onBlur={(e) =>
                    handleStreakRotationChange(e.target.valueAsNumber)
                  }
                />
                <span className={styles.unit}>°</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.footer}>
        <DialogButton onClick={onCancel}>Cancel</DialogButton>
        <DialogButton
          primary
          onClick={() => {
            void handleApply();
          }}
          disabled={isBusy}
        >
          {isBusy ? "Rendering\u2026" : "Apply"}
        </DialogButton>
      </div>
    </ToolWindow>
  );
}
