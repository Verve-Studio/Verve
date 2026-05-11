
import { useEffect } from "react";
import { activeScope } from "@/core/store/scope";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UseKeyboardShortcutsOptions {
  handleUndo: () => void;
  handleRedo: () => void;
  handleCopy: () => void;
  handleCopyMerged?: () => void;
  handleCut: () => void;
  handlePaste: () => void;
  handlePasteInto?: () => void;
  handleDelete: () => void;
  handleZoomIn: () => void;
  handleZoomOut: () => void;
  handleFitToWindow: () => void;
  handleToggleGrid: () => void;
  handleKeyboardShortcuts?: () => void;
  handleFreeTransform?: () => void;
  handleInvertSelection?: () => void;
  handleSelectAll?: () => void;
  handleDeselect?: () => void;
  handleSelectAllLayers?: () => void;
  handleCloneStamp?: () => void;
  handleContentAwareDelete?: () => void;
  handleFindLayers?: () => void;
  handleCycleLasso?: () => void;
  handleCycleWand?: () => void;
  handleNew?: () => void;
  handleOpen?: () => void;
  handleSave?: () => void;
  handleSaveAs?: () => void;
  handleExport?: () => void;
  handleNewLayer?: () => void;
  handleGroupLayers?: () => void;
  handleUngroupLayers?: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useKeyboardShortcuts({
  handleUndo,
  handleRedo,
  handleCopy,
  handleCopyMerged,
  handleCut,
  handlePaste,
  handlePasteInto,
  handleDelete,
  handleZoomIn,
  handleZoomOut,
  handleFitToWindow,
  handleToggleGrid,
  handleKeyboardShortcuts,
  handleFreeTransform,
  handleInvertSelection,
  handleSelectAll,
  handleDeselect,
  handleSelectAllLayers,
  handleCloneStamp,
  handleContentAwareDelete,
  handleFindLayers,
  handleCycleLasso,
  handleCycleWand,
  handleNew,
  handleOpen,
  handleSave,
  handleSaveAs,
  handleExport,
  handleNewLayer,
  handleGroupLayers,
  handleUngroupLayers,
}: UseKeyboardShortcutsOptions): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.key === "Escape") {
        activeScope().selection.clear();
        activeScope().crop.clear();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && e.shiftKey) {
        e.preventDefault();
        handleContentAwareDelete?.();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        handleDelete();
        return;
      }
      if (e.key === "?" && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        handleKeyboardShortcuts?.();
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (e.key === "s" || e.key === "S") {
          e.preventDefault();
          handleCloneStamp?.();
          return;
        }
        if (e.key === "l" || e.key === "L") {
          e.preventDefault();
          handleCycleLasso?.();
          return;
        }
        if (e.key === "w" || e.key === "W") {
          e.preventDefault();
          handleCycleWand?.();
          return;
        }
      }
      if (!e.ctrlKey && !e.metaKey) return;
      // Ctrl-modified shortcuts. Note `e.key` is lowercase when Shift isn't held,
      // uppercase when it is — match both forms with toLowerCase() so Ctrl+Shift+S
      // dispatches as expected on all keyboard layouts.
      const k = e.key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        handleUndo();
      } else if (k === "y") {
        e.preventDefault();
        handleRedo();
      } else if (k === "c" && e.shiftKey) {
        e.preventDefault();
        handleCopyMerged?.();
      } else if (k === "c") {
        e.preventDefault();
        handleCopy();
      } else if (k === "x") {
        e.preventDefault();
        handleCut();
      } else if (k === "v" && e.shiftKey) {
        e.preventDefault();
        handlePasteInto?.();
      } else if (k === "v") {
        e.preventDefault();
        handlePaste();
      } else if (k === "=" || k === "+") {
        e.preventDefault();
        handleZoomIn();
      } else if (k === "-") {
        e.preventDefault();
        handleZoomOut();
      } else if (k === "0") {
        e.preventDefault();
        handleFitToWindow();
      } else if (k === "'" || k === '"') {
        e.preventDefault();
        handleToggleGrid();
      } else if (k === "t") {
        e.preventDefault();
        handleFreeTransform?.();
      } else if (k === "i" && e.shiftKey) {
        e.preventDefault();
        handleInvertSelection?.();
      } else if (k === "a" && !e.altKey) {
        e.preventDefault();
        handleSelectAll?.();
      } else if (k === "d" && !e.altKey) {
        e.preventDefault();
        handleDeselect?.();
      } else if (k === "a" && e.altKey) {
        e.preventDefault();
        handleSelectAllLayers?.();
      } else if (k === "f" && e.altKey && e.shiftKey) {
        e.preventDefault();
        handleFindLayers?.();
      }
      // File menu
      else if (k === "n" && e.shiftKey) {
        e.preventDefault();
        handleNewLayer?.();
      } else if (k === "n") {
        e.preventDefault();
        handleNew?.();
      } else if (k === "o") {
        e.preventDefault();
        handleOpen?.();
      } else if (k === "s" && e.shiftKey) {
        e.preventDefault();
        handleSaveAs?.();
      } else if (k === "s") {
        e.preventDefault();
        handleSave?.();
      } else if (k === "e") {
        e.preventDefault();
        handleExport?.();
      }
      // Layer menu — Ctrl+G group, Ctrl+Shift+G ungroup
      else if (k === "g" && e.shiftKey) {
        e.preventDefault();
        handleUngroupLayers?.();
      } else if (k === "g") {
        e.preventDefault();
        handleGroupLayers?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    handleUndo,
    handleRedo,
    handleCopy,
    handleCopyMerged,
    handleCut,
    handlePaste,
    handlePasteInto,
    handleDelete,
    handleZoomIn,
    handleZoomOut,
    handleFitToWindow,
    handleToggleGrid,
    handleKeyboardShortcuts,
    handleFreeTransform,
    handleInvertSelection,
    handleSelectAll,
    handleDeselect,
    handleSelectAllLayers,
    handleCloneStamp,
    handleContentAwareDelete,
    handleFindLayers,
    handleCycleLasso,
    handleCycleWand,
    handleNew,
    handleOpen,
    handleSave,
    handleSaveAs,
    handleExport,
    handleNewLayer,
    handleGroupLayers,
    handleUngroupLayers,
  ]);
}
