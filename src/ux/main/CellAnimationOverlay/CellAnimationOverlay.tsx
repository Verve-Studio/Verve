import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { shallowEqual, useAppSelector } from "@/core/store/AppContext";
import { cellPreviewStore } from "@/core/store/cellPreviewStore";
import { cellPlaybackStore } from "@/core/store/cellPlaybackStore";
import { cellFramePath } from "@/core/io/cellAnimationFiles";
import { EXT_TO_MIME, loadImageBytes } from "@/core/io/imageLoader";
import { convertF32ToRgba8 } from "@/utils/pixelFormatConvert";
import { notificationStore } from "@/core/store/notificationStore";
import type { CellAnimationState } from "@/types";
import styles from "./CellAnimationOverlay.module.scss";

/** Onion-skin tints (previous / next frames). */
const TINT_BEFORE = "rgba(255, 70, 70, 0.65)";
const TINT_AFTER = "rgba(60, 200, 90, 0.65)";

const subscribePreviews = (fn: () => void): (() => void) => cellPreviewStore.subscribe(fn);
const previewVersion = (): number => cellPreviewStore.version;
const subscribePlayback = (fn: () => void): (() => void) => cellPlaybackStore.subscribe(fn);
const playbackSnapshot = (): typeof cellPlaybackStore.snapshot => cellPlaybackStore.snapshot;

/** Whether the cell animation layers are drawn (Canvas hides the document
 *  and turns off the GPU checker on the same condition). */
export function useCellOverlayActive(): boolean {
  return useAppSelector(
    (s) => s.animationMode && s.cellAnimation.enabled && !s.canvas.tiledMode,
  );
}

/** True while playback (or a frame step's preview) covers the document. */
export function useCellPlaybackShowing(): boolean {
  return useSyncExternalStore(subscribePlayback, () => cellPlaybackStore.snapshot.showing);
}

export interface CellAnimationOverlayProps {
  /** "under": checker + reference background, beneath the document.
   *  "over": onion skins and playback, above it. */
  part: "under" | "over";
  /** Document size (the layers are drawn at document resolution). */
  width: number;
  height: number;
  /** Nearest-neighbour scaling at ≥ 100 % zoom, like the document. */
  pixelated: boolean;
}

/** Cell animation layers drawn with the document; render inside the canvas
 *  wrapper. */
export function CellAnimationOverlay(props: CellAnimationOverlayProps): React.JSX.Element | null {
  const active = useCellOverlayActive();
  if (!active) return null;
  return props.part === "under" ? <Under /> : <Over {...props} />;
}

// ─── Under: checker + reference background ────────────────────────────────────

function Under(): React.JSX.Element {
  const bg = useAppSelector((s) => s.cellAnimation.background);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shown = bg.visible && bg.path !== null;

  useEffect(() => {
    if (!shown || !bg.path) return;
    const path = bg.path;
    let cancelled = false;
    void (async () => {
      try {
        const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
        const img = await loadImageBytes(
          await window.api.readFile(path),
          EXT_TO_MIME[ext] ?? "image/png",
        );
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const rgba =
          img.data instanceof Float32Array ? convertF32ToRgba8(img.data) : img.data;
        canvas.width = img.width;
        canvas.height = img.height;
        canvas
          .getContext("2d")
          ?.putImageData(
            new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), img.width, img.height),
            0,
            0,
          );
      } catch (err) {
        if (cancelled) return;
        notificationStore.error(
          `Couldn't load the reference background: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shown, bg.path]);

  return (
    <div className={styles.under}>
      {shown && (
        <canvas
          ref={canvasRef}
          className={styles.background}
          style={{ opacity: bg.opacity }}
        />
      )}
    </div>
  );
}

// ─── Over: onion skins + playback ─────────────────────────────────────────────

type OnionInputs = Pick<CellAnimationState, "folder" | "frames" | "currentFrameId" | "onionSkin">;

function Over({ width, height, pixelated }: CellAnimationOverlayProps): React.JSX.Element {
  const cells = useAppSelector(
    (s): OnionInputs => ({
      folder: s.cellAnimation.folder,
      frames: s.cellAnimation.frames,
      currentFrameId: s.cellAnimation.currentFrameId,
      onionSkin: s.cellAnimation.onionSkin,
    }),
    shallowEqual,
  );
  const version = useSyncExternalStore(subscribePreviews, previewVersion);
  const playback = useSyncExternalStore(subscribePlayback, playbackSnapshot);
  const onionRef = useRef<HTMLCanvasElement>(null);
  const playRef = useRef<HTMLCanvasElement>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);

  const onionShown = cells.onionSkin.enabled && !playback.showing;

  // ── Onion skin ──
  useEffect(() => {
    const canvas = onionRef.current;
    if (!canvas || !onionShown) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const { folder, frames, currentFrameId, onionSkin } = cells;
    const cur = frames.findIndex((f) => f.id === currentFrameId);
    if (!folder || cur < 0) return;
    const scratch = (scratchRef.current ??= document.createElement("canvas"));
    const draw = (offset: number, count: number, tint: string): void => {
      const f = frames[cur + offset];
      const bitmap = f && cellPreviewStore.get(cellFramePath(folder, f));
      if (!bitmap) return;
      const distance = Math.abs(offset);
      // The nearest frame at full onion opacity, farther ones fading out.
      const alpha = onionSkin.opacity * (1 - (distance - 1) / (count + 1));
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      if (!onionSkin.tint) {
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return;
      }
      scratch.width = canvas.width;
      scratch.height = canvas.height;
      const s = scratch.getContext("2d");
      if (!s) return;
      s.globalCompositeOperation = "source-over";
      s.clearRect(0, 0, scratch.width, scratch.height);
      s.drawImage(bitmap, 0, 0, scratch.width, scratch.height);
      s.globalCompositeOperation = "source-atop";
      s.fillStyle = tint;
      s.fillRect(0, 0, scratch.width, scratch.height);
      ctx.drawImage(scratch, 0, 0);
    };
    // Farthest first so nearer frames land on top.
    for (let k = onionSkin.before; k >= 1; k--) draw(-k, onionSkin.before, TINT_BEFORE);
    for (let k = onionSkin.after; k >= 1; k--) draw(k, onionSkin.after, TINT_AFTER);
    ctx.globalAlpha = 1;
  }, [cells, version, onionShown, width, height]);

  // ── Playback frame ──
  useEffect(() => {
    const canvas = playRef.current;
    if (!canvas || !playback.showing) return;
    const ctx = canvas.getContext("2d");
    const f = cells.frames[playback.index];
    const bitmap = f && cells.folder ? cellPreviewStore.get(cellFramePath(cells.folder, f)) : undefined;
    // Without a preview yet the previous frame stays up.
    if (!ctx || !bitmap) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }, [playback.showing, playback.index, cells.frames, cells.folder, version, width, height]);

  const rendering = { imageRendering: pixelated ? "pixelated" : "auto" } as const;
  return (
    <>
      {onionShown && (
        <canvas ref={onionRef} className={styles.layer} width={width} height={height} style={rendering} />
      )}
      {playback.showing && (
        <canvas ref={playRef} className={styles.layer} width={width} height={height} style={rendering} />
      )}
    </>
  );
}
