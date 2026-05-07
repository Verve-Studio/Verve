import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PixelBrush } from "@/types";
import { useAppContext } from "@/core/store/AppContext";
import {
  pixelBrushStore,
  serializePixelBrushFile,
  parsePixelBrushFile,
} from "@/core/store/pixelBrushStore";
import { PixelBrushGallery } from "@/ux/widgets/PixelBrushGallery/PixelBrushGallery";
import { DialogButton } from "@/ux/widgets/DialogButton/DialogButton";
import styles from "./PixelBrushesModal.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PixelBrushesModalProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "document" | "user";

// ─── Component ────────────────────────────────────────────────────────────────

export function PixelBrushesModal({
  open,
  onClose,
}: PixelBrushesModalProps): React.JSX.Element | null {
  const { state, dispatch } = useAppContext();
  const [activeTab, setActiveTab] = useState<Tab>("document");
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userBrushes, setUserBrushes] = useState<PixelBrush[]>(() =>
    pixelBrushStore.getUserBrushes(),
  );

  // Sync user brushes from store
  useEffect(() => {
    const update = (): void =>
      setUserBrushes([...pixelBrushStore.getUserBrushes()]);
    pixelBrushStore.subscribe(update);
    return () => pixelBrushStore.unsubscribe(update);
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  // ── Document brush ops ──────────────────────────────────────────────────────

  const handleDeleteDoc = useCallback(
    (id: string): void => {
      dispatch({ type: "REMOVE_PIXEL_BRUSH", payload: id });
      if (selectedDocId === id) setSelectedDocId(null);
    },
    [dispatch, selectedDocId],
  );

  const handleRenameDoc = useCallback(
    (id: string, name: string): void => {
      dispatch({ type: "RENAME_PIXEL_BRUSH", payload: { id, name } });
    },
    [dispatch],
  );

  const handleMoveDocToUser = useCallback(async (): Promise<void> => {
    const brush = state.pixelBrushes.find((b) => b.id === selectedDocId);
    if (!brush) return;
    await pixelBrushStore.addUserBrush({ ...brush, id: crypto.randomUUID() });
  }, [state.pixelBrushes, selectedDocId]);

  // ── User brush ops ──────────────────────────────────────────────────────────

  const handleDeleteUser = useCallback(
    async (id: string): Promise<void> => {
      await pixelBrushStore.removeUserBrush(id);
      if (selectedUserId === id) setSelectedUserId(null);
    },
    [selectedUserId],
  );

  const handleRenameUser = useCallback(
    async (id: string, name: string): Promise<void> => {
      await pixelBrushStore.renameUserBrush(id, name);
    },
    [],
  );

  const handleMoveUserToDoc = useCallback((): void => {
    const brush = userBrushes.find((b) => b.id === selectedUserId);
    if (!brush) return;
    dispatch({
      type: "ADD_PIXEL_BRUSH",
      payload: { ...brush, id: crypto.randomUUID() },
    });
  }, [userBrushes, selectedUserId, dispatch]);

  // ── Import / Export ─────────────────────────────────────────────────────────

  const handleImport = useCallback(async (): Promise<void> => {
    const filePath = await window.api.openBrushFileDialog();
    if (!filePath) return;
    const json = await window.api.readBrushFile(filePath);
    const imported = parsePixelBrushFile(json);
    if (imported.length === 0) return;
    // Give each imported brush a fresh ID to avoid conflicts
    const withNewIds = imported.map((b) => ({ ...b, id: crypto.randomUUID() }));
    if (activeTab === "user") {
      await pixelBrushStore.setUserBrushes([
        ...pixelBrushStore.getUserBrushes(),
        ...withNewIds,
      ]);
    } else {
      dispatch({
        type: "SET_PIXEL_BRUSHES",
        payload: [...state.pixelBrushes, ...withNewIds],
      });
    }
  }, [activeTab, state.pixelBrushes, dispatch]);

  const handleExportSelected = useCallback(async (): Promise<void> => {
    let brushesToExport: PixelBrush[];
    if (activeTab === "document") {
      brushesToExport = selectedDocId
        ? state.pixelBrushes.filter((b) => b.id === selectedDocId)
        : state.pixelBrushes;
    } else {
      brushesToExport = selectedUserId
        ? userBrushes.filter((b) => b.id === selectedUserId)
        : userBrushes;
    }
    if (brushesToExport.length === 0) return;
    const defaultName =
      brushesToExport.length === 1
        ? `${brushesToExport[0].name}.pxbrush`
        : "brushes.pxbrush";
    const filePath = await window.api.saveBrushFileDialog(defaultName);
    if (!filePath) return;
    await window.api.writeBrushFile(
      filePath,
      serializePixelBrushFile(brushesToExport),
    );
  }, [
    activeTab,
    state.pixelBrushes,
    userBrushes,
    selectedDocId,
    selectedUserId,
  ]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!open) return null;

  const docBrushes = state.pixelBrushes;
  const docSelected = selectedDocId;
  const userSelected = selectedUserId;

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Pixel Brushes"
      >
        {/* Title bar */}
        <div className={styles.titleBar}>Pixel Brushes</div>

        {/* Body */}
        <div className={styles.body}>
          {/* Tab strip */}
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${activeTab === "document" ? styles.tabActive : ""}`}
              onClick={() => setActiveTab("document")}
            >
              Document
              <span className={styles.count}>{docBrushes.length}</span>
            </button>
            <button
              className={`${styles.tab} ${activeTab === "user" ? styles.tabActive : ""}`}
              onClick={() => setActiveTab("user")}
            >
              User Profile
              <span className={styles.count}>{userBrushes.length}</span>
            </button>
          </div>

          {/* Gallery */}
          <div className={styles.galleryWrap}>
            {activeTab === "document" ? (
              <PixelBrushGallery
                brushes={docBrushes}
                selectedId={docSelected}
                onSelect={setSelectedDocId}
                onDelete={handleDeleteDoc}
                onRename={handleRenameDoc}
                emptyMessage="No brushes in this document yet"
              />
            ) : (
              <PixelBrushGallery
                brushes={userBrushes}
                selectedId={userSelected}
                onSelect={setSelectedUserId}
                onDelete={(id) => {
                  void handleDeleteUser(id);
                }}
                onRename={(id, name) => {
                  void handleRenameUser(id, name);
                }}
                emptyMessage="No user profile brushes yet"
              />
            )}
          </div>

          {/* Transfer row */}
          <div className={styles.transferRow}>
            {activeTab === "document" ? (
              <>
                <DialogButton
                  onClick={() => {
                    void handleMoveDocToUser();
                  }}
                  disabled={!selectedDocId}
                  title="Copy selected brush to User Profile"
                >
                  Copy to User Profile ↑
                </DialogButton>
              </>
            ) : (
              <>
                <DialogButton
                  onClick={handleMoveUserToDoc}
                  disabled={!selectedUserId}
                  title="Copy selected brush to this Document"
                >
                  Copy to Document ↓
                </DialogButton>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <DialogButton
            onClick={() => {
              void handleImport();
            }}
            title="Import brushes from a .pxbrush file"
          >
            Import…
          </DialogButton>
          <DialogButton
            onClick={() => {
              void handleExportSelected();
            }}
            title="Export selected brush (or all if none selected) to a .pxbrush file"
          >
            Export…
          </DialogButton>
          <span className={styles.footerSep} />
          <DialogButton onClick={onClose} primary>
            Done
          </DialogButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}
