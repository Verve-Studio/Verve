// ─── Profile Manager dialog (Tier 3d) ────────────────────────────────────────
//
// Browses the OS + user-imported ICC profile catalog the main process
// scans on demand. The user can import new profiles (copied into Verve's
// userData/color-profiles directory) and delete their own — system
// profiles are read-only.
//
// Picking a profile here doesn't apply it to anything; this dialog is
// purely catalog management. The Assign / Convert / Display / Proof
// pickers still use the OS file dialog directly. Integrating those flows
// to also browse the catalog is a future polish item — kept out of scope
// here to limit the surface area touched in one push.

import React, { useEffect, useMemo, useState } from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import {
  colorProfileStore,
  useColorProfileCatalog,
} from "@/core/cms/colorProfileStore";
import {
  parseProfileDescription,
  parseProfileColorSpace,
} from "@/core/cms/iccProfile";
import styles from "./ProfileManagerDialog.module.scss";

interface ProfileManagerDialogProps {
  open: boolean;
  onClose: () => void;
}

interface ProfileDetail {
  description: string | null;
  colorSpace: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function ProfileManagerDialog({
  open,
  onClose,
}: ProfileManagerDialogProps): React.JSX.Element | null {
  const catalog = useColorProfileCatalog();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProfileDetail | null>(null);

  // Trigger a refresh whenever the dialog opens so newly-installed system
  // profiles (rare but possible) show up.
  useEffect(() => {
    if (open) void colorProfileStore.refresh();
  }, [open]);

  // When the user picks a row, fetch the bytes lazily and parse out
  // description + colourspace. Cached implicitly by React state — re-
  // selecting the same row does nothing.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const bytes = await colorProfileStore.readBytes(selectedId);
      if (cancelled) return;
      if (!bytes) {
        setDetail({ description: null, colorSpace: "unknown" });
        return;
      }
      setDetail({
        description: parseProfileDescription(bytes),
        colorSpace: parseProfileColorSpace(bytes).toUpperCase(),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const { userEntries, systemEntries } = useMemo(() => {
    return {
      userEntries: catalog.filter((e) => e.source === "user"),
      systemEntries: catalog.filter((e) => e.source === "system"),
    };
  }, [catalog]);

  const selected = selectedId
    ? catalog.find((e) => e.id === selectedId) ?? null
    : null;

  const handleImport = async (): Promise<void> => {
    const newId = await colorProfileStore.importFromFile();
    if (newId) setSelectedId(newId);
  };

  const handleDelete = async (): Promise<void> => {
    if (!selected || selected.source !== "user") return;
    await colorProfileStore.deleteUser(selected.id);
    if (selectedId === selected.id) setSelectedId(null);
  };

  return (
    <ModalDialog
      open={open}
      title="Profile Manager"
      width={620}
      onClose={onClose}
    >
      <div className={styles.body}>
        <div className={styles.listColumn}>
          <ul className={styles.list}>
            {userEntries.length > 0 && (
              <>
                <li className={styles.groupHeader}>Imported</li>
                {userEntries.map((e) => (
                  <li
                    key={e.id}
                    className={`${styles.item} ${selectedId === e.id ? styles.selected : ""}`}
                    onClick={() => setSelectedId(e.id)}
                  >
                    <span className={styles.itemName}>{e.filename}</span>
                    <span className={styles.itemSize}>
                      {formatSize(e.size)}
                    </span>
                  </li>
                ))}
              </>
            )}
            {systemEntries.length > 0 && (
              <>
                <li className={styles.groupHeader}>System</li>
                {systemEntries.map((e) => (
                  <li
                    key={e.id}
                    className={`${styles.item} ${selectedId === e.id ? styles.selected : ""}`}
                    onClick={() => setSelectedId(e.id)}
                  >
                    <span className={styles.itemName}>{e.filename}</span>
                    <span className={styles.itemSize}>
                      {formatSize(e.size)}
                    </span>
                  </li>
                ))}
              </>
            )}
            {catalog.length === 0 && colorProfileStore.isLoaded() && (
              <li className={styles.empty}>
                No profiles found. Import an .icc / .icm file to get started.
              </li>
            )}
          </ul>
        </div>

        <div className={styles.detailColumn}>
          {selected && detail ? (
            <>
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>Name</span>
                <span className={styles.detailValue}>
                  {detail.description ?? "—"}
                </span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>Filename</span>
                <span className={styles.detailValue}>{selected.filename}</span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>Color Space</span>
                <span className={styles.detailValue}>{detail.colorSpace}</span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>Size</span>
                <span className={styles.detailValue}>
                  {formatSize(selected.size)}
                </span>
              </div>
              <div className={styles.detailRow}>
                <span className={styles.detailLabel}>Source</span>
                <span className={styles.detailValue}>
                  {selected.source === "user"
                    ? "Imported (Verve)"
                    : "System (read-only)"}
                </span>
              </div>
            </>
          ) : (
            <p className={styles.empty}>
              Select a profile to see its details.
            </p>
          )}
        </div>
      </div>

      <div className={styles.footer}>
        <DialogButton onClick={() => void handleImport()}>Import…</DialogButton>
        <DialogButton
          onClick={() => void handleDelete()}
          disabled={!selected || selected.source !== "user"}
        >
          Delete
        </DialogButton>
        <div className={styles.footerSpacer} />
        <DialogButton onClick={onClose} primary>
          Close
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
