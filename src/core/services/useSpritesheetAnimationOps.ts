import { useCallback } from "react";
import type { Dispatch, MutableRefObject } from "react";
import type { AppAction } from "@/core/store/AppContext";
import type { AppState } from "@/types";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";
import { showOperationError } from "@/utils/userFeedback";
import { clampF32ToUint8 } from "@/utils/pixelFormatConvert";
import {
  computeEffectivePalette,
  paletteCyclePeriod,
  paletteCycleStore,
} from "@/core/store/paletteCycleStore";
import type { ImportSpritesheetFramesResult } from "@/ux/modals/ImportSpritesheetFramesDialog/ImportSpritesheetFramesDialog";
import type { ExportAnimationFramesSettings } from "@/ux/modals/ExportAnimationFramesDialog/ExportAnimationFramesDialog";
import { exportPng } from "@/core/io/exportPng";
import { exportJpeg } from "@/core/io/exportJpeg";
import { exportWebp } from "@/core/io/exportWebp";
import { exportTga } from "@/core/io/exportTga";
import { exportTiff } from "@/core/io/exportTiff";
import { encodeAnimatedGif } from "@/core/io/encodeAnimatedGif";

interface UseSpritesheetAnimationOpsOptions {
  canvasHandleRef: { readonly current: CanvasHandle | null };
  stateRef: MutableRefObject<AppState>;
  captureHistory: (label: string) => void;
  dispatch: Dispatch<AppAction>;
}

export interface UseSpritesheetAnimationOpsReturn {
  handleImportSpritesheetFrames: (result: ImportSpritesheetFramesResult) => void;
  handleExportSpritesheetJson: () => Promise<void>;
  handleExportPaletteAnimationJson: () => Promise<void>;
  handleExportAnimationFrames: (
    settings: ExportAnimationFramesSettings,
    onProgress: (current: number, total: number) => void,
  ) => Promise<void>;
  handleCopyPrevFrame: (animationId: string, frameId: string) => void;
  handleCopyNextFrame: (animationId: string, frameId: string) => void;
}

export function useSpritesheetAnimationOps({
  canvasHandleRef,
  stateRef,
  captureHistory,
  dispatch,
}: UseSpritesheetAnimationOpsOptions): UseSpritesheetAnimationOpsReturn {
  const handleImportSpritesheetFrames = useCallback(
    (result: ImportSpritesheetFramesResult): void => {
      const handle = canvasHandleRef.current;
      if (!handle) return;
      const s = stateRef.current;
      const activeLayerId = s.activeLayerId;
      if (!activeLayerId) {
        showOperationError(
          "Could not import frames.",
          "No active layer to plot frames onto.",
        );
        return;
      }
      const cw = s.canvas.width;
      const ch = s.canvas.height;
      const { frames, frameWidth, frameHeight } = result;
      const merged =
        handle.getLayerPixels(activeLayerId) ?? new Uint8Array(cw * ch * 4);
      const cols = Math.max(1, Math.floor(cw / frameWidth));
      for (let i = 0; i < frames.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const dx = col * frameWidth;
        const dy = row * frameHeight;
        const src = frames[i];
        for (let y = 0; y < frameHeight; y++) {
          const cy = dy + y;
          if (cy < 0 || cy >= ch) continue;
          for (let x = 0; x < frameWidth; x++) {
            const cx = dx + x;
            if (cx < 0 || cx >= cw) continue;
            const si = (y * frameWidth + x) * 4;
            const di = (cy * cw + cx) * 4;
            merged[di] = src[si];
            merged[di + 1] = src[si + 1];
            merged[di + 2] = src[si + 2];
            merged[di + 3] = src[si + 3];
          }
        }
      }
      handle.writeLayerPixels(activeLayerId, merged);

      dispatch({
        type: "SET_SPRITESHEET",
        payload: {
          enabled: true,
          cellWidth: frameWidth,
          cellHeight: frameHeight,
        },
      });
      const newAnimId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const newFrames = frames.map(() => ({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        duration: 1,
      }));
      dispatch({
        type: "ADD_ANIMATION",
        payload: {
          id: newAnimId,
          name: "Imported Animation",
          fps: 12,
          playbackMode: "loop",
          frames: newFrames,
        },
      });
      dispatch({ type: "SET_SELECTED_ANIMATION", payload: newAnimId });
      if (newFrames.length > 0) {
        dispatch({ type: "SET_SELECTED_FRAME", payload: newFrames[0].id });
      }
    },
    [canvasHandleRef, dispatch, stateRef],
  );

  const handleExportSpritesheetJson = useCallback(async (): Promise<void> => {
    const s = stateRef.current;
    const ss = s.spritesheet;
    if (!ss.enabled || ss.animations.length === 0) {
      showOperationError(
        "Could not export spritesheet.",
        "Enable the spritesheet and add at least one animation first.",
      );
      return;
    }
    const cw = s.canvas.width;
    const ch = s.canvas.height;
    const cellW = Math.max(1, ss.cellWidth);
    const cellH = Math.max(1, ss.cellHeight);
    const cols = Math.max(1, Math.floor(cw / cellW));

    let cursor = 0;
    const animations = ss.animations.map((anim) => {
      const frames = anim.frames.map((f) => {
        const idx = cursor++;
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const x = col * cellW;
        const y = row * cellH;
        return {
          id: f.id,
          duration: f.duration,
          source: { x, y, width: cellW, height: cellH },
          // Half-texel inset prevents filtered samplers from bleeding in
          // from neighbouring cells.
          uv: {
            u0: (x + 0.5) / cw,
            v0: (y + 0.5) / ch,
            u1: (x + cellW - 0.5) / cw,
            v1: (y + cellH - 0.5) / ch,
          },
        };
      });
      return {
        id: anim.id,
        name: anim.name,
        fps: anim.fps,
        playbackMode: anim.playbackMode,
        frames,
      };
    });
    const doc = {
      version: 1,
      canvas: { width: cw, height: ch },
      cell: { width: cellW, height: cellH },
      animations,
    };

    const path = await window.api.saveJsonDialog("spritesheet.json");
    if (!path) return;
    try {
      await window.api.writeJsonFile(path, JSON.stringify(doc, null, 2));
    } catch (err) {
      showOperationError("Failed to export spritesheet JSON.", err);
    }
  }, [stateRef]);

  const handleExportPaletteAnimationJson = useCallback(async (): Promise<void> => {
    const s = stateRef.current;
    const pa = s.paletteAnimation;
    if (!pa.enabled) {
      showOperationError(
        "Could not export palette animation.",
        "Enable palette animation in the Animation panel first.",
      );
      return;
    }
    const cyclingGroups = s.swatchGroups.filter((g) => g.cycle?.enabled);
    if (cyclingGroups.length === 0) {
      showOperationError(
        "Could not export palette animation.",
        "Mark at least one swatch group as cycling in the Animation panel.",
      );
      return;
    }
    const doc = {
      version: 1,
      fps: pa.fps,
      palette: s.swatches.map((c) => ({ r: c.r, g: c.g, b: c.b, a: c.a })),
      groups: cyclingGroups.map((g) => ({
        id: g.id,
        name: g.name,
        indices: g.swatchIndices.slice(),
        cycle: {
          stepsPerStep: g.cycle?.stepsPerStep ?? 1,
          ticksPerStep: g.cycle?.ticksPerStep ?? 1,
        },
      })),
    };
    const path = await window.api.saveJsonDialog("palette-animation.json");
    if (!path) return;
    try {
      await window.api.writeJsonFile(path, JSON.stringify(doc, null, 2));
    } catch (err) {
      showOperationError("Failed to export palette animation JSON.", err);
    }
  }, [stateRef]);

  const handleExportAnimationFrames = useCallback(
    async (
      settings: ExportAnimationFramesSettings,
      onProgress: (current: number, total: number) => void,
    ): Promise<void> => {
      const handle = canvasHandleRef.current;
      if (!handle) return;
      const s = stateRef.current;
      const ss = s.spritesheet;
      const pa = s.paletteAnimation;
      if (!ss.enabled && !pa.enabled) {
        showOperationError(
          "Could not export animation frames.",
          "Enable Sprite Sheet or Palette Animation in the Animation panel first.",
        );
        return;
      }

      const sep = settings.folder.includes("\\") ? "\\" : "/";
      const ext =
        settings.format === "png"
          ? ".png"
          : settings.format === "jpeg"
            ? ".jpg"
            : settings.format === "webp"
              ? ".webp"
              : settings.format === "tga"
                ? ".tga"
                : settings.format === "gif"
                  ? ".gif"
                  : ".tif";
      const pad = (n: number, w: number): string => {
        const t = String(n);
        return t.length >= w ? t : "0".repeat(w - t.length) + t;
      };

      const isGif = settings.format === "gif";

      const encode = (
        data: Uint8Array,
        w: number,
        h: number,
      ): string => {
        if (settings.format === "png") return exportPng(data, w, h);
        if (settings.format === "jpeg")
          return exportJpeg(data, w, h, {
            quality: settings.jpegQuality,
            background: "#ffffff",
          });
        if (settings.format === "webp")
          return exportWebp(data, w, h, { quality: settings.webpQuality });
        if (settings.format === "tga") return exportTga(data, w, h);
        return exportTiff(data, w, h);
      };

      // GIF builds a single file at the end — buffer per-frame RGBA copies
      // plus their dims while the loops run.
      const gifFrames: Uint8Array[] = [];
      let gifW = 0;
      let gifH = 0;

      const writeFrame = async (
        i: number,
        data: Uint8Array,
        w: number,
        h: number,
      ): Promise<void> => {
        if (isGif) {
          // The buffer is reused across frames — copy before queuing.
          gifFrames.push(new Uint8Array(data));
          gifW = w;
          gifH = h;
          return;
        }
        const dataUrl = encode(data, w, h);
        const filename = `${settings.baseName}${pad(settings.startIndex + i, settings.padDigits)}${ext}`;
        const filePath = `${settings.folder}${sep}${filename}`;
        const base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");
        await window.api.exportImage(filePath, base64);
      };

      try {
        if (ss.enabled) {
          const selectedAnim =
            ss.animations.find((a) => a.id === ss.selectedAnimationId) ??
            ss.animations[0];
          if (!selectedAnim || selectedAnim.frames.length === 0) {
            showOperationError(
              "Could not export animation frames.",
              "Select an animation with at least one frame.",
            );
            return;
          }
          const cellW = Math.max(1, ss.cellWidth);
          const cellH = Math.max(1, ss.cellHeight);
          const cw = s.canvas.width;
          const ch = s.canvas.height;
          const cols = Math.max(1, Math.floor(cw / cellW));
          let animStart = 0;
          for (const a of ss.animations) {
            if (a.id === selectedAnim.id) break;
            animStart += a.frames.length;
          }

          // Rasterise the whole canvas once — adjustments / effects / filters
          // get baked in — then crop each cell out of the result.
          const flat = await handle.rasterizeLayers(s.layers, "export");
          const fullPixels: Uint8Array =
            flat.data instanceof Float32Array
              ? clampF32ToUint8(flat.data)
              : flat.data;

          for (let i = 0; i < selectedAnim.frames.length; i++) {
            const globalIdx = animStart + i;
            const col = globalIdx % cols;
            const row = Math.floor(globalIdx / cols);
            const x = col * cellW;
            const y = row * cellH;
            const cropped = new Uint8Array(cellW * cellH * 4);
            for (let yy = 0; yy < cellH; yy++) {
              const cy = y + yy;
              if (cy < 0 || cy >= ch) continue;
              const srcStart = (cy * cw + x) * 4;
              const srcEnd = srcStart + cellW * 4;
              cropped.set(
                fullPixels.subarray(srcStart, srcEnd),
                yy * cellW * 4,
              );
            }
            await writeFrame(i, cropped, cellW, cellH);
            onProgress(i + 1, selectedAnim.frames.length);
          }
        } else {
          // Palette animation path: each frame is one tick of the palette
          // cycle. Only the swatch groups picked in the dialog participate;
          // others stay static. Two evaluation modes:
          //   parallel   — every selected group cycles together for
          //                lcm(periods) frames.
          //   sequential — each selected group plays its own period in turn
          //                while the others stay at tick 0.
          const selected = new Set(settings.selectedPaletteGroupIds);
          const cw = s.canvas.width;
          const ch = s.canvas.height;
          const savedTick = paletteCycleStore.tick;

          const groupsActiveOn = (activeIds: Set<string>) =>
            s.swatchGroups.map((g) =>
              !g.cycle?.enabled || activeIds.has(g.id)
                ? g
                : { ...g, cycle: { ...g.cycle, enabled: false } },
            );

          if (settings.paletteCycleEvaluation === "sequential") {
            const sequence: { groupId: string; period: number }[] = [];
            let total = 0;
            for (const g of s.swatchGroups) {
              if (!g.cycle?.enabled || !selected.has(g.id)) continue;
              const p = paletteCyclePeriod([g]);
              if (p === 0) continue;
              sequence.push({ groupId: g.id, period: p });
              total += p;
            }
            if (total === 0) {
              showOperationError(
                "Could not export palette animation.",
                selected.size === 0
                  ? "Select at least one cycling group in the export dialog."
                  : "Mark at least one swatch group as cycling in the Animation panel.",
              );
              return;
            }
            let frameIdx = 0;
            for (const seg of sequence) {
              const segGroups = groupsActiveOn(new Set([seg.groupId]));
              for (let i = 0; i < seg.period; i++) {
                paletteCycleStore.set(i);
                const eff = computeEffectivePalette(s.swatches, segGroups, i);
                handle.repaintIndexedLayers(eff);
                const flat = await handle.rasterizeLayers(s.layers, "export");
                const fullPixels: Uint8Array =
                  flat.data instanceof Float32Array
                    ? clampF32ToUint8(flat.data)
                    : flat.data;
                await writeFrame(frameIdx, fullPixels, cw, ch);
                frameIdx++;
                onProgress(frameIdx, total);
              }
            }
          } else {
            const exportGroups = groupsActiveOn(selected);
            const period = paletteCyclePeriod(exportGroups);
            if (period === 0) {
              showOperationError(
                "Could not export palette animation.",
                selected.size === 0
                  ? "Select at least one cycling group in the export dialog."
                  : "Mark at least one swatch group as cycling in the Animation panel.",
              );
              return;
            }
            for (let i = 0; i < period; i++) {
              paletteCycleStore.set(i);
              const eff = computeEffectivePalette(s.swatches, exportGroups, i);
              handle.repaintIndexedLayers(eff);
              const flat = await handle.rasterizeLayers(s.layers, "export");
              const fullPixels: Uint8Array =
                flat.data instanceof Float32Array
                  ? clampF32ToUint8(flat.data)
                  : flat.data;
              await writeFrame(i, fullPixels, cw, ch);
              onProgress(i + 1, period);
            }
          }

          // Restore the cycle position the user was at, with the full
          // (un-trimmed) group set so the on-canvas preview returns to
          // exactly what it was before the export ran.
          paletteCycleStore.set(savedTick);
          handle.repaintIndexedLayers(
            computeEffectivePalette(s.swatches, s.swatchGroups, savedTick),
          );
        }

        if (isGif && gifFrames.length > 0) {
          const bytes = encodeAnimatedGif({
            frames: gifFrames,
            width: gifW,
            height: gifH,
            fps: settings.gifFps,
          });
          // exportImage expects base64; build it from the raw bytes, chunked
          // to avoid `Maximum call stack size exceeded` from
          // String.fromCharCode(...largeArray).
          let bin = "";
          const CHUNK = 8192;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(
              null,
              Array.from(bytes.subarray(i, i + CHUNK)),
            );
          }
          const base64 = btoa(bin);
          const filename = `${settings.baseName}${ext}`;
          const filePath = `${settings.folder}${sep}${filename}`;
          await window.api.exportImage(filePath, base64);
        }
      } catch (err) {
        console.error("[handleExportAnimationFrames]", err);
        showOperationError("Failed to export animation frames.", err);
      }
    },
    [canvasHandleRef, stateRef],
  );

  const copyFrameCell = useCallback(
    (
      animationId: string,
      frameId: string,
      offset: -1 | 1,
      label: string,
    ): void => {
      const s = stateRef.current;
      const ss = s.spritesheet;
      const anim = ss.animations.find((a) => a.id === animationId);
      if (!anim) return;
      const fi = anim.frames.findIndex((f) => f.id === frameId);
      if (fi < 0) return;
      const srcFi = fi + offset;
      if (srcFi < 0 || srcFi >= anim.frames.length) return;
      const cellW = Math.max(1, ss.cellWidth);
      const cellH = Math.max(1, ss.cellHeight);
      const cols = Math.max(1, Math.floor(s.canvas.width / cellW));
      let animStart = 0;
      for (const a of ss.animations) {
        if (a.id === animationId) break;
        animStart += a.frames.length;
      }
      const srcIdx = animStart + srcFi;
      const dstIdx = animStart + fi;
      const srcX = (srcIdx % cols) * cellW;
      const srcY = Math.floor(srcIdx / cols) * cellH;
      const dstX = (dstIdx % cols) * cellW;
      const dstY = Math.floor(dstIdx / cols) * cellH;
      captureHistory(label);
      canvasHandleRef.current?.copyCellRect(
        srcX,
        srcY,
        dstX,
        dstY,
        cellW,
        cellH,
      );
    },
    [stateRef, captureHistory, canvasHandleRef],
  );

  const handleCopyPrevFrame = useCallback(
    (animationId: string, frameId: string) =>
      copyFrameCell(animationId, frameId, -1, "Copy From Previous Frame"),
    [copyFrameCell],
  );

  const handleCopyNextFrame = useCallback(
    (animationId: string, frameId: string) =>
      copyFrameCell(animationId, frameId, 1, "Copy From Next Frame"),
    [copyFrameCell],
  );

  return {
    handleImportSpritesheetFrames,
    handleExportSpritesheetJson,
    handleExportPaletteAnimationJson,
    handleExportAnimationFrames,
    handleCopyPrevFrame,
    handleCopyNextFrame,
  };
}
