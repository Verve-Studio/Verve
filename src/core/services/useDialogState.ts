import { useState } from "react";
import type { PixelFormat } from "@/types";

export function useDialogState() {
  const [showNewImageDialog, setShowNewImageDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showResizeDialog, setShowResizeDialog] = useState(false);
  const [showResizeCanvasDialog, setShowResizeCanvasDialog] = useState(false);
  const [showAboutDialog, setShowAboutDialog] = useState(false);
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false);
  const [showSystemInfoDialog, setShowSystemInfoDialog] = useState(false);
  const [showGeneratePaletteDialog, setShowGeneratePaletteDialog] =
    useState(false);
  const [showColorDitheringSetup, setShowColorDitheringSetup] = useState(false);
  const [
    showContentAwareFillOptionsDialog,
    setShowContentAwareFillOptionsDialog,
  ] = useState(false);
  const [contentAwareFillOptionsMode, setContentAwareFillOptionsMode] =
    useState<"fill" | "delete">("fill");
  const [pendingConversion, setPendingConversion] =
    useState<PixelFormat | null>(null);
  const [
    showImportSpritesheetFramesDialog,
    setShowImportSpritesheetFramesDialog,
  ] = useState(false);
  const [
    showExportAnimationFramesDialog,
    setShowExportAnimationFramesDialog,
  ] = useState(false);
  const [showLutManager, setShowLutManager] = useState(false);
  const [showColorSettings, setShowColorSettings] = useState(false);
  const [showProofSetup, setShowProofSetup] = useState(false);
  const [showProfileManager, setShowProfileManager] = useState(false);

  return {
    showProfileManager,
    setShowProfileManager,
    showProofSetup,
    setShowProofSetup,
    showColorSettings,
    setShowColorSettings,
    showLutManager,
    setShowLutManager,
    showImportSpritesheetFramesDialog,
    setShowImportSpritesheetFramesDialog,
    showExportAnimationFramesDialog,
    setShowExportAnimationFramesDialog,
    showNewImageDialog,
    setShowNewImageDialog,
    showExportDialog,
    setShowExportDialog,
    showResizeDialog,
    setShowResizeDialog,
    showResizeCanvasDialog,
    setShowResizeCanvasDialog,
    showAboutDialog,
    setShowAboutDialog,
    showShortcutsDialog,
    setShowShortcutsDialog,
    showSystemInfoDialog,
    setShowSystemInfoDialog,
    showGeneratePaletteDialog,
    setShowGeneratePaletteDialog,
    showColorDitheringSetup,
    setShowColorDitheringSetup,
    showContentAwareFillOptionsDialog,
    setShowContentAwareFillOptionsDialog,
    contentAwareFillOptionsMode,
    setContentAwareFillOptionsMode,
    pendingConversion,
    setPendingConversion,
  };
}
