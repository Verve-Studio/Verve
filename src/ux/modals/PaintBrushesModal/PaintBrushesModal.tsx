import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Brush } from "@/types";
import { useAppContext } from "@/core/store/AppContext";
import {
  brushStore,
  serializeBrushFile,
  parseBrushFile,
} from "@/core/store/brushStore";
import { brushManagerStore } from "@/core/tools/Brush/brushManagerStore";
import { DialogButton } from "@/ux/widgets/DialogButton/DialogButton";
import styles from "./PaintBrushesModal.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PaintBrushesModalProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "document" | "user";

// ─── Brush list row ───────────────────────────────────────────────────────────
//
// Paint brushes are parametric (no fixed bitmap), so the row shows the brush
// name, its tip kind / size, and inline actions for rename/delete. Selection
// is a click on the row.

interface BrushRowProps {
  brush: Brush;
  selected: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}

function BrushRow({
  brush,
  selected,
  onSelect,
  onRename,
  onDelete,
}: BrushRowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(brush.name);

  useEffect(() => setDraftName(brush.name), [brush.name]);

  const commit = (): void => {
    setEditing(false);
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== brush.name) onRename(trimmed);
    else setDraftName(brush.name);
  };

  return (
    <div
      className={selected ? styles.rowActive : styles.row}
      onClick={onSelect}
    >
      <div className={styles.rowSwatch} aria-hidden>
        {brush.shape.kind === "bitmap" ? "◉" : brush.shape.kind === "square" ? "▣" : brush.shape.kind === "diamond" ? "◆" : "●"}
      </div>
      <div className={styles.rowMain}>
        {editing ? (
          <input
            className={styles.rowNameInput}
            value={draftName}
            autoFocus
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") {
                setEditing(false);
                setDraftName(brush.name);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className={styles.rowName}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            {brush.name}
          </span>
        )}
        <span className={styles.rowMeta}>
          {brush.shape.kind} · {Math.round(brush.tip.size)} px
          {brush.smudge.enabled ? " · smudge" : ""}
          {brush.wetEdges.enabled ? " · wet" : ""}
        </span>
      </div>
      <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
        <button
          className={styles.iconBtn}
          title="Rename"
          onClick={() => setEditing(true)}
        >
          ✎
        </button>
        <button
          className={styles.iconBtn}
          title="Delete"
          onClick={onDelete}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

export function PaintBrushesModal({
  open,
  onClose,
}: PaintBrushesModalProps): React.JSX.Element | null {
  const { state, dispatch } = useAppContext();
  const [activeTab, setActiveTab] = useState<Tab>("user");
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userBrushes, setUserBrushes] = useState<Brush[]>(() =>
    brushStore.getUserBrushes(),
  );
  const [persistError, setPersistError] = useState<string | null>(null);

  // Sync user brushes from the singleton.
  useEffect(() => {
    const update = (): void => setUserBrushes([...brushStore.getUserBrushes()]);
    brushStore.subscribe(update);
    return () => brushStore.unsubscribe(update);
  }, []);

  // Close on Escape.
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
      dispatch({ type: "REMOVE_BRUSH", payload: id });
      if (selectedDocId === id) setSelectedDocId(null);
    },
    [dispatch, selectedDocId],
  );

  const handleRenameDoc = useCallback(
    (id: string, name: string): void => {
      const brush = state.brushes.find((b) => b.id === id);
      if (!brush) return;
      dispatch({ type: "UPDATE_BRUSH", payload: { ...brush, name } });
    },
    [dispatch, state.brushes],
  );

  const handleCopyDocToUser = useCallback(async (): Promise<void> => {
    const brush = state.brushes.find((b) => b.id === selectedDocId);
    if (!brush) return;
    try {
      await brushStore.addUserBrush({
        ...brush,
        id: crypto.randomUUID(),
        scope: "user",
        createdAt: Date.now(),
      });
      setPersistError(null);
    } catch (err) {
      setPersistError(String(err));
    }
  }, [state.brushes, selectedDocId]);

  // ── User brush ops ──────────────────────────────────────────────────────────

  const handleDeleteUser = useCallback(
    async (id: string): Promise<void> => {
      try {
        await brushStore.removeUserBrush(id);
        if (selectedUserId === id) setSelectedUserId(null);
        // Clear active brush if it referenced the deleted one.
        if (state.activeBrushId === id) {
          dispatch({ type: "SET_ACTIVE_BRUSH", payload: null });
        }
        setPersistError(null);
      } catch (err) {
        setPersistError(String(err));
      }
    },
    [selectedUserId, state.activeBrushId, dispatch],
  );

  const handleRenameUser = useCallback(
    async (id: string, name: string): Promise<void> => {
      try {
        await brushStore.renameUserBrush(id, name);
        setPersistError(null);
      } catch (err) {
        setPersistError(String(err));
      }
    },
    [],
  );

  const handleCopyUserToDoc = useCallback((): void => {
    const brush = userBrushes.find((b) => b.id === selectedUserId);
    if (!brush) return;
    dispatch({
      type: "ADD_BRUSH",
      payload: {
        ...brush,
        id: crypto.randomUUID(),
        scope: "document",
        createdAt: Date.now(),
      },
    });
  }, [userBrushes, selectedUserId, dispatch]);

  // ── Import / Export ─────────────────────────────────────────────────────────

  const handleImport = useCallback(async (): Promise<void> => {
    const filePath = await window.api.openPaintBrushFileDialog();
    if (!filePath) return;
    const json = await window.api.readPaintBrushFile(filePath);
    const imported = parseBrushFile(json);
    if (imported.length === 0) return;
    const withNewIds = imported.map((b) => ({ ...b, id: crypto.randomUUID() }));
    if (activeTab === "user") {
      try {
        await brushStore.setUserBrushes([
          ...brushStore.getUserBrushes(),
          ...withNewIds.map((b) => ({ ...b, scope: "user" as const })),
        ]);
        setPersistError(null);
      } catch (err) {
        setPersistError(String(err));
      }
    } else {
      dispatch({
        type: "SET_BRUSHES",
        payload: [
          ...state.brushes,
          ...withNewIds.map((b) => ({ ...b, scope: "document" as const })),
        ],
      });
    }
  }, [activeTab, state.brushes, dispatch]);

  const handleExportSelected = useCallback(async (): Promise<void> => {
    let brushesToExport: Brush[];
    if (activeTab === "document") {
      brushesToExport = selectedDocId
        ? state.brushes.filter((b) => b.id === selectedDocId)
        : state.brushes;
    } else {
      brushesToExport = selectedUserId
        ? userBrushes.filter((b) => b.id === selectedUserId)
        : userBrushes;
    }
    if (brushesToExport.length === 0) return;
    const defaultName =
      brushesToExport.length === 1
        ? `${brushesToExport[0].name}.vbrush`
        : "brushes.vbrush";
    const filePath = await window.api.savePaintBrushFileDialog(defaultName);
    if (!filePath) return;
    await window.api.writePaintBrushFile(
      filePath,
      serializeBrushFile(brushesToExport),
    );
  }, [activeTab, state.brushes, userBrushes, selectedDocId, selectedUserId]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!open) return null;

  const docBrushes = state.brushes;

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
        aria-label="Paint Brushes"
      >
        <div className={styles.titleBar}>Paint Brushes</div>

        <div className={styles.body}>
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${activeTab === "user" ? styles.tabActive : ""}`}
              onClick={() => setActiveTab("user")}
            >
              User Profile
              <span className={styles.count}>{userBrushes.length}</span>
            </button>
            <button
              className={`${styles.tab} ${activeTab === "document" ? styles.tabActive : ""}`}
              onClick={() => setActiveTab("document")}
            >
              Document
              <span className={styles.count}>{docBrushes.length}</span>
            </button>
          </div>

          <div className={styles.listWrap}>
            {activeTab === "user"
              ? userBrushes.length === 0
                ? <div className={styles.empty}>No user-profile brushes yet</div>
                : userBrushes.map((b) => (
                    <BrushRow
                      key={b.id}
                      brush={b}
                      selected={selectedUserId === b.id}
                      onSelect={() => setSelectedUserId(b.id)}
                      onRename={(name) => void handleRenameUser(b.id, name)}
                      onDelete={() => void handleDeleteUser(b.id)}
                    />
                  ))
              : docBrushes.length === 0
                ? <div className={styles.empty}>No document brushes yet</div>
                : docBrushes.map((b) => (
                    <BrushRow
                      key={b.id}
                      brush={b}
                      selected={selectedDocId === b.id}
                      onSelect={() => setSelectedDocId(b.id)}
                      onRename={(name) => handleRenameDoc(b.id, name)}
                      onDelete={() => handleDeleteDoc(b.id)}
                    />
                  ))}
          </div>

          <div className={styles.transferRow}>
            {activeTab === "user" ? (
              <DialogButton
                onClick={handleCopyUserToDoc}
                disabled={!selectedUserId}
                title="Copy selected brush into the active document so it travels with the .verve file"
              >
                Copy to Document ↓
              </DialogButton>
            ) : (
              <DialogButton
                onClick={() => void handleCopyDocToUser()}
                disabled={!selectedDocId}
                title="Copy selected brush to your User Profile (persists across documents)"
              >
                Copy to User Profile ↑
              </DialogButton>
            )}
          </div>

          {persistError && (
            <div className={styles.error}>
              Could not save user brushes: {persistError}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <DialogButton
            onClick={() => void handleImport()}
            title="Import brushes from a .vbrush file"
          >
            Import…
          </DialogButton>
          <DialogButton
            onClick={() => void handleExportSelected()}
            title="Export selected brush (or all if none selected) to a .vbrush file"
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

// ─── Singleton-driven mount ───────────────────────────────────────────────────
//
// Drop `<PaintBrushesModalMount />` once in MainWindow; the brush settings
// panel's "Manage…" button toggles `brushManagerStore` without needing any
// prop plumbing.

export function PaintBrushesModalMount(): React.JSX.Element {
  const [open, setOpen] = useState(brushManagerStore.isVisible());
  useEffect(() => {
    return brushManagerStore.subscribe(() =>
      setOpen(brushManagerStore.isVisible()),
    );
  }, []);
  return (
    <PaintBrushesModal
      open={open}
      onClose={() => brushManagerStore.close()}
    />
  );
}
