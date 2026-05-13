import React, { useCallback, useEffect, useState } from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import styles from "./RestoreImageDialog.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RestoreImageSettings {
  modelId: string;
}

export interface RestoreImageDialogProps {
  open: boolean;
  currentWidth: number;
  currentHeight: number;
  onConfirm: (settings: RestoreImageSettings) => void;
  onCancel: () => void;
}

interface ModelOption {
  id: string;
  label: string;
  scale: number;
}

// The general-v3 model is the best default for restoration — it preserves
// natural grain instead of the heavy smoothing the photo/anime models apply.
const DEFAULT_MODEL_ID = "realesr-general-x4v3";

// ─── Component ────────────────────────────────────────────────────────────────

export function RestoreImageDialog({
  open,
  currentWidth,
  currentHeight,
  onConfirm,
  onCancel,
}: RestoreImageDialogProps): React.JSX.Element | null {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [modelSearchPaths, setModelSearchPaths] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async (): Promise<void> => {
      const list = await window.api.upscale.listModels();
      if (cancelled) return;
      setModels(list);
      const preferred =
        list.find((m) => m.id === DEFAULT_MODEL_ID)?.id ?? list[0]?.id ?? "";
      setModelId(preferred);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

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

  const canConfirm = modelReady === true && modelId.length > 0;

  const handleConfirm = useCallback((): void => {
    if (!canConfirm) return;
    onConfirm({ modelId });
  }, [canConfirm, modelId, onConfirm]);

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

  const selectedScale = models.find((m) => m.id === modelId)?.scale ?? 4;

  return (
    <ModalDialog
      open={open}
      title="Restore Image"
      width={400}
      onClose={onCancel}
    >
      <div className={styles.body}>
        <p className={styles.intro}>
          Run the image through an upscale model at {selectedScale}× and
          resample back to the original size. Cleans up compression
          artifacts, mild noise, and slight blur without changing the
          canvas dimensions.
        </p>
        <p className={styles.currentSize}>
          Image stays at {currentWidth} × {currentHeight} px.
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
      </div>

      <div className={styles.footer}>
        <DialogButton onClick={onCancel}>Cancel</DialogButton>
        <DialogButton onClick={handleConfirm} primary disabled={!canConfirm}>
          Restore
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
