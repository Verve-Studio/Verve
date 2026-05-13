import React, { useCallback, useEffect, useState } from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import styles from "./RescaleImageDialog.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RescaleImageSettings {
  width: number;
  height: number;
  modelId: string;
}

export interface RescaleImageDialogProps {
  open: boolean;
  currentWidth: number;
  currentHeight: number;
  onConfirm: (settings: RescaleImageSettings) => void;
  onCancel: () => void;
}

interface ModelOption {
  id: string;
  label: string;
  scale: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RescaleImageDialog({
  open,
  currentWidth,
  currentHeight,
  onConfirm,
  onCancel,
}: RescaleImageDialogProps): React.JSX.Element | null {
  // Stored as strings so partial input ("", "12") doesn't snap back to a
  // clamped number while the user is mid-typing. The paired axis tracks
  // every keystroke from the one being edited; both are clamped only at
  // confirm time.
  const [widthText, setWidthText] = useState(String(currentWidth));
  const [heightText, setHeightText] = useState(String(currentHeight));
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [modelSearchPaths, setModelSearchPaths] = useState<string[]>([]);

  // Reset on open and load model list / status.
  useEffect(() => {
    if (!open) return;
    setWidthText(String(currentWidth));
    setHeightText(String(currentHeight));
    let cancelled = false;
    void (async (): Promise<void> => {
      const list = await window.api.upscale.listModels();
      if (cancelled) return;
      setModels(list);
      const id = list[0]?.id ?? "";
      setModelId(id);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, currentWidth, currentHeight]);

  // Re-check whenever the selected model changes.
  useEffect(() => {
    if (!open || !modelId) {
      setModelReady(null);
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      const res = await window.api.upscale.checkModel(modelId);
      if (cancelled) return;
      setModelReady(res.ready);
      setModelSearchPaths(res.searchedPaths);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, modelId]);

  // Forced aspect-ratio constraint: editing width drives height and vice versa
  // by a fixed multiplier derived from the source canvas — no toggle exposed
  // because rescaling at the wrong aspect would warp pixels the model was
  // trained on equal-aspect content.
  const ratio =
    currentWidth > 0 && currentHeight > 0
      ? currentWidth / currentHeight
      : 1;

  const handleWidthInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const raw = e.target.value;
      setWidthText(raw);
      // Only mirror to height when the partial value parses to a positive
      // number. Empty / "-" / "abc" leave the partner field as-is.
      const n = parseFloat(raw);
      if (!isNaN(n) && n > 0) {
        const paired = Math.max(1, Math.round(n / ratio));
        setHeightText(String(paired));
      }
    },
    [ratio],
  );

  const handleHeightInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const raw = e.target.value;
      setHeightText(raw);
      const n = parseFloat(raw);
      if (!isNaN(n) && n > 0) {
        const paired = Math.max(1, Math.round(n * ratio));
        setWidthText(String(paired));
      }
    },
    [ratio],
  );

  // Parsed view of the typed values, used for the confirm gate and the
  // dimension preview line. Anything unparseable resolves to 0 and blocks
  // the confirm button.
  const parsedW = Math.round(parseFloat(widthText));
  const parsedH = Math.round(parseFloat(heightText));
  const finalW =
    !isNaN(parsedW) && parsedW > 0 ? Math.min(8192, parsedW) : 0;
  const finalH =
    !isNaN(parsedH) && parsedH > 0 ? Math.min(8192, parsedH) : 0;

  const canConfirm =
    modelReady === true &&
    modelId.length > 0 &&
    finalW > 0 &&
    finalH > 0;

  const handleConfirm = useCallback((): void => {
    if (!canConfirm) return;
    onConfirm({ width: finalW, height: finalH, modelId });
  }, [canConfirm, finalW, finalH, modelId, onConfirm]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter") {
        e.stopPropagation();
        handleConfirm();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, handleConfirm]);

  const selectedScale = models.find((m) => m.id === modelId)?.scale ?? 1;
  const nativeW = currentWidth * selectedScale;
  const nativeH = currentHeight * selectedScale;

  return (
    <ModalDialog
      open={open}
      title="Rescale Image"
      width={400}
      onClose={onCancel}
    >
      <div className={styles.body}>
        <p className={styles.currentSize}>
          Current: {currentWidth} × {currentHeight} px
        </p>

        {/* ── Model picker ───────────────────────────────────────────── */}
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel}>Model</label>
          <select
            className={styles.select}
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {modelReady === false && (
          <div className={styles.warning}>
            <strong>Model file not found.</strong>
            <p>Place the .onnx file in one of:</p>
            <ul>
              {modelSearchPaths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          </div>
        )}

        <hr className={styles.divider} />

        {/* ── Target size (aspect-locked) ───────────────────────────── */}
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="rescale-w">
            Width
          </label>
          <div className={styles.inputGroup}>
            <input
              id="rescale-w"
              type="number"
              className={styles.numInput}
              value={widthText}
              min={1}
              max={8192}
              step={1}
              onChange={handleWidthInput}
            />
            <span className={styles.unit}>px</span>
          </div>
        </div>
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="rescale-h">
            Height
          </label>
          <div className={styles.inputGroup}>
            <input
              id="rescale-h"
              type="number"
              className={styles.numInput}
              value={heightText}
              min={1}
              max={8192}
              step={1}
              onChange={handleHeightInput}
            />
            <span className={styles.unit}>px</span>
          </div>
        </div>
        <p className={styles.aspectNote}>
          Aspect ratio locked to source ({ratio.toFixed(3)}).
        </p>

        {modelReady === true && (
          <p className={styles.note}>
            Model runs at {nativeW} × {nativeH} ({selectedScale}×); output is
            then resampled to your target size.
          </p>
        )}
      </div>

      <div className={styles.footer}>
        <DialogButton onClick={onCancel}>Cancel</DialogButton>
        <DialogButton onClick={handleConfirm} primary disabled={!canConfirm}>
          Rescale
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
