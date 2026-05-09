import React, { useCallback, useEffect, useMemo, useState } from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import styles from "./ExportAnimationFramesDialog.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FrameSequenceFormat = "png" | "jpeg" | "webp" | "tga" | "tiff";

/** How multiple cycling groups are combined in the exported sequence:
 *  - `parallel`  — every selected group cycles together. Total frame count is
 *    the LCM of the individual periods (current behaviour).
 *  - `sequential` — each selected group plays its own period in turn while
 *    the other selected groups stay at tick 0. Total frame count is the
 *    sum of the individual periods. */
export type PaletteCycleEvaluation = "parallel" | "sequential";

export interface ExportAnimationFramesSettings {
  folder: string;
  baseName: string;
  format: FrameSequenceFormat;
  /** Total frames the dialog will produce — supplied by the caller and shown
   *  in the preview. */
  frameCount: number;
  startIndex: number;
  padDigits: number;
  jpegQuality: number;
  webpQuality: number;
  /** Subset of palette-cycling group IDs to include in the exported sequence.
   *  Empty in spritesheet mode. */
  selectedPaletteGroupIds: string[];
  /** How the selected groups are scheduled across frames. Spritesheet
   *  exports ignore this. */
  paletteCycleEvaluation: PaletteCycleEvaluation;
}

export interface PaletteGroupOption {
  id: string;
  name: string;
}

export interface ExportAnimationFramesDialogProps {
  open: boolean;
  /** Optional human-readable label for the source animation, shown in the
   *  preview line. */
  animationName?: string;
  /** Cycling-enabled palette groups, when palette animation is the active
   *  mode. Empty/undefined for spritesheet exports — in that case the
   *  group selector UI is hidden and the frame count comes straight from
   *  `computeFrameCount([])`. */
  paletteGroups?: PaletteGroupOption[];
  /** Returns the resulting frame count for a given group selection +
   *  evaluation mode. Spritesheet mode ignores both arguments; palette
   *  mode returns the cycle length implied by the selection and mode. */
  computeFrameCount: (
    selectedGroupIds: string[],
    evaluation: PaletteCycleEvaluation,
  ) => number;
  /** Async — must report progress via `onProgress(current, total)` on each
   *  frame written and resolve when the entire sequence has been saved. */
  onConfirm: (
    settings: ExportAnimationFramesSettings,
    onProgress: (current: number, total: number) => void,
  ) => Promise<void>;
  onCancel: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EXT: Record<FrameSequenceFormat, string> = {
  png: ".png",
  jpeg: ".jpg",
  webp: ".webp",
  tga: ".tga",
  tiff: ".tif",
};

function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ExportAnimationFramesDialog({
  open,
  animationName,
  paletteGroups,
  computeFrameCount,
  onConfirm,
  onCancel,
}: ExportAnimationFramesDialogProps): React.JSX.Element | null {
  const [folder, setFolder] = useState<string>("");
  const [baseName, setBaseName] = useState<string>("frame_");
  const [format, setFormat] = useState<FrameSequenceFormat>("png");
  const [startIndex, setStartIndex] = useState<number>(1);
  const [padDigits, setPadDigits] = useState<number>(7);
  const [jpegQuality, setJpegQuality] = useState<number>(92);
  const [webpQuality, setWebpQuality] = useState<number>(90);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"configure" | "exporting" | "done">(
    "configure",
  );
  const [progress, setProgress] = useState<{ current: number; total: number }>(
    { current: 0, total: 0 },
  );
  const [doneSummary, setDoneSummary] = useState<{
    count: number;
    folder: string;
  }>({ count: 0, folder: "" });
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [evaluation, setEvaluation] =
    useState<PaletteCycleEvaluation>("parallel");

  // Reset transient state on open. Group selection defaults to "all
  // currently-cycling groups" so palette exports keep the existing
  // behaviour unless the user trims down.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setPhase("configure");
    setProgress({ current: 0, total: 0 });
    setSelectedGroupIds(paletteGroups ? paletteGroups.map((g) => g.id) : []);
    setEvaluation("parallel");
  }, [open, paletteGroups]);

  const frameCount = useMemo(
    () => computeFrameCount(selectedGroupIds, evaluation),
    [computeFrameCount, selectedGroupIds, evaluation],
  );

  const toggleGroup = useCallback((id: string): void => {
    setSelectedGroupIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const handleBrowse = useCallback(async (): Promise<void> => {
    const picked = await window.api.openDirectoryDialog();
    if (!picked) return;
    setFolder(picked);
    setError(null);
  }, []);

  const safeBase = baseName.replace(/[\\/:*?"<>|]/g, "");

  const previewName = useMemo(() => {
    return `${safeBase}${pad(startIndex, padDigits)}${EXT[format]}`;
  }, [safeBase, startIndex, padDigits, format]);

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (!folder) {
      setError("Pick an output folder first.");
      return;
    }
    if (!safeBase) {
      setError("Base name cannot be empty.");
      return;
    }
    if (frameCount <= 0) {
      setError("No frames to export.");
      return;
    }
    const settings: ExportAnimationFramesSettings = {
      folder,
      baseName: safeBase,
      format,
      frameCount,
      startIndex: Math.max(0, Math.floor(startIndex)),
      padDigits: Math.max(1, Math.min(12, Math.floor(padDigits))),
      jpegQuality: Math.max(1, Math.min(100, Math.round(jpegQuality))),
      webpQuality: Math.max(1, Math.min(100, Math.round(webpQuality))),
      selectedPaletteGroupIds: paletteGroups ? selectedGroupIds : [],
      paletteCycleEvaluation: evaluation,
    };
    setError(null);
    setPhase("exporting");
    setProgress({ current: 0, total: frameCount });
    try {
      await onConfirm(settings, (current, total) =>
        setProgress({ current, total }),
      );
      setDoneSummary({ count: frameCount, folder });
      setPhase("done");
    } catch (err) {
      setError(`Export failed: ${(err as Error).message}`);
      setPhase("configure");
    }
  }, [
    folder,
    safeBase,
    frameCount,
    onConfirm,
    format,
    startIndex,
    padDigits,
    jpegQuality,
    webpQuality,
  ]);

  if (phase === "exporting") {
    const pct =
      progress.total > 0
        ? Math.round((progress.current / progress.total) * 100)
        : 0;
    return (
      <ModalDialog
        open={open}
        title="Export Animation to Frames"
        width={520}
        onClose={() => {
          /* no-op while exporting */
        }}
      >
        <div className={styles.body}>
          <p className={styles.preview}>
            Exporting frame {progress.current} of {progress.total}…
          </p>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <div className={styles.footer}>
          <DialogButton onClick={() => undefined} disabled>
            Exporting…
          </DialogButton>
        </div>
      </ModalDialog>
    );
  }

  if (phase === "done") {
    return (
      <ModalDialog
        open={open}
        title="Export Complete"
        width={460}
        onClose={onCancel}
      >
        <div className={styles.body}>
          <p className={styles.preview}>
            Wrote {doneSummary.count} frame
            {doneSummary.count === 1 ? "" : "s"} to:
          </p>
          <div className={styles.folderPath} title={doneSummary.folder}>
            {doneSummary.folder}
          </div>
        </div>
        <div className={styles.footer}>
          <DialogButton onClick={onCancel} primary>
            Close
          </DialogButton>
        </div>
      </ModalDialog>
    );
  }

  return (
    <ModalDialog
      open={open}
      title="Export Animation to Frames"
      width={520}
      onClose={onCancel}
    >
      <div className={styles.body}>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Folder</span>
          <div className={styles.folderRow}>
            <div
              className={`${styles.folderPath} ${folder ? "" : styles.folderEmpty}`}
              title={folder || undefined}
            >
              {folder || "No folder selected"}
            </div>
            <button
              type="button"
              className={styles.browseBtn}
              onClick={() => void handleBrowse()}
            >
              Browse…
            </button>
          </div>
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="ex-frames-base">
            Base name
          </label>
          <input
            id="ex-frames-base"
            type="text"
            className={styles.input}
            value={baseName}
            onChange={(e) => setBaseName(e.target.value)}
          />
        </div>

        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="ex-frames-format">
            Format
          </label>
          <select
            id="ex-frames-format"
            className={styles.select}
            value={format}
            onChange={(e) => setFormat(e.target.value as FrameSequenceFormat)}
          >
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
            <option value="tga">TGA</option>
            <option value="tiff">TIFF</option>
          </select>
        </div>

        {paletteGroups && paletteGroups.length > 0 && (
          <>
            <div className={styles.fieldRow}>
              <span className={styles.fieldLabel}>Cycle groups</span>
              <div className={styles.groupList}>
                {paletteGroups.map((g) => {
                  const checked = selectedGroupIds.includes(g.id);
                  return (
                    <label
                      key={g.id}
                      className={styles.groupItem}
                      title={g.name}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleGroup(g.id)}
                      />
                      <span className={styles.groupName}>{g.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className={styles.fieldRow}>
              <label className={styles.fieldLabel} htmlFor="ex-frames-eval">
                Evaluation
              </label>
              <select
                id="ex-frames-eval"
                className={styles.select}
                value={evaluation}
                onChange={(e) =>
                  setEvaluation(e.target.value as PaletteCycleEvaluation)
                }
              >
                <option value="parallel">
                  Parallel — all groups cycle together
                </option>
                <option value="sequential">
                  Sequential — each group plays in turn
                </option>
              </select>
            </div>
          </>
        )}

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Start / Pad</span>
          <div className={styles.dualSlider}>
            <span className={styles.subLabel}>Start</span>
            <SliderInput
              value={startIndex}
              min={0}
              max={9999}
              step={1}
              inputWidth={48}
              onChange={setStartIndex}
            />
            <span className={styles.subLabel}>Digits</span>
            <SliderInput
              value={padDigits}
              min={1}
              max={12}
              step={1}
              inputWidth={36}
              onChange={setPadDigits}
            />
          </div>
        </div>

        {format === "jpeg" && (
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel} htmlFor="ex-frames-jpegq">
              JPEG quality
            </label>
            <input
              id="ex-frames-jpegq"
              type="range"
              className={styles.slider}
              min={1}
              max={100}
              value={jpegQuality}
              onChange={(e) => setJpegQuality(e.target.valueAsNumber)}
            />
            <input
              type="number"
              className={styles.sliderValue}
              min={1}
              max={100}
              value={jpegQuality}
              onChange={(e) => {
                const v = e.target.valueAsNumber;
                if (!isNaN(v))
                  setJpegQuality(Math.max(1, Math.min(100, v)));
              }}
            />
          </div>
        )}

        {format === "webp" && (
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel} htmlFor="ex-frames-webpq">
              WebP quality
            </label>
            <input
              id="ex-frames-webpq"
              type="range"
              className={styles.slider}
              min={1}
              max={100}
              value={webpQuality}
              onChange={(e) => setWebpQuality(e.target.valueAsNumber)}
            />
            <input
              type="number"
              className={styles.sliderValue}
              min={1}
              max={100}
              value={webpQuality}
              onChange={(e) => {
                const v = e.target.valueAsNumber;
                if (!isNaN(v))
                  setWebpQuality(Math.max(1, Math.min(100, v)));
              }}
            />
          </div>
        )}

        <p className={styles.preview}>
          {frameCount > 0
            ? `${frameCount} frame${frameCount === 1 ? "" : "s"}${
                animationName ? ` from "${animationName}"` : ""
              } → ${previewName} … ${safeBase}${pad(startIndex + frameCount - 1, padDigits)}${EXT[format]}`
            : "No frames to export."}
        </p>
        {error && <p className={styles.error}>{error}</p>}
      </div>

      <div className={styles.footer}>
        <DialogButton onClick={onCancel}>Cancel</DialogButton>
        <DialogButton
          onClick={() => void handleConfirm()}
          primary
          disabled={!folder || frameCount <= 0}
        >
          Export
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
