import React, { useCallback, useEffect, useState } from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import {
  EXT_TO_MIME,
  IMAGE_EXTENSIONS,
  loadImagePixels,
} from "@/core/io/imageLoader";
import { clampF32ToUint8 } from "@/utils/pixelFormatConvert";
import styles from "./ImportSpritesheetFramesDialog.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImportSpritesheetFramesResult {
  /** Decoded frames, in the order they should be plotted (left-to-right,
   *  row-by-row). Each is layer-local RGBA, frameWidth × frameHeight. */
  frames: Uint8Array[];
  frameWidth: number;
  frameHeight: number;
}

export interface ImportSpritesheetFramesDialogProps {
  open: boolean;
  canvasWidth: number;
  canvasHeight: number;
  onConfirm: (result: ImportSpritesheetFramesResult) => void;
  onCancel: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ImportSpritesheetFramesDialog({
  open,
  canvasWidth,
  canvasHeight,
  onConfirm,
  onCancel,
}: ImportSpritesheetFramesDialogProps): React.JSX.Element | null {
  const [paths, setPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset on open.
  useEffect(() => {
    if (open) {
      setPaths([]);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const handleAddFiles = useCallback(async (): Promise<void> => {
    const picked = await window.api.openImagesMultiDialog();
    if (!picked || picked.length === 0) return;
    const supported = picked.filter((p) => {
      const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
      return IMAGE_EXTENSIONS.has(ext);
    });
    if (supported.length === 0) {
      setError("None of the selected files are supported image types.");
      return;
    }
    setError(null);
    setPaths((prev) => {
      // De-dupe — same path picked twice is silently ignored.
      const seen = new Set(prev);
      const merged = [...prev];
      for (const p of supported) {
        if (!seen.has(p)) {
          merged.push(p);
          seen.add(p);
        }
      }
      return merged;
    });
  }, []);

  const handleRemove = useCallback((idx: number): void => {
    setPaths((prev) => prev.filter((_, i) => i !== idx));
    setError(null);
  }, []);

  const handleClearAll = useCallback((): void => {
    setPaths([]);
    setError(null);
  }, []);

  const handleImport = useCallback(async (): Promise<void> => {
    if (paths.length === 0) {
      setError("Add at least one frame.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Decode each file via the shared loadImagePixels path.
      const decoded: { pixels: Uint8Array; width: number; height: number }[] =
        [];
      for (const path of paths) {
        const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
        const mime = EXT_TO_MIME[ext] ?? "image/png";
        const base64 = await window.api.readFileBase64(path);
        const loaded = await loadImagePixels(`data:${mime};base64,${base64}`);
        const u8 =
          loaded.data instanceof Float32Array
            ? clampF32ToUint8(loaded.data)
            : loaded.data;
        decoded.push({ pixels: u8, width: loaded.width, height: loaded.height });
      }

      // Validate uniform dimensions.
      const fw = decoded[0].width;
      const fh = decoded[0].height;
      for (let i = 1; i < decoded.length; i++) {
        if (decoded[i].width !== fw || decoded[i].height !== fh) {
          setError(
            `All frames must have the same dimensions. Frame 1 is ${fw}×${fh}, frame ${i + 1} is ${decoded[i].width}×${decoded[i].height}.`,
          );
          setBusy(false);
          return;
        }
      }

      // Validate that all frames fit on the canvas grid.
      const cols = Math.max(0, Math.floor(canvasWidth / fw));
      const rows = Math.max(0, Math.floor(canvasHeight / fh));
      const capacity = cols * rows;
      if (capacity === 0) {
        setError(
          `Frame size ${fw}×${fh} doesn't fit on a ${canvasWidth}×${canvasHeight} canvas.`,
        );
        setBusy(false);
        return;
      }
      if (decoded.length > capacity) {
        setError(
          `${decoded.length} frames don't fit on a ${canvasWidth}×${canvasHeight} canvas at ${fw}×${fh} per frame (max ${capacity}).`,
        );
        setBusy(false);
        return;
      }

      onConfirm({
        frames: decoded.map((d) => d.pixels),
        frameWidth: fw,
        frameHeight: fh,
      });
    } catch (err) {
      setError(`Failed to read frames: ${(err as Error).message}`);
      setBusy(false);
    }
  }, [paths, canvasWidth, canvasHeight, onConfirm]);

  // Capacity hint for the user (0 if list is empty).
  const summary =
    paths.length === 0
      ? `Canvas: ${canvasWidth}×${canvasHeight} px.`
      : `${paths.length} file${paths.length === 1 ? "" : "s"} selected. Canvas: ${canvasWidth}×${canvasHeight} px.`;

  return (
    <ModalDialog
      open={open}
      title="Import Frames Into Spritesheet"
      width={520}
      onClose={onCancel}
    >
      <div className={styles.body}>
        <p className={styles.intro}>
          Add image files to plot onto the current canvas left-to-right, row
          by row. All frames must have identical dimensions and fit within
          the canvas. An animation containing every frame will be created.
        </p>

        <div className={styles.actions}>
          <DialogButton onClick={() => void handleAddFiles()}>
            Add Files…
          </DialogButton>
          <DialogButton
            onClick={handleClearAll}
            disabled={paths.length === 0 || busy}
          >
            Clear
          </DialogButton>
        </div>

        <div className={styles.list}>
          {paths.length === 0 ? (
            <div className={styles.empty}>No files selected yet.</div>
          ) : (
            paths.map((p, i) => {
              const name = p.split(/[\\/]/).pop() ?? p;
              return (
                <div className={styles.row} key={`${i}-${p}`}>
                  <span className={styles.idx}>{i + 1}.</span>
                  <span className={styles.name} title={p}>
                    {name}
                  </span>
                  <button
                    className={styles.removeBtn}
                    onClick={() => handleRemove(i)}
                    title="Remove"
                    aria-label="Remove"
                    disabled={busy}
                  >
                    ×
                  </button>
                </div>
              );
            })
          )}
        </div>

        <p className={styles.summary}>{summary}</p>
        {error && <p className={styles.error}>{error}</p>}
      </div>

      <div className={styles.footer}>
        <DialogButton onClick={onCancel} disabled={busy}>
          Cancel
        </DialogButton>
        <DialogButton
          onClick={() => void handleImport()}
          primary
          disabled={paths.length === 0 || busy}
        >
          {busy ? "Importing…" : "Import"}
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
