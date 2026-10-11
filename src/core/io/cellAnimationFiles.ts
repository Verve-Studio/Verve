// ─── Cell animation folder files ──────────────────────────────────────────────
//
// A cell animation is a folder holding one file per frame (`.verve` or
// `.exr`), a manifest `verve-cells.json` (frame order, durations, playback,
// onion-skin and background settings) and `.verve-previews/`, flattened
// 8-bit PNG previews of each frame for onion skin and playback.
//
// Manifest: `{ format: "verve-cells", formatVersion, fileType, fps, frames:
// [{ file, duration }], onionSkin, background }`. Bump `formatVersion` when
// the shape changes incompatibly.

import type {
  CellAnimationState,
  CellBackground,
  CellFileType,
  CellFrame,
  CellOnionSkin,
} from "@/types";

export const CELL_MANIFEST_FORMAT = "verve-cells";
export const CELL_MANIFEST_VERSION = 1;
export const CELL_PREVIEW_DIR = ".verve-previews";

const CELL_EXTENSIONS: readonly CellFileType[] = ["verve", "exr"];

// ─── Paths ────────────────────────────────────────────────────────────────────

export function joinPath(folder: string, name: string): string {
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}${name}`;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The cell file type a file name has, or null when it isn't a cell. */
export function cellTypeOf(file: string): CellFileType | null {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return (CELL_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as CellFileType)
    : null;
}

export function cellFramePath(folder: string, frame: CellFrame): string {
  return joinPath(folder, frame.file);
}

export function cellPreviewPath(folder: string, file: string): string {
  return joinPath(joinPath(folder, CELL_PREVIEW_DIR), `${file}.png`);
}

/** Next unused `frame_NNNN.<ext>` name (numbered after the highest
 *  existing one, so names never collide with a deleted frame's preview). */
export function nextCellFileName(
  existing: readonly string[],
  type: CellFileType,
): string {
  let max = 0;
  for (const name of existing) {
    const m = /^frame_(\d+)\./i.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `frame_${String(max + 1).padStart(4, "0")}.${type}`;
}

export function newCellFrameId(): string {
  return `cell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

/** What a manifest stores: the persisted subset of `CellAnimationState`. */
export interface CellManifest {
  fileType: CellFileType;
  fps: number;
  frames: Array<{ file: string; duration: number }>;
  onionSkin: CellOnionSkin;
  background: CellBackground;
}

export function serializeCellManifest(s: CellAnimationState): string {
  return JSON.stringify(
    {
      format: CELL_MANIFEST_FORMAT,
      formatVersion: CELL_MANIFEST_VERSION,
      fileType: s.fileType,
      fps: s.fps,
      frames: s.frames.map((f) => ({ file: f.file, duration: f.duration })),
      onionSkin: s.onionSkin,
      background: s.background,
    },
    null,
    2,
  );
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(hi, Math.max(lo, v))
    : fallback;

/** Parse a manifest, falling back to `defaults` for missing or invalid
 *  fields. Throws when the text isn't a cell manifest at all. */
export function parseCellManifest(
  text: string,
  defaults: CellAnimationState,
): CellManifest {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("verve-cells.json isn't valid JSON.");
  }
  if (!raw || typeof raw !== "object" || raw.format !== CELL_MANIFEST_FORMAT) {
    throw new Error("verve-cells.json isn't a Verve cell animation manifest.");
  }
  if (typeof raw.formatVersion === "number" && raw.formatVersion > CELL_MANIFEST_VERSION) {
    throw new Error("verve-cells.json was written by a newer version of Verve.");
  }
  const frames: CellManifest["frames"] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.frames)) {
    for (const f of raw.frames as unknown[]) {
      if (!f || typeof f !== "object") continue;
      const { file, duration } = f as Record<string, unknown>;
      // Plain file names only: the manifest must not point outside the folder.
      if (typeof file !== "string" || /[\\/]/.test(file) || !cellTypeOf(file)) continue;
      const key = file.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      frames.push({ file, duration: Math.round(clamp(duration, 1, 600, 1)) });
    }
  }
  const o = (raw.onionSkin ?? {}) as Record<string, unknown>;
  const b = (raw.background ?? {}) as Record<string, unknown>;
  return {
    fileType: raw.fileType === "exr" ? "exr" : raw.fileType === "verve" ? "verve" : defaults.fileType,
    fps: Math.round(clamp(raw.fps, 1, 120, defaults.fps)),
    frames,
    onionSkin: {
      enabled: typeof o.enabled === "boolean" ? o.enabled : defaults.onionSkin.enabled,
      before: Math.round(clamp(o.before, 0, 5, defaults.onionSkin.before)),
      after: Math.round(clamp(o.after, 0, 5, defaults.onionSkin.after)),
      opacity: clamp(o.opacity, 0, 1, defaults.onionSkin.opacity),
      tint: typeof o.tint === "boolean" ? o.tint : defaults.onionSkin.tint,
    },
    background: {
      path: typeof b.path === "string" && b.path ? b.path : null,
      opacity: clamp(b.opacity, 0, 1, defaults.background.opacity),
      visible: typeof b.visible === "boolean" ? b.visible : defaults.background.visible,
    },
  };
}

// ─── Folder scan ──────────────────────────────────────────────────────────────

export interface CellFolderContents {
  manifest: CellManifest | null;
  /** Frames in order: the manifest's frames whose files exist, then any
   *  cell files the manifest doesn't list (natural name order). */
  frames: CellFrame[];
}

/** Read a cell folder: its manifest (when present) reconciled with the
 *  cell files actually in it. */
export async function readCellFolder(
  folder: string,
  defaults: CellAnimationState,
): Promise<CellFolderContents> {
  const stat = await window.api.statPath(folder);
  if (!stat.exists || !stat.isDirectory) {
    throw new Error(`"${folder}" isn't a folder.`);
  }
  const text = await window.api.readCellManifest(folder);
  const manifest = text === null ? null : parseCellManifest(text, defaults);
  const entries = await window.api.listDirectory(folder, { files: true });
  const onDisk = entries
    .filter((e) => !e.isDirectory && cellTypeOf(e.name) !== null)
    .map((e) => e.name);
  const byKey = new Map(onDisk.map((n) => [n.toLowerCase(), n]));

  const frames: CellFrame[] = [];
  const listed = new Set<string>();
  for (const f of manifest?.frames ?? []) {
    const actual = byKey.get(f.file.toLowerCase());
    if (!actual) continue; // Deleted outside Verve.
    listed.add(actual.toLowerCase());
    frames.push({ id: newCellFrameId(), file: actual, duration: f.duration });
  }
  for (const name of onDisk) {
    if (listed.has(name.toLowerCase())) continue;
    frames.push({ id: newCellFrameId(), file: name, duration: 1 });
  }
  return { manifest, frames };
}
