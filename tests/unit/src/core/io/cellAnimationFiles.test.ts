// Cell animation folder files: paths, frame naming, manifest round trip and
// folder reconciliation.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CellAnimationState } from "@/types";
import {
  baseName,
  CELL_MANIFEST_FORMAT,
  CELL_MANIFEST_VERSION,
  cellFramePath,
  cellPreviewPath,
  cellTypeOf,
  joinPath,
  nextCellFileName,
  parseCellManifest,
  readCellFolder,
  serializeCellManifest,
} from "@/core/io/cellAnimationFiles";

const DEFAULTS: CellAnimationState = {
  enabled: true,
  folder: "/anim",
  fileType: "verve",
  fps: 12,
  frames: [],
  currentFrameId: null,
  selectedFrameIds: [],
  onionSkin: { enabled: true, before: 1, after: 1, opacity: 0.4, tint: true },
  background: { path: null, opacity: 1, visible: true },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paths", () => {
  it("joins with the folder's own separator and strips trailing separators", () => {
    expect(joinPath("/a/b/", "c.verve")).toBe("/a/b/c.verve");
    expect(joinPath("C:\\anim\\", "c.exr")).toBe("C:\\anim\\c.exr");
    expect(baseName("C:\\anim\\frame_0001.verve")).toBe("frame_0001.verve");
    expect(baseName("/x/y.exr")).toBe("y.exr");
    expect(cellFramePath("/anim", { id: "i", file: "frame_0002.exr", duration: 1 })).toBe("/anim/frame_0002.exr");
    expect(cellPreviewPath("D:\\anim", "frame_0002.exr")).toBe("D:\\anim\\.verve-previews\\frame_0002.exr.png");
  });

  it("recognises cell files case-insensitively", () => {
    expect(cellTypeOf("a.VERVE")).toBe("verve");
    expect(cellTypeOf("a.exr")).toBe("exr");
    expect(cellTypeOf("a.png")).toBeNull();
  });

  it("does not treat extension-less names as cells", () => {
    expect(cellTypeOf("verve")).toBeNull();
    expect(cellTypeOf("EXR")).toBeNull();
    expect(cellTypeOf(".verve")).toBeNull();
  });

  it("numbers new frames after the highest existing one", () => {
    expect(nextCellFileName([], "verve")).toBe("frame_0001.verve");
    expect(nextCellFileName(["frame_0003.verve", "frame_0010.exr", "other.verve"], "exr")).toBe("frame_0011.exr");
    expect(nextCellFileName(["frame_9999.verve"], "verve")).toBe("frame_10000.verve");
  });
});

describe("manifest", () => {
  const state: CellAnimationState = {
    ...DEFAULTS,
    fileType: "exr",
    fps: 24,
    frames: [
      { id: "x", file: "frame_0001.exr", duration: 2 },
      { id: "y", file: "frame_0002.exr", duration: 1 },
    ],
    onionSkin: { enabled: false, before: 3, after: 0, opacity: 0.25, tint: false },
    background: { path: "/ref.png", opacity: 0.5, visible: false },
  };

  it("serialize → parse round-trips the persisted fields", () => {
    const text = serializeCellManifest(state);
    const raw = JSON.parse(text);
    expect(raw.format).toBe(CELL_MANIFEST_FORMAT);
    expect(raw.formatVersion).toBe(CELL_MANIFEST_VERSION);
    // Session fields (ids, selection) are not persisted.
    expect(text).not.toContain('"id"');
    expect(parseCellManifest(text, DEFAULTS)).toEqual({
      fileType: "exr",
      fps: 24,
      frames: [
        { file: "frame_0001.exr", duration: 2 },
        { file: "frame_0002.exr", duration: 1 },
      ],
      onionSkin: state.onionSkin,
      background: state.background,
    });
  });

  it("rejects invalid JSON, foreign files and newer versions", () => {
    expect(() => parseCellManifest("{", DEFAULTS)).toThrow(/isn't valid JSON/);
    expect(() => parseCellManifest('{"format":"other"}', DEFAULTS)).toThrow(/isn't a Verve cell animation manifest/);
    expect(() => parseCellManifest("null", DEFAULTS)).toThrow(/isn't a Verve cell animation manifest/);
    expect(() =>
      parseCellManifest(JSON.stringify({ format: CELL_MANIFEST_FORMAT, formatVersion: CELL_MANIFEST_VERSION + 1 }), DEFAULTS),
    ).toThrow(/newer version/);
  });

  it("falls back to defaults and clamps out-of-range values", () => {
    const m = parseCellManifest(
      JSON.stringify({
        format: CELL_MANIFEST_FORMAT,
        fileType: "png",
        fps: 1000,
        frames: [
          { file: "frame_0001.verve", duration: 0 },
          { file: "frame_0002.verve", duration: 9999 },
          { file: "frame_0003.verve", duration: "x" },
        ],
        onionSkin: { enabled: "yes", before: -3, after: 2.6, opacity: 7, tint: false },
        background: { path: "", opacity: -1, visible: 0 },
      }),
      DEFAULTS,
    );
    expect(m.fileType).toBe("verve");
    expect(m.fps).toBe(120);
    expect(m.frames.map((f) => f.duration)).toEqual([1, 600, 1]);
    expect(m.onionSkin).toEqual({ enabled: true, before: 0, after: 3, opacity: 1, tint: false });
    expect(m.background).toEqual({ path: null, opacity: 0, visible: true });
  });

  it("drops frames that escape the folder, aren't cells, or repeat (case-insensitive)", () => {
    const m = parseCellManifest(
      JSON.stringify({
        format: CELL_MANIFEST_FORMAT,
        frames: [
          { file: "../evil.verve", duration: 1 },
          { file: "sub\\x.verve", duration: 1 },
          { file: "/abs.verve", duration: 1 },
          { file: "notes.txt", duration: 1 },
          { file: "frame_0001.verve", duration: 1 },
          { file: "FRAME_0001.VERVE", duration: 5 },
          null,
          { duration: 1 },
        ],
      }),
      DEFAULTS,
    );
    expect(m.frames).toEqual([{ file: "frame_0001.verve", duration: 1 }]);
  });
});

describe("readCellFolder", () => {
  function stubApi(opts: { exists?: boolean; isDirectory?: boolean; manifest: string | null; files: string[] }) {
    vi.stubGlobal("window", {
      api: {
        statPath: async () => ({ exists: opts.exists ?? true, isDirectory: opts.isDirectory ?? true }),
        readCellManifest: async () => opts.manifest,
        listDirectory: async () => [
          ...opts.files.map((name) => ({ name, isDirectory: false })),
          { name: ".verve-previews", isDirectory: true },
          { name: "dir.verve", isDirectory: true },
        ],
      },
    });
  }

  it("orders frames by the manifest, matches files case-insensitively and appends unlisted cells", async () => {
    stubApi({
      manifest: JSON.stringify({
        format: CELL_MANIFEST_FORMAT,
        frames: [
          { file: "frame_0002.verve", duration: 3 },
          { file: "frame_0009.verve", duration: 1 }, // deleted outside Verve
          { file: "FRAME_0001.verve", duration: 2 },
        ],
      }),
      files: ["frame_0001.verve", "frame_0002.verve", "frame_0005.exr", "readme.txt"],
    });
    const { manifest, frames } = await readCellFolder("/anim", DEFAULTS);
    expect(manifest).not.toBeNull();
    expect(frames.map((f) => [f.file, f.duration])).toEqual([
      ["frame_0002.verve", 3],
      ["frame_0001.verve", 2],
      ["frame_0005.exr", 1],
    ]);
    expect(new Set(frames.map((f) => f.id)).size).toBe(3);
  });

  it("works without a manifest", async () => {
    stubApi({ manifest: null, files: ["frame_0001.exr"] });
    const { manifest, frames } = await readCellFolder("/anim", DEFAULTS);
    expect(manifest).toBeNull();
    expect(frames.map((f) => f.file)).toEqual(["frame_0001.exr"]);
  });

  it("rejects a path that isn't a folder", async () => {
    stubApi({ isDirectory: false, manifest: null, files: [] });
    await expect(readCellFolder("/anim/file.verve", DEFAULTS)).rejects.toThrow(/isn't a folder/);
  });
});
