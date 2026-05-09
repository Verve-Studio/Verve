import React, { useEffect, useState, useCallback } from "react";

import { useAppContext } from "@/core/store/AppContext";
import type { TransformHandleMode, TransformInterpolation } from "@/types";
import styles from "./TransformToolbar.module.scss";
import { activeScope } from "@/core/store/scope";

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

// ─── Component ────────────────────────────────────────────────────────────────

export function TransformToolbar(): React.JSX.Element {
  const { state } = useAppContext();
  const isIndexed = state.pixelFormat === "indexed8";
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
      <span
        className={styles.groupLabel}
        style={isIndexed ? { opacity: 0.4 } : undefined}
      >
        Interp
      </span>
      <select
        className={styles.selectInput}
        value={isIndexed ? "nearest" : interpolation}
        onChange={(e) => setInterp(e.target.value as TransformInterpolation)}
        disabled={isIndexed}
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
