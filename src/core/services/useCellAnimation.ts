import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AppAction } from "@/core/store/AppContext";
import { INITIAL_CELL_ANIMATION } from "@/core/store/AppContext";
import type { AppState, CellAnimationState, CellFileType, CellFrame, LayerState } from "@/types";
import type { TabRecord } from "@/core/store/tabTypes";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import type { DocumentFileCommands } from "@/core/services/useFileOps";
import type { ExportSettings } from "@/core/io/exportSettings";
import { DEFAULT_EXPORT_SETTINGS } from "@/core/io/exportSettings";
import {
  createLayerDataBundle,
  type LayerDataBundle,
} from "@/core/store/layerPayload";
import type { DecodedDocument } from "@/core/io/documentDecode";
import {
  baseName,
  cellFramePath,
  cellPreviewPath,
  cellTypeOf,
  newCellFrameId,
  nextCellFileName,
  readCellFolder,
  serializeCellManifest,
} from "@/core/io/cellAnimationFiles";
import {
  buildCellPreview,
  compositeToRgba8,
  decodeCellFile,
  readCellPreview,
  rgbaToBitmap,
  writeCellPreview,
} from "@/core/io/cellPreview";
import { cellPreviewStore } from "@/core/store/cellPreviewStore";
import { canvasReadyStore } from "@/ux/main/Canvas/canvasReadyStore";
import { activeScope } from "@/core/store/scope";
import { notificationStore } from "@/core/store/notificationStore";
import { statusMessageStore } from "@/core/store/statusMessageStore";
import { showOperationError } from "@/utils/userFeedback";

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * Cell animation commands. The document on the canvas is the current frame:
 * moving to another frame saves it (when changed) and loads the other file
 * into the same tab. Commands report their own errors.
 */
export interface CellAnimationCommands {
  /** Pick a folder in a dialog; null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Open a cell folder. Resolves to "confirm" (doing nothing) when that
   *  would discard unsaved changes to a document that isn't a cell; call
   *  again with `discardUnsaved` once the user agreed. */
  openFolder(
    folder: string,
    options?: { discardUnsaved?: boolean },
  ): Promise<"opened" | "confirm" | "failed">;
  setFileType(type: CellFileType): void;
  setFps(fps: number): void;
  setOnionSkin(patch: Partial<CellAnimationState["onionSkin"]>): void;
  setBackground(patch: Partial<CellAnimationState["background"]>): void;
  browseBackground(): Promise<void>;
  /** Select frames in the panel (no load). */
  selectFrames(ids: string[]): void;
  /** Make `id` the frame on the canvas. */
  goToFrame(id: string): Promise<void>;
  /** Write the frame on the canvas to its file. */
  saveCurrentFrame(): Promise<void>;
  /** Add a frame after the current one: an empty one, or a copy of it. */
  addFrame(mode: "blank" | "duplicate"): Promise<void>;
  /** Delete frames (their files go to the trash). */
  deleteFrames(ids: string[]): Promise<void>;
  /** Move frames (kept in their order) to before the frame now at `beforeIndex`
   *  (`frames.length` = the end). */
  moveFrames(ids: string[], beforeIndex: number): void;
  setDuration(ids: string[], duration: number): void;
  /** Make sure the frame on the canvas has an up-to-date preview (playback). */
  refreshCurrentPreview(): Promise<void>;
}

interface UseCellAnimationOptions {
  getState: () => AppState;
  dispatch: Dispatch<AppAction>;
  canvasHandleRef: { readonly current: CanvasHandle | null };
  tabs: TabRecord[];
  setTabs: Dispatch<SetStateAction<TabRecord[]>>;
  activeTabIdRef: MutableRefObject<string>;
  setPendingLayerData: Dispatch<SetStateAction<LayerDataBundle | null>>;
  files: DocumentFileCommands;
  exportDocument: (settings: ExportSettings) => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const READY_TIMEOUT_MS = 60_000;

/** Resolve once the canvas mount `${tabId}-${canvasKey}` is ready. */
function waitForCanvasReady(tabId: string, canvasKey: number): Promise<void> {
  const key = `${tabId}-${canvasKey}`;
  if (canvasReadyStore.readyKey === key) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the frame to load."));
    }, READY_TIMEOUT_MS);
    const unsubscribe = canvasReadyStore.subscribe(() => {
      if (canvasReadyStore.readyKey !== key) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/** One transparent layer the size of the canvas. */
function blankDocument(
  width: number,
  height: number,
  pixelFormat: AppState["pixelFormat"],
): DecodedDocument {
  const layerData = createLayerDataBundle();
  const id = "layer-0";
  const n = width * height;
  layerData.layers.set(id, {
    format: pixelFormat,
    data:
      pixelFormat === "rgba32f"
        ? new Float32Array(n * 4)
        : pixelFormat === "indexed8"
          ? new Uint8Array(n).fill(255)
          : new Uint8Array(n * 4),
  });
  const layers: LayerState[] = [
    { id, name: "Layer 1", visible: true, opacity: 1, locked: false, blendMode: "normal" },
  ];
  return {
    width,
    height,
    pixelFormat,
    backgroundFill: "transparent",
    layers,
    activeLayerId: id,
    layerData,
  };
}

function frameTitle(folder: string, frame: CellFrame): string {
  return `${baseName(folder)} › ${frame.file}`;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCellAnimation(options: UseCellAnimationOptions): CellAnimationCommands {
  // Commands are stable; they read the latest render's inputs from here.
  const depsRef = useRef(options);
  depsRef.current = options;

  /** File work runs one operation at a time (a frame switch must not
   *  interleave with a save or another switch). */
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  /** Bumped when the folder changes; stale preview builds stop. */
  const previewRunRef = useRef(0);
  const manifestQueueRef = useRef<Promise<void>>(Promise.resolve());

  const exclusive = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = queueRef.current.then(fn, fn);
    queueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const cells = useCallback(
    (): CellAnimationState => depsRef.current.getState().cellAnimation,
    [],
  );

  const setCells = useCallback(
    (patch: Partial<CellAnimationState>): void =>
      depsRef.current.dispatch({ type: "SET_CELL_ANIMATION", payload: patch }),
    [],
  );

  /** Write the folder's manifest from the current state. Writes are
   *  debounced (sliders change settings continuously) and queued, so an
   *  older state never lands last. */
  const manifestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingManifestsRef = useRef(new Map<string, string>());
  const flushManifests = useCallback((): void => {
    manifestTimerRef.current = null;
    const pending = [...pendingManifestsRef.current];
    pendingManifestsRef.current.clear();
    for (const [folder, text] of pending) {
      manifestQueueRef.current = manifestQueueRef.current
        .then(() => window.api.writeCellManifest(folder, text))
        .catch((err: unknown) => {
          showOperationError("The cell animation's frame list couldn't be saved.", err);
        });
    }
  }, []);
  const persistManifest = useCallback((): void => {
    const s = cells();
    if (!s.folder) return;
    pendingManifestsRef.current.set(s.folder, serializeCellManifest(s));
    if (manifestTimerRef.current !== null) clearTimeout(manifestTimerRef.current);
    manifestTimerRef.current = setTimeout(flushManifests, 300);
  }, [cells, flushManifests]);
  // Write anything pending before the app unmounts (window close).
  useEffect(() => () => {
    if (manifestTimerRef.current !== null) {
      clearTimeout(manifestTimerRef.current);
      flushManifests();
    }
  }, [flushManifests]);

  const activeTab = useCallback((): TabRecord | undefined => {
    const d = depsRef.current;
    return d.tabs.find((t) => t.id === d.activeTabIdRef.current);
  }, []);

  const currentFrame = useCallback((): CellFrame | null => {
    const s = cells();
    return s.frames.find((f) => f.id === s.currentFrameId) ?? null;
  }, [cells]);

  /** Flatten the canvas into the preview of `frame` (memory + PNG). */
  const capturePreview = useCallback(
    async (folder: string, frame: CellFrame): Promise<void> => {
      const handle = depsRef.current.canvasHandleRef.current;
      if (!handle) throw new Error("The canvas isn't ready yet.");
      const flat = await handle.rasterizeComposite("export");
      const rgba = compositeToRgba8(flat.data);
      cellPreviewStore.set(
        cellFramePath(folder, frame),
        await rgbaToBitmap(rgba, flat.width, flat.height),
      );
      await writeCellPreview(folder, frame.file, rgba, flat.width, flat.height);
    },
    [],
  );

  /** Write the canvas document to `frame`'s file and refresh its preview. */
  const writeFrame = useCallback(
    async (folder: string, frame: CellFrame): Promise<void> => {
      const d = depsRef.current;
      const path = cellFramePath(folder, frame);
      const type = cellTypeOf(frame.file);
      if (type === "verve") {
        await d.files.writeVerve(path);
      } else if (type === "exr") {
        if (d.getState().pixelFormat !== "rgba32f") {
          throw new Error(
            "EXR cells need a 32-bit float document. Convert the document (Image → Mode → RGBA 32-bit) or use .verve cells.",
          );
        }
        await d.exportDocument({
          ...DEFAULT_EXPORT_SETTINGS,
          filePath: path,
          format: "exr",
          exrCompression: 1,
          exrHalfFloat: false,
          layerMode: "multilayer",
        });
      } else {
        throw new Error(`"${frame.file}" isn't a .verve or .exr file.`);
      }
      await capturePreview(folder, frame);
    },
    [capturePreview],
  );

  /** Save the current frame when it has unsaved changes. */
  const saveCurrentIfDirty = useCallback(async (): Promise<void> => {
    const s = cells();
    const frame = currentFrame();
    if (!s.folder || !frame || !activeScope().history.isDirty()) return;
    await writeFrame(s.folder, frame);
    activeScope().history.markSaved();
  }, [cells, currentFrame, writeFrame]);

  /** Put `doc` on the canvas as `frame` (remount; zoom and scroll kept when
   *  the size is unchanged). Resolves once the canvas is ready. */
  const showDocument = useCallback(
    async (doc: DecodedDocument, folder: string, frame: CellFrame): Promise<void> => {
      const d = depsRef.current;
      const tab = activeTab();
      if (!tab) throw new Error("No document is open.");
      const state = d.getState();
      const handle = d.canvasHandleRef.current;
      const sameSize = doc.width === state.canvas.width && doc.height === state.canvas.height;
      canvasReadyStore.keepViewOnNextReady(sameSize ? (handle?.getViewScroll() ?? null) : null);

      // The loaded file becomes this tab's document, with a fresh history.
      activeScope().history.clear({ recaptureSnapshot: false });
      const canvasKey = tab.canvasKey + 1;
      const path = cellFramePath(folder, frame);
      d.setPendingLayerData(doc.layerData);
      d.setTabs((prev) =>
        prev.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                canvasKey,
                title: frameTitle(folder, frame),
                filePath: path,
                pixelFormat: doc.pixelFormat,
                savedLayerData: null,
                snapshot: {
                  ...t.snapshot,
                  canvasWidth: doc.width,
                  canvasHeight: doc.height,
                  pixelFormat: doc.pixelFormat,
                },
              }
            : t,
        ),
      );
      d.dispatch({
        type: "RESTORE_TAB",
        payload: {
          width: doc.width,
          height: doc.height,
          backgroundFill: doc.backgroundFill,
          layers: doc.layers,
          activeLayerId: doc.activeLayerId,
          zoom: state.canvas.zoom,
          tiledMode: false,
          showTileGrid: false,
          pixelFormat: doc.pixelFormat,
          // Frames keep their own palette (indexed8 indices depend on it).
          swatches: doc.swatches ?? state.swatches,
          swatchGroups: doc.swatchGroups ?? state.swatchGroups,
          iccProfile: doc.iccProfile,
        },
      });
      setCells({ currentFrameId: frame.id });
      await waitForCanvasReady(tab.id, canvasKey);
      // The ready capture recorded the loaded file: that is the saved state.
      activeScope().history.markSaved();
    },
    [activeTab, setCells],
  );

  /** Load `frame`'s file onto the canvas. */
  const loadFrame = useCallback(
    async (folder: string, frame: CellFrame): Promise<void> => {
      const doc = await decodeCellFile(cellFramePath(folder, frame));
      await showDocument(doc, folder, frame);
      if (!cellPreviewStore.has(cellFramePath(folder, frame))) {
        await capturePreview(folder, frame);
      }
    },
    [showDocument, capturePreview],
  );

  /** Build missing previews in the background, nearest the current frame
   *  first (onion skin needs those). */
  const ensurePreviews = useCallback((): void => {
    const run = ++previewRunRef.current;
    const s = cells();
    const folder = s.folder;
    if (!folder) return;
    const cur = Math.max(0, s.frames.findIndex((f) => f.id === s.currentFrameId));
    const pending = s.frames
      .map((f, i) => ({ f, d: Math.abs(i - cur) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.f)
      .filter((f) => !cellPreviewStore.has(cellFramePath(folder, f)));
    void (async () => {
      const failed: string[] = [];
      let firstError: unknown = null;
      for (const frame of pending) {
        if (run !== previewRunRef.current) return;
        const path = cellFramePath(folder, frame);
        if (cellPreviewStore.has(path)) continue;
        try {
          const bitmap =
            (await readCellPreview(folder, frame.file)) ??
            (await buildCellPreview(folder, frame.file));
          if (run !== previewRunRef.current) {
            bitmap.close();
            return;
          }
          if (!cellPreviewStore.has(path)) cellPreviewStore.set(path, bitmap);
          else bitmap.close();
        } catch (err) {
          failed.push(frame.file);
          firstError ??= err;
        }
      }
      if (failed.length > 0) {
        const reason = firstError instanceof Error ? firstError.message : String(firstError);
        notificationStore.error(
          `Couldn't build previews for ${failed.length} frame${failed.length === 1 ? "" : "s"} (${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ", …" : ""}): ${reason}`,
        );
      }
    })();
  }, [cells]);

  // ── Commands ────────────────────────────────────────────────────────────────

  const openFolderNow = useCallback(
    async (
      folder: string,
      discardUnsaved: boolean,
    ): Promise<"opened" | "confirm"> => {
      const before = cells();
      const contents = await readCellFolder(folder, before);
      const m = contents.manifest;
      const settings: Partial<CellAnimationState> = {
        fileType: m?.fileType ?? before.fileType,
        fps: m?.fps ?? before.fps,
        onionSkin: m?.onionSkin ?? before.onionSkin,
        background: m?.background ?? INITIAL_CELL_ANIMATION.background,
      };

      if (contents.frames.length === 0) {
        // An empty folder: the document on the canvas becomes frame 1.
        // (If it was a frame of another folder, that one is saved first.)
        await saveCurrentIfDirty();
        const type = settings.fileType!;
        const frame: CellFrame = {
          id: newCellFrameId(),
          file: nextCellFileName([], type),
          duration: 1,
        };
        await writeFrame(folder, frame);
        activeScope().history.markSaved();
        setCells({ ...settings, folder, frames: [frame], currentFrameId: frame.id, selectedFrameIds: [frame.id] });
        const path = cellFramePath(folder, frame);
        const tabId = depsRef.current.activeTabIdRef.current;
        depsRef.current.setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId ? { ...t, title: frameTitle(folder, frame), filePath: path } : t,
          ),
        );
        persistManifest();
        return "opened";
      }

      // Opening replaces the canvas document with frame 1.
      const isCell = before.folder !== null && before.currentFrameId !== null;
      if (isCell) {
        await saveCurrentIfDirty();
      } else if (!discardUnsaved && activeScope().history.isDirty()) {
        return "confirm";
      }
      const first = contents.frames[0];
      setCells({ ...settings, folder, frames: contents.frames, selectedFrameIds: [first.id] });
      await loadFrame(folder, first);
      persistManifest();
      ensurePreviews();
      return "opened";
    },
    [cells, saveCurrentIfDirty, writeFrame, setCells, persistManifest, loadFrame, ensurePreviews],
  );

  const openFolder = useCallback<CellAnimationCommands["openFolder"]>(
    (folder, opts) =>
      exclusive(async () => {
        try {
          return await openFolderNow(folder, opts?.discardUnsaved === true);
        } catch (err) {
          showOperationError(`Couldn't open the cell folder "${folder}".`, err);
          return "failed" as const;
        }
      }),
    [exclusive, openFolderNow],
  );

  const goToFrame = useCallback(
    (id: string): Promise<void> =>
      exclusive(async () => {
        const s = cells();
        const target = s.frames.find((f) => f.id === id);
        if (!s.folder || !target) return;
        if (s.currentFrameId === id) return;
        try {
          await saveCurrentIfDirty();
          await loadFrame(s.folder, target);
          ensurePreviews();
        } catch (err) {
          showOperationError(`Couldn't open frame ${target.file}.`, err);
        }
      }),
    [exclusive, cells, saveCurrentIfDirty, loadFrame, ensurePreviews],
  );

  const saveCurrentFrame = useCallback(
    (): Promise<void> =>
      exclusive(async () => {
        const s = cells();
        const frame = currentFrame();
        if (!s.folder || !frame) return;
        try {
          await writeFrame(s.folder, frame);
          activeScope().history.markSaved();
          statusMessageStore.show(`Saved ${frame.file}`);
        } catch (err) {
          showOperationError(`Couldn't save frame ${frame.file}.`, err);
        }
      }),
    [exclusive, cells, currentFrame, writeFrame],
  );

  const addFrame = useCallback(
    (mode: "blank" | "duplicate"): Promise<void> =>
      exclusive(async () => {
        const s = cells();
        const folder = s.folder;
        if (!folder) return;
        try {
          await saveCurrentIfDirty();
          const frame: CellFrame = {
            id: newCellFrameId(),
            file: nextCellFileName(
              s.frames.map((f) => f.file),
              s.fileType,
            ),
            duration: currentFrame()?.duration ?? 1,
          };
          const at = s.frames.findIndex((f) => f.id === s.currentFrameId) + 1 || s.frames.length;
          const frames = [...s.frames.slice(0, at), frame, ...s.frames.slice(at)];
          if (mode === "duplicate") {
            // The canvas already holds the copy: write it as the new file.
            await writeFrame(folder, frame);
            activeScope().history.markSaved();
            setCells({ frames, currentFrameId: frame.id, selectedFrameIds: [frame.id] });
            const tabId = depsRef.current.activeTabIdRef.current;
            const path = cellFramePath(folder, frame);
            depsRef.current.setTabs((prev) =>
              prev.map((t) =>
                t.id === tabId ? { ...t, title: frameTitle(folder, frame), filePath: path } : t,
              ),
            );
          } else {
            const st = depsRef.current.getState();
            // EXR cells are float documents.
            const fmt = s.fileType === "exr" ? "rgba32f" : st.pixelFormat;
            setCells({ frames, selectedFrameIds: [frame.id] });
            await showDocument(blankDocument(st.canvas.width, st.canvas.height, fmt), folder, frame);
            await writeFrame(folder, frame);
            activeScope().history.markSaved();
          }
          persistManifest();
        } catch (err) {
          showOperationError("Couldn't add the frame.", err);
          // A frame whose file was never written isn't kept.
          const now = cells();
          const missing = now.frames.filter((f) => !s.frames.some((o) => o.id === f.id));
          for (const f of missing) {
            const exists = await window.api.statPath(cellFramePath(folder, f)).catch(() => null);
            if (!exists?.exists) {
              setCells({
                frames: cells().frames.filter((x) => x.id !== f.id),
                currentFrameId: cells().currentFrameId === f.id ? null : cells().currentFrameId,
              });
            }
          }
          persistManifest();
        }
      }),
    [exclusive, cells, currentFrame, saveCurrentIfDirty, writeFrame, setCells, showDocument, persistManifest],
  );

  const deleteFrames = useCallback(
    (ids: string[]): Promise<void> =>
      exclusive(async () => {
        const s = cells();
        const folder = s.folder;
        if (!folder || ids.length === 0) return;
        const doomed = new Set(ids);
        const remaining = s.frames.filter((f) => !doomed.has(f.id));
        const curIdx = s.frames.findIndex((f) => f.id === s.currentFrameId);
        const currentDeleted = s.currentFrameId !== null && doomed.has(s.currentFrameId);
        // The frame to show instead: the next surviving one, else the previous.
        const next = currentDeleted
          ? (s.frames.slice(curIdx + 1).find((f) => !doomed.has(f.id)) ??
            [...s.frames.slice(0, curIdx)].reverse().find((f) => !doomed.has(f.id)) ??
            null)
          : null;
        const errors: unknown[] = [];
        for (const f of s.frames) {
          if (!doomed.has(f.id)) continue;
          const path = cellFramePath(folder, f);
          try {
            await window.api.trashCellFile(path);
            await window.api.trashCellFile(cellPreviewPath(folder, f.file));
            cellPreviewStore.delete(path);
          } catch (err) {
            errors.push(err);
          }
        }
        setCells({
          frames: remaining,
          selectedFrameIds: next ? [next.id] : [],
          currentFrameId: currentDeleted ? null : s.currentFrameId,
        });
        persistManifest();
        if (errors.length > 0) {
          showOperationError("Some frame files couldn't be moved to the trash.", errors[0]);
        }
        if (currentDeleted) {
          if (next) {
            try {
              // The deleted frame's edits are dropped, not saved.
              await loadFrame(folder, next);
            } catch (err) {
              showOperationError(`Couldn't open frame ${next.file}.`, err);
            }
          } else {
            // No frames left: the canvas keeps the document, detached.
            const tabId = depsRef.current.activeTabIdRef.current;
            depsRef.current.setTabs((prev) =>
              prev.map((t) => (t.id === tabId ? { ...t, filePath: null, title: baseName(folder) } : t)),
            );
          }
        }
      }),
    [exclusive, cells, setCells, persistManifest, loadFrame],
  );

  const moveFrames = useCallback(
    (ids: string[], beforeIndex: number): void => {
      const s = cells();
      const moving = new Set(ids);
      const moved = s.frames.filter((f) => moving.has(f.id));
      if (moved.length === 0) return;
      // Insert before the first non-moved frame at or after `beforeIndex`.
      const anchor = s.frames.slice(beforeIndex).find((f) => !moving.has(f.id)) ?? null;
      const rest = s.frames.filter((f) => !moving.has(f.id));
      const at = anchor ? rest.indexOf(anchor) : rest.length;
      const frames = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
      if (frames.every((f, i) => f === s.frames[i])) return;
      setCells({ frames });
      persistManifest();
    },
    [cells, setCells, persistManifest],
  );

  const setDuration = useCallback(
    (ids: string[], duration: number): void => {
      const d = Math.max(1, Math.min(600, Math.round(duration)));
      const set = new Set(ids);
      const s = cells();
      setCells({ frames: s.frames.map((f) => (set.has(f.id) ? { ...f, duration: d } : f)) });
      persistManifest();
    },
    [cells, setCells, persistManifest],
  );

  const commands = useMemo(
    (): CellAnimationCommands => ({
      pickFolder: () => window.api.openDirectoryDialog(),
      openFolder,
      setFileType: (fileType) => {
        setCells({ fileType });
        persistManifest();
      },
      setFps: (fps) => {
        setCells({ fps: Math.max(1, Math.min(120, Math.round(fps))) });
        persistManifest();
      },
      setOnionSkin: (patch) => {
        setCells({ onionSkin: { ...cells().onionSkin, ...patch } });
        persistManifest();
      },
      setBackground: (patch) => {
        setCells({ background: { ...cells().background, ...patch } });
        persistManifest();
      },
      browseBackground: async () => {
        const path = await window.api.openFile();
        if (!path) return;
        setCells({ background: { ...cells().background, path, visible: true } });
        persistManifest();
      },
      selectFrames: (ids) => setCells({ selectedFrameIds: ids }),
      goToFrame,
      saveCurrentFrame,
      addFrame,
      deleteFrames,
      moveFrames,
      setDuration,
      refreshCurrentPreview: () =>
        exclusive(async () => {
          const s = cells();
          const frame = currentFrame();
          if (!s.folder || !frame) return;
          const path = cellFramePath(s.folder, frame);
          if (cellPreviewStore.has(path) && !activeScope().history.isDirty()) return;
          try {
            // Unsaved edits are previewed without writing the frame file.
            const handle = depsRef.current.canvasHandleRef.current;
            if (!handle) return;
            const flat = await handle.rasterizeComposite("export");
            cellPreviewStore.set(
              path,
              await rgbaToBitmap(compositeToRgba8(flat.data), flat.width, flat.height),
            );
          } catch (err) {
            showOperationError("Couldn't preview the current frame.", err);
          }
        }),
    }),
    [
      openFolder,
      setCells,
      persistManifest,
      cells,
      currentFrame,
      goToFrame,
      saveCurrentFrame,
      addFrame,
      deleteFrames,
      moveFrames,
      setDuration,
      exclusive,
    ],
  );

  return commands;
}
