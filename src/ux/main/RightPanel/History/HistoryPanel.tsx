import React, { useEffect, useRef, useState } from "react";
import { historyStore } from "@/core/store/historyStore";
import { DialogButton } from "@/ux/widgets/DialogButton/DialogButton";
import styles from "./HistoryPanel.module.scss";

// ─── Icons ────────────────────────────────────────────────────────────────────

const DrawIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    width="10"
    height="10"
  >
    <path d="M2 8 L7.5 2.5 M6 1.5 L8.5 4 M1.5 8.5 L2.5 7.5" />
  </svg>
);

const ScissorsIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    width="10"
    height="10"
  >
    <circle cx="2.5" cy="2.5" r="1.3" />
    <circle cx="2.5" cy="7.5" r="1.3" />
    <path d="M3.7 3.2 L8.5 8 M3.7 6.8 L8.5 2" />
  </svg>
);

const ClipboardIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 10 11"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    width="10"
    height="10"
  >
    <rect x="2" y="2" width="6" height="8" rx="0.8" />
    <path d="M4 2 L4 1 L6 1 L6 2" />
    <path d="M3.5 5 L6.5 5 M3.5 6.5 L5.5 6.5" />
  </svg>
);

const LayerIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    strokeLinecap="round"
    width="10"
    height="10"
  >
    <path d="M5 1.5 L9 3.5 L5 5.5 L1 3.5 Z" />
    <path d="M1 6 L5 8 L9 6" />
  </svg>
);

const ActionIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 8 8" fill="currentColor" width="8" height="8">
    <path d="M2 1.5 L6.5 4 L2 6.5 Z" />
  </svg>
);

function IconForLabel({ label }: { label: string }): React.JSX.Element {
  if (
    label === "Pencil" ||
    label === "Brush" ||
    label === "Erase" ||
    label === "Fill"
  )
    return <DrawIcon />;
  if (label === "Cut") return <ScissorsIcon />;
  if (label === "Paste") return <ClipboardIcon />;
  if (label.startsWith("New Layer") || label === "Delete Layer")
    return <LayerIcon />;
  return <ActionIcon />;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts);
  return [
    d.getHours().toString().padStart(2, "0"),
    d.getMinutes().toString().padStart(2, "0"),
    d.getSeconds().toString().padStart(2, "0"),
  ].join(":");
}

// ─── Component ────────────────────────────────────────────────────────────────

export function HistoryPanel(): React.JSX.Element {
  const [, forceUpdate] = useState(0);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => historyStore.subscribe(() => forceUpdate((n) => n + 1)), []);

  // Scroll the selected entry into view whenever it changes
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  });

  const { entries, currentIndex, selectedIndex } = historyStore;

  if (entries.length === 0) {
    return <div className={styles.empty}>No history yet</div>;
  }

  const canRestore = selectedIndex !== currentIndex && selectedIndex >= 0;

  return (
    <div className={styles.container}>
      <div className={styles.list}>
        {entries.map((entry, i) => (
          <button
            key={entry.id}
            ref={i === selectedIndex ? selectedRef : null}
            className={[
              styles.entry,
              i === currentIndex ? styles.current : "",
              i === selectedIndex ? styles.selected : "",
              i > currentIndex ? styles.redo : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => historyStore.select(i)}
            title={formatTime(entry.timestamp)}
          >
            <span className={styles.icon}>
              <IconForLabel label={entry.label} />
            </span>
            <span className={styles.label}>{entry.label}</span>
            <span className={styles.time}>{formatTime(entry.timestamp)}</span>
          </button>
        ))}
      </div>
      <div className={styles.footer}>
        <DialogButton
          onClick={() => historyStore.jumpTo(selectedIndex)}
          disabled={!canRestore}
          primary
        >
          Restore to here
        </DialogButton>
        <DialogButton onClick={() => historyStore.clear()}>
          Clear History
        </DialogButton>
      </div>
    </div>
  );
}
