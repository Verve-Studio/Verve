// ─── Profile Picker dialog ───────────────────────────────────────────────────
//
// Shared picker the four ICC entry points (Assign / Convert / Set Display /
// Set Proof) open via `profilePickerStore.request()`. Shows the catalog
// (Imported + System) with a text filter, the selected profile's parsed
// details on the right, and a "Browse File…" escape hatch for one-off
// picks. Confirm yields the chosen profile's bytes via the picker store;
// cancel yields null.

import React, { useEffect, useMemo, useState } from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import {
  colorProfileStore,
  useColorProfileCatalog,
} from "@/core/cms/colorProfileStore";
import {
  profilePickerStore,
  useProfilePickerOpen,
} from "@/core/cms/profilePickerStore";
import {
  parseProfileDescription,
  parseProfileColorSpace,
} from "@/core/cms/iccProfile";
import styles from "./ProfilePickerDialog.module.scss";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function ProfilePickerDialog(): React.JSX.Element | null {
  const open = useProfilePickerOpen();
  const catalog = useColorProfileCatalog();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [detail, setDetail] = useState<{
    name: string | null;
    colorSpace: string;
  } | null>(null);

  // Refresh the catalog whenever we open — picks up profiles imported
  // through the manager dialog while this one was closed, and any newly
  // installed system profiles.
  useEffect(() => {
    if (open) {
      void colorProfileStore.refresh();
      setSelectedId(null);
      setFilter("");
      setDetail(null);
    }
  }, [open]);

  // Lazy fetch detail for the selected entry. Re-runs on selection change.
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
        setDetail({ name: null, colorSpace: "unknown" });
        return;
      }
      setDetail({
        name: parseProfileDescription(bytes),
        colorSpace: parseProfileColorSpace(bytes).toUpperCase(),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return catalog;
    const q = filter.toLowerCase();
    return catalog.filter((e) =>
      e.filename.toLowerCase().includes(q),
    );
  }, [catalog, filter]);

  const userEntries = filtered.filter((e) => e.source === "user");
  const systemEntries = filtered.filter((e) => e.source === "system");

  const selected = selectedId
    ? catalog.find((e) => e.id === selectedId) ?? null
    : null;

  const handleCancel = (): void => {
    profilePickerStore.resolve(null);
  };

  const handleUseSelected = async (): Promise<void> => {
    if (!selectedId) return;
    const bytes = await colorProfileStore.readBytes(selectedId);
    profilePickerStore.resolve(bytes);
  };

  // Browse File… opens the OS file picker. Lets the user grab a profile
  // that isn't (yet) in the catalog without forcing them to import it
  // first — the use case is one-off / temporary picks.
  const handleBrowse = async (): Promise<void> => {
    const path = await window.api.openIccProfileDialog();
    if (!path) return; // user cancelled the file dialog; picker stays open
    const base64 = await window.api.readFileBase64(path);
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    profilePickerStore.resolve(bytes);
  };

  if (!open) return null;

  return (
    <ModalDialog
      open={open}
      title="Choose Profile"
      width={620}
      onClose={handleCancel}
    >
      <div className={styles.body}>
        <div className={styles.listColumn}>
          <input
            className={styles.search}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search profiles…"
            autoFocus
          />
          <ul className={styles.list}>
            {userEntries.length > 0 && (
              <>
                <li className={styles.groupHeader}>Imported</li>
                {userEntries.map((e) => (
                  <li
                    key={e.id}
                    className={`${styles.item} ${selectedId === e.id ? styles.selected : ""}`}
                    onClick={() => setSelectedId(e.id)}
                    onDoubleClick={() => void handleUseSelected()}
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
                    onDoubleClick={() => void handleUseSelected()}
                  >
                    <span className={styles.itemName}>{e.filename}</span>
                    <span className={styles.itemSize}>
                      {formatSize(e.size)}
                    </span>
                  </li>
                ))}
              </>
            )}
            {filtered.length === 0 && (
              <li className={styles.empty}>
                {catalog.length === 0
                  ? "No profiles in catalog. Use Browse File… or open Image ▸ Manage Profiles… to import."
                  : "No profiles match the filter."}
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
                  {detail.name ?? "—"}
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
                    : "System"}
                </span>
              </div>
            </>
          ) : (
            <p className={styles.empty}>
              Select a profile or use <strong>Browse File…</strong> to pick
              one off disk.
            </p>
          )}
        </div>
      </div>

      <div className={styles.footer}>
        <DialogButton onClick={() => void handleBrowse()}>
          Browse File…
        </DialogButton>
        <div className={styles.footerSpacer} />
        <DialogButton onClick={handleCancel}>Cancel</DialogButton>
        <DialogButton
          onClick={() => void handleUseSelected()}
          disabled={!selectedId}
          primary
        >
          Use Selected
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
