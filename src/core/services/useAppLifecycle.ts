import { useEffect, useRef, useState } from "react";
import type { Dispatch } from "react";
import type { AppAction } from "@/core/store/AppContext";
import { brushStore } from "@/core/store/brushStore";
import { pixelBrushStore } from "@/core/store/pixelBrushStore";
import { cloneStampStore } from "@/core/store/cloneStampStore";
import { selectionStore } from "@/core/store/selectionStore";
import { MemoryLimitError } from "@/core/store/memoryStore";
import { notificationStore } from "@/core/store/notificationStore";
import { makeDefaultBrush } from "@/types";

/** Initialise pixel brush + paint brush stores on mount, and pick a default
 *  active brush if none is set. Mount-only — `activeBrushId` is read once
 *  from a ref to avoid re-running. */
export function useBrushBootstrap(
  activeBrushId: string | null,
  dispatch: Dispatch<AppAction>,
): void {
  const activeBrushIdRef = useRef(activeBrushId);
  activeBrushIdRef.current = activeBrushId;
  useEffect(() => {
    void pixelBrushStore.init();
  }, []);
  useEffect(() => {
    void (async () => {
      await brushStore.init();
      if (brushStore.getUserBrushes().length === 0) {
        await brushStore.addUserBrush(
          makeDefaultBrush(crypto.randomUUID(), "Default Round"),
        );
      }
      if (activeBrushIdRef.current === null) {
        const first = brushStore.getUserBrushes()[0];
        if (first) {
          dispatch({ type: "SET_ACTIVE_BRUSH", payload: first.id });
        }
      }
    })();
  }, [dispatch]);
}

/** Subscribes to clone-stamp source-deletion events and surfaces a
 *  transient warning. Returns the current notification message (or null). */
export function useCloneStampNotification(): string | null {
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    cloneStampStore.onSourceDeleted = () => {
      setMessage(
        "⚠ Source layer was deleted — Alt+click to set a new source",
      );
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setMessage(null), 4000);
    };
    return () => {
      cloneStampStore.onSourceDeleted = null;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);
  return message;
}

/** Memory-cap violations can bubble up from anywhere (layer creation, brush
 *  growLayerToFit, history restore, GPU texture allocation, etc). Listen at
 *  the window level so we never miss one regardless of which call site
 *  threw it. */
export function useMemoryErrorHandler(): void {
  useEffect(() => {
    const onError = (e: ErrorEvent): void => {
      if (e.error instanceof MemoryLimitError) {
        notificationStore.error(e.error.message);
        e.preventDefault();
      }
    };
    const onRejection = (e: PromiseRejectionEvent): void => {
      if (e.reason instanceof MemoryLimitError) {
        notificationStore.error(e.reason.message);
        e.preventDefault();
      }
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
}

/** Mirror selectionStore.hasSelection() into React state so menu items can
 *  reactively enable/disable. */
export function useSelectionFlag(): boolean {
  const [hasSelection, setHasSelection] = useState(false);
  useEffect(() => {
    const update = (): void => setHasSelection(selectionStore.hasSelection());
    selectionStore.subscribe(update);
    return () => selectionStore.unsubscribe(update);
  }, []);
  return hasSelection;
}

/** Loads the OS recent-files list and exposes a `clear()` helper. */
export function useRecentFiles(): {
  recentFiles: string[];
  setRecentFiles: Dispatch<React.SetStateAction<string[]>>;
  clearRecentFiles: () => Promise<void>;
} {
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  useEffect(() => {
    window.api.getRecentFiles().then(setRecentFiles);
  }, []);
  const clearRecentFiles = async (): Promise<void> => {
    await window.api.clearRecentFiles();
    setRecentFiles([]);
  };
  return { recentFiles, setRecentFiles, clearRecentFiles };
}

/** Opens any startup file passed via CLI arg or macOS open-with, and
 *  subscribes to subsequent open-file events from the main process. */
export function useStartupFile(
  handleOpenPath: (path: string) => Promise<void> | void,
): void {
  const handleOpenPathRef = useRef(handleOpenPath);
  handleOpenPathRef.current = handleOpenPath;
  useEffect(() => {
    void window.api.getStartupFile().then((path) => {
      if (path) void handleOpenPathRef.current(path);
    });
    return window.api.onOpenFile((path) => {
      void handleOpenPathRef.current(path);
    });
  }, []);
}
