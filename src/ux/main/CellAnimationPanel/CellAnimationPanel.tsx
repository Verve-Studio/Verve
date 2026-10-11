import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAppSelector } from "@/core/store/AppContext";
import type { CellAnimationCommands } from "@/core/services/useCellAnimation";
import { cellPreviewStore } from "@/core/store/cellPreviewStore";
import { cellFramePath } from "@/core/io/cellAnimationFiles";
import type { CellFileType, CellFrame } from "@/types";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";
import { ToggleSwitch } from "@/ux/widgets/ToggleSwitch/ToggleSwitch";
import { DialogButton } from "@/ux/widgets/DialogButton/DialogButton";
import { ModalDialog } from "@/ux/modals/ModalDialog/ModalDialog";
import styles from "./CellAnimationPanel.module.scss";

export interface CellAnimationPanelProps {
  commands: CellAnimationCommands;
}

const THUMB_W = 48;
const THUMB_H = 32;

const subscribePreviews = (fn: () => void): (() => void) => cellPreviewStore.subscribe(fn);
const previewVersion = (): number => cellPreviewStore.version;

/** A frame's preview, letterboxed into the thumbnail. */
function FrameThumb({ path }: { path: string }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const version = useSyncExternalStore(subscribePreviews, previewVersion);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const bitmap = cellPreviewStore.get(path);
    if (!bitmap) return;
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }, [path, version]);
  return <canvas ref={ref} className={styles.thumb} width={THUMB_W * 2} height={THUMB_H * 2} />;
}

/** A numeric field with a fixed-width unit slot, so inputs with and without
 *  a unit line up. */
function Field({
  unit,
  ...props
}: Omit<React.ComponentProps<typeof SliderInput>, "suffix" | "inputWidth"> & {
  unit?: string;
}): React.JSX.Element {
  return (
    <span className={styles.field}>
      <SliderInput {...props} inputWidth={40} />
      <span className={styles.unit}>{unit}</span>
    </span>
  );
}

/** Cell animation settings and frame list (Animation panel). */
export function CellAnimationPanel({ commands }: CellAnimationPanelProps): React.JSX.Element {
  const cells = useAppSelector((s) => s.cellAnimation);
  const { folder, frames, currentFrameId, selectedFrameIds, onionSkin, background } = cells;

  // ── Folder field ─────────────────────────────────────────────────────────
  const [folderDraft, setFolderDraft] = useState(folder ?? "");
  useEffect(() => setFolderDraft(folder ?? ""), [folder]);
  // Show the end of a long path (the folder's own name) when not editing.
  const folderInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = folderInputRef.current;
    if (el && document.activeElement !== el) el.scrollLeft = el.scrollWidth;
  }, [folderDraft]);
  const [confirmOpen, setConfirmOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async (path: string, discardUnsaved = false): Promise<void> => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const result = await commands.openFolder(trimmed, { discardUnsaved });
      if (result === "confirm") setConfirmOpen(trimmed);
    } finally {
      setBusy(false);
    }
  };
  const browse = async (): Promise<void> => {
    const path = await commands.pickFolder();
    if (path) await open(path);
  };

  // ── Selection ────────────────────────────────────────────────────────────
  const selected = new Set(selectedFrameIds);
  const anchorRef = useRef<string | null>(null);
  const onFrameClick = (e: React.MouseEvent, frame: CellFrame, index: number): void => {
    if (e.shiftKey && anchorRef.current) {
      const a = frames.findIndex((f) => f.id === anchorRef.current);
      if (a >= 0) {
        const [lo, hi] = a < index ? [a, index] : [index, a];
        commands.selectFrames(frames.slice(lo, hi + 1).map((f) => f.id));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      anchorRef.current = frame.id;
      commands.selectFrames(
        selected.has(frame.id)
          ? selectedFrameIds.filter((id) => id !== frame.id)
          : [...selectedFrameIds, frame.id],
      );
      return;
    }
    anchorRef.current = frame.id;
    commands.selectFrames([frame.id]);
    void commands.goToFrame(frame.id);
  };

  /** Frames an action applies to: the selection, else the current frame. */
  const targetIds = (): string[] =>
    selectedFrameIds.length > 0
      ? selectedFrameIds
      : currentFrameId
        ? [currentFrameId]
        : [];

  // ── Delete ───────────────────────────────────────────────────────────────
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const requestDelete = (ids: string[]): void => {
    if (ids.length > 0) setDeleteIds(ids);
  };

  // ── Drag to reorder ──────────────────────────────────────────────────────
  const dragIdsRef = useRef<string[] | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const onDragStart = (e: React.DragEvent, frame: CellFrame): void => {
    const ids = selected.has(frame.id) ? frames.filter((f) => selected.has(f.id)).map((f) => f.id) : [frame.id];
    if (!selected.has(frame.id)) commands.selectFrames([frame.id]);
    dragIdsRef.current = ids;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", ids.join(","));
  };
  const onDragOver = (e: React.DragEvent, index: number): void => {
    if (!dragIdsRef.current) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropIndex(e.clientY < rect.top + rect.height / 2 ? index : index + 1);
  };
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    if (dragIdsRef.current && dropIndex !== null) {
      commands.moveFrames(dragIdsRef.current, dropIndex);
    }
    dragIdsRef.current = null;
    setDropIndex(null);
  };
  const onDragEnd = (): void => {
    dragIdsRef.current = null;
    setDropIndex(null);
  };

  const selectionDuration = (() => {
    const ids = new Set(targetIds());
    const ds = frames.filter((f) => ids.has(f.id)).map((f) => f.duration);
    return ds.length > 0 ? ds[0] : 1;
  })();

  return (
    <>
      {/* ── Folder ─────────────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Cell Animation</div>
        <div className={styles.folderRow}>
          <input
            ref={folderInputRef}
            className={styles.textInput}
            value={folderDraft}
            placeholder="Folder for the frame files…"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setFolderDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void open(folderDraft);
              if (e.key === "Escape") setFolderDraft(folder ?? "");
            }}
            onBlur={() => setFolderDraft(folder ?? "")}
            title={folder ?? undefined}
          />
          <button className={styles.btn} disabled={busy} onClick={() => void browse()}>
            Browse…
          </button>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>Cell type</span>
          <select
            className={styles.select}
            value={cells.fileType}
            onChange={(e) => commands.setFileType(e.target.value as CellFileType)}
            title="File format new frames are saved in"
          >
            <option value="verve">Verve (.verve)</option>
            <option value="exr">OpenEXR (.exr)</option>
          </select>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>FPS</span>
          <Field
            value={cells.fps}
            min={1}
            max={60}
            step={1}
            onChange={commands.setFps}
          />
        </div>
      </div>

      {/* ── Onion skin ─────────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <span>Onion Skin</span>
          <ToggleSwitch
            checked={onionSkin.enabled}
            onChange={(enabled) => commands.setOnionSkin({ enabled })}
          />
        </div>
        <div className={`${styles.rows} ${onionSkin.enabled ? "" : styles.rowsDisabled}`}>
          <div className={styles.row}>
            <span className={styles.label}>Previous</span>
            <Field value={onionSkin.before} min={0} max={5} step={1} onChange={(before) => commands.setOnionSkin({ before })} />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Next</span>
            <Field value={onionSkin.after} min={0} max={5} step={1} onChange={(after) => commands.setOnionSkin({ after })} />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Opacity</span>
            <Field
              value={Math.round(onionSkin.opacity * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              onChange={(v) => commands.setOnionSkin({ opacity: v / 100 })}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.label} title="Previous frames red, next frames green">
              Tint
            </span>
            <ToggleSwitch checked={onionSkin.tint} onChange={(tint) => commands.setOnionSkin({ tint })} />
          </div>
        </div>
      </div>

      {/* ── Reference background ───────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <span>Background Reference</span>
          <ToggleSwitch
            checked={background.visible}
            disabled={!background.path}
            onChange={(visible) => commands.setBackground({ visible })}
          />
        </div>
        <div className={styles.folderRow}>
          <span className={styles.pathLabel} title={background.path ?? undefined}>
            {background.path ? background.path.split(/[\\/]/).pop() : "None"}
          </span>
          <button className={styles.btn} onClick={() => void commands.browseBackground()}>
            Browse…
          </button>
          {background.path && (
            <button
              className={styles.iconBtn}
              title="Remove the reference image"
              onClick={() => commands.setBackground({ path: null })}
            >
              ×
            </button>
          )}
        </div>
        <div className={`${styles.row} ${background.path ? "" : styles.rowsDisabled}`}>
          <span className={styles.label}>Opacity</span>
          <Field
            value={Math.round(background.opacity * 100)}
            min={0}
            max={100}
            step={1}
            unit="%"
            onChange={(v) => commands.setBackground({ opacity: v / 100 })}
          />
        </div>
      </div>

      {/* ── Frames ─────────────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          <span>Frames</span>
          <div className={styles.titleActions}>
            <button
              className={styles.iconBtn}
              title="New empty frame after the current one"
              disabled={!folder || busy}
              onClick={() => void commands.addFrame("blank")}
            >
              +
            </button>
            <button
              className={styles.iconBtn}
              title="Duplicate the current frame"
              disabled={!folder || !currentFrameId || busy}
              onClick={() => void commands.addFrame("duplicate")}
            >
              ⧉
            </button>
            <button
              className={`${styles.iconBtn} ${styles.dangerBtn}`}
              title="Delete the selected frames (their files go to the trash)"
              disabled={!folder || targetIds().length === 0}
              onClick={() => requestDelete(targetIds())}
            >
              −
            </button>
          </div>
        </div>

        {!folder && (
          <div className={styles.empty}>
            Choose a folder. Each frame is saved there as its own file; an empty
            folder starts with the current document as frame 1.
          </div>
        )}
        {folder && frames.length === 0 && <div className={styles.empty}>No frames</div>}

        {folder && frames.length > 0 && (
          <>
            <div className={styles.row}>
              <span className={styles.label}>
                Duration{selectedFrameIds.length > 1 ? ` (${selectedFrameIds.length} frames)` : ""}
              </span>
              <Field
                value={selectionDuration}
                min={1}
                max={60}
                step={1}
                unit="fr"
                onChange={(v) => commands.setDuration(targetIds(), v)}
              />
            </div>
            <div
              className={styles.frameList}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Delete" || e.key === "Backspace") {
                  e.preventDefault();
                  e.stopPropagation();
                  requestDelete(targetIds());
                }
              }}
              onDragOver={(e) => {
                if (dragIdsRef.current) e.preventDefault();
              }}
              onDrop={onDrop}
            >
              {frames.map((frame, i) => (
                <div
                  key={frame.id}
                  className={[
                    styles.frame,
                    selected.has(frame.id) ? styles.frameSelected : "",
                    frame.id === currentFrameId ? styles.frameCurrent : "",
                    dropIndex === i ? styles.dropBefore : "",
                    dropIndex === i + 1 && i === frames.length - 1 ? styles.dropAfter : "",
                  ].join(" ")}
                  draggable
                  onDragStart={(e) => onDragStart(e, frame)}
                  onDragOver={(e) => onDragOver(e, i)}
                  onDragEnd={onDragEnd}
                  onClick={(e) => onFrameClick(e, frame, i)}
                  title={frame.file}
                >
                  <span className={styles.frameNumber}>{i + 1}</span>
                  <FrameThumb path={cellFramePath(folder, frame)} />
                  <span className={styles.frameName}>{frame.file}</span>
                  <input
                    className={styles.durationInput}
                    type="number"
                    min={1}
                    max={600}
                    value={frame.duration}
                    title="Duration (ticks at the animation FPS)"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!Number.isFinite(v)) return;
                      // A selected row edits the whole selection.
                      commands.setDuration(
                        selected.has(frame.id) ? selectedFrameIds : [frame.id],
                        v,
                      );
                    }}
                  />
                  <button
                    className={styles.removeBtn}
                    title="Remove this frame (its file goes to the trash)"
                    aria-label={`Remove ${frame.file}`}
                    draggable={false}
                    onClick={(e) => {
                      e.stopPropagation();
                      requestDelete([frame.id]);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <ModalDialog
        open={confirmOpen !== null}
        title="Open Cell Folder"
        width={380}
        onClose={() => setConfirmOpen(null)}
      >
        <div className={styles.dialogText}>
          Opening this folder replaces the current document with its first
          frame. Unsaved changes to the current document will be lost.
        </div>
        <div className={styles.dialogButtons}>
          <DialogButton onClick={() => setConfirmOpen(null)}>Cancel</DialogButton>
          <DialogButton
            primary
            onClick={() => {
              const path = confirmOpen;
              setConfirmOpen(null);
              if (path) void open(path, true);
            }}
          >
            Open Folder
          </DialogButton>
        </div>
      </ModalDialog>

      <ModalDialog
        open={deleteIds !== null}
        title="Delete Frames"
        width={380}
        onClose={() => setDeleteIds(null)}
      >
        <div className={styles.dialogText}>
          Delete {deleteIds?.length === 1 ? "this frame" : `${deleteIds?.length ?? 0} frames`}?
          The frame files are moved to the trash.
        </div>
        <div className={styles.dialogButtons}>
          <DialogButton onClick={() => setDeleteIds(null)}>Cancel</DialogButton>
          <DialogButton
            primary
            onClick={() => {
              const ids = deleteIds ?? [];
              setDeleteIds(null);
              void commands.deleteFrames(ids);
            }}
          >
            Delete
          </DialogButton>
        </div>
      </ModalDialog>
    </>
  );
}
