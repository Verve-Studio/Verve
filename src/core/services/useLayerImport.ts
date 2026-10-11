import type { AppAction } from "@/core/store/AppContext";
import { notificationStore } from "@/core/store/notificationStore";
import { fileTitle } from "@/core/store/tabTypes";
import { EXT_TO_MIME, loadImageBytes } from "@/core/io/imageLoader";
import type { AppState, LayerState, LinkedLayerState } from "@/types";
import { isLinkedLayer } from "@/types";
import { newLayerId } from "@/utils/layerId";
import { convertF32ToRgba8, convertRgba8ToF32 } from "@/utils/pixelFormatConvert";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { matchPaletteIndices } from "@/wasm";
import type { Dispatch, MutableRefObject } from "react";
import { useCallback, useMemo } from "react";

interface UseLayerImportOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  dispatch: Dispatch<AppAction>;
  pendingLayerLabelRef: MutableRefObject<string | null>;
}

export interface ImportLayerOptions {
  name?: string;
  /** Insert directly above this layer (default: the active layer). */
  aboveId?: string | null;
  /** Top-left on the canvas (default: centred). */
  position?: { x: number; y: number };
}

/** Bring image files into the active document as layers. Throw on failure;
 *  return the new layer's id. */
export interface LayerImportCommands {
  /** Decode an image file and bake it into a new pixel layer, converted to
   *  the document's pixel format. */
  importImageAsLayer(path: string, options?: ImportLayerOptions): Promise<string>;
  /** New linked layer that keeps a live link to the file. */
  newLinkedLayer(path: string, options?: { name?: string }): Promise<string>;
  /** Re-read a linked layer's source file. */
  refreshLinkedLayer(id: string): void;
}

export interface UseLayerImportReturn {
  commands: LayerImportCommands;
  /** File → Open into Layer… */
  handleOpenAsLayer: () => Promise<void>;
  /** Layer → New Linked Layer… */
  handleNewLinkedLayer: () => Promise<void>;
  /** Layer → Refresh Linked Layer (active layer). */
  handleRefreshLinkedLayer: () => void;
}

async function decodeImageFile(path: string): Promise<Awaited<ReturnType<typeof loadImageBytes>>> {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (ext === ".psd" || ext === ".verve") {
    throw new Error(`${fileTitle(path)} is a layered document; open it as a document instead.`);
  }
  const mime = EXT_TO_MIME[ext];
  if (!mime) throw new Error(`${fileTitle(path)} isn't a supported image file.`);
  return loadImageBytes(await window.api.readFile(path), mime);
}

export function useLayerImport({
  canvasHandleRef,
  stateRef,
  dispatch,
  pendingLayerLabelRef,
}: UseLayerImportOptions): UseLayerImportReturn {
  const commands = useMemo(
    (): LayerImportCommands => ({
      async importImageAsLayer(path, { name, aboveId, position } = {}) {
        const handle = canvasHandleRef.current;
        if (!handle) throw new Error("The canvas isn't ready yet.");
        const loaded = await decodeImageFile(path);
        const { width, height } = loaded;
        const fmt = stateRef.current.pixelFormat;

        let pixels: Uint8Array | Float32Array;
        if (fmt === "rgba32f") {
          pixels = loaded.isHdr
            ? (loaded.data as Float32Array)
            : convertRgba8ToF32(loaded.data as Uint8Array);
        } else if (fmt === "indexed8") {
          const rgba = loaded.isHdr
            ? convertF32ToRgba8(loaded.data as Float32Array)
            : (loaded.data as Uint8Array);
          pixels = await matchPaletteIndices(rgba, stateRef.current.swatches, 255);
        } else {
          pixels = loaded.isHdr
            ? convertF32ToRgba8(loaded.data as Float32Array)
            : (loaded.data as Uint8Array);
        }

        // Centre the layer on the canvas by default; the rect may extend
        // off-edge when the source is larger than the document (matches
        // Photoshop's Place / drag-drop behaviour).
        const cw = stateRef.current.canvas.width;
        const ch = stateRef.current.canvas.height;
        const offsetX = Math.round(position?.x ?? (cw - width) / 2);
        const offsetY = Math.round(position?.y ?? (ch - height) / 2);

        const id = newLayerId("layer");
        const layerName = name || fileTitle(path);
        handle.prepareNewLayer(id, layerName, pixels, width, height, offsetX, offsetY, fmt);

        pendingLayerLabelRef.current = "Open into Layer";
        const newLayer: LayerState = {
          id,
          name: layerName,
          visible: true,
          opacity: 1,
          locked: false,
          blendMode: "normal",
          // rgba8→rgba32f decoded path is scene-linear; tag accordingly so
          // the renderer's IDT skips its sRGB decode (mirrors the linked-
          // layer fix in `useGpuLayerSync`).
          ...(fmt === "rgba32f" ? { colorSpace: "linear-srgb" as const } : {}),
        };
        const anchor = aboveId === undefined ? stateRef.current.activeLayerId : aboveId;
        if (anchor) {
          dispatch({ type: "INSERT_LAYER_ABOVE", payload: { layer: newLayer, aboveId: anchor } });
        } else {
          dispatch({ type: "ADD_LAYER", payload: newLayer });
        }
        dispatch({ type: "SET_ACTIVE_LAYER", payload: id });
        return id;
      },

      async newLinkedLayer(path, { name } = {}) {
        // Decode just enough to know the source dimensions for the state.
        // The actual rasterise (via `linkedLayerRasterizer`) runs in the sync
        // hook and decodes through its `path:refreshNonce` cache.
        const { width, height } = await decodeImageFile(path);
        const cw = stateRef.current.canvas.width;
        const ch = stateRef.current.canvas.height;
        const ls: LinkedLayerState = {
          id: newLayerId("linked"),
          name: name || fileTitle(path),
          visible: true,
          opacity: 1,
          locked: false,
          blendMode: "normal",
          type: "linked",
          source: {
            absolutePath: path,
            relativePath: null,
            sourceWidth: width,
            sourceHeight: height,
          },
          // Default centre = canvas centre, no scale/rotation.
          centerX: cw / 2,
          centerY: ch / 2,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          refreshNonce: 0,
        };
        pendingLayerLabelRef.current = "New Linked Layer";
        dispatch({ type: "ADD_LINKED_LAYER", payload: ls });
        return ls.id;
      },

      refreshLinkedLayer(id) {
        const layer = stateRef.current.layers.find((l) => l.id === id);
        if (!layer || !isLinkedLayer(layer)) throw new Error("The layer isn't a linked layer.");
        dispatch({ type: "REFRESH_LINKED_LAYER", payload: id });
      },
    }),
    [canvasHandleRef, stateRef, dispatch, pendingLayerLabelRef],
  );

  const handleOpenAsLayer = useCallback(async (): Promise<void> => {
    if (!canvasHandleRef.current) return;
    const path = await window.api.openFile();
    if (!path) return;
    try {
      await commands.importImageAsLayer(path);
    } catch (err) {
      notificationStore.error(`Failed to open image as layer: ${(err as Error).message}`);
    }
  }, [canvasHandleRef, commands]);

  const handleNewLinkedLayer = useCallback(async (): Promise<void> => {
    const path = await window.api.openFile();
    if (!path) return;
    try {
      await commands.newLinkedLayer(path);
      // Land in the Linked tool so transform handles appear immediately.
      dispatch({ type: "SET_TOOL", payload: "linked" });
    } catch (err) {
      notificationStore.error(`Failed to load linked source: ${(err as Error).message}`);
    }
  }, [commands, dispatch]);

  const handleRefreshLinkedLayer = useCallback((): void => {
    const id = stateRef.current.activeLayerId;
    const layer = id ? stateRef.current.layers.find((l) => l.id === id) : undefined;
    if (layer && isLinkedLayer(layer)) commands.refreshLinkedLayer(layer.id);
  }, [commands, stateRef]);

  return { commands, handleOpenAsLayer, handleNewLinkedLayer, handleRefreshLinkedLayer };
}
