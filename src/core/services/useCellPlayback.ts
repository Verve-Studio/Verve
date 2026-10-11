import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState } from "@/types";
import type { CellAnimationCommands } from "@/core/services/useCellAnimation";
import { cellPlaybackStore } from "@/core/store/cellPlaybackStore";
import { cellPreviewStore } from "@/core/store/cellPreviewStore";
import { cellFramePath } from "@/core/io/cellAnimationFiles";

/**
 * Cell animation playback. Playing shows the frames' previews over the
 * canvas (see `cellPlaybackStore`); the document stays on the frame it was
 * on. Pausing, stopping or stepping loads the frame landed on onto the
 * canvas so it can be edited.
 */
export interface CellPlayback {
  isPlaying: boolean;
  isLooping: boolean;
  play(): void;
  pause(): void;
  togglePlay(): void;
  /** Stop and go back to the first frame. */
  stop(): void;
  nextFrame(): void;
  prevFrame(): void;
  /** First frame. */
  rewind(): void;
  /** Last frame. */
  toEnd(): void;
  toggleLoop(): void;
}

interface UseCellPlaybackOptions {
  getState: () => AppState;
  cell: CellAnimationCommands;
  /** Playback stops when the active document changes. */
  activeTabId: string;
  /** …or cell animation / animation mode is turned off. */
  active: boolean;
}

export function useCellPlayback({
  getState,
  cell,
  activeTabId,
  active,
}: UseCellPlaybackOptions): CellPlayback {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(true);
  const loopingRef = useRef(isLooping);
  loopingRef.current = isLooping;
  const cellRef = useRef(cell);
  cellRef.current = cell;
  const rafRef = useRef<number | null>(null);

  const frames = useCallback(() => getState().cellAnimation.frames, [getState]);

  const currentIndex = useCallback((): number => {
    const s = getState().cellAnimation;
    if (cellPlaybackStore.snapshot.showing) return cellPlaybackStore.snapshot.index;
    return Math.max(0, s.frames.findIndex((f) => f.id === s.currentFrameId));
  }, [getState]);

  const hasPreview = useCallback(
    (index: number): boolean => {
      const s = getState().cellAnimation;
      const f = s.frames[index];
      return !!s.folder && !!f && cellPreviewStore.has(cellFramePath(s.folder, f));
    },
    [getState],
  );

  const stopClock = useCallback((): void => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setIsPlaying(false);
    cellPlaybackStore.update({ playing: false });
  }, []);

  /** Load frame `index` onto the canvas, showing its preview meanwhile. */
  const land = useCallback(
    (index: number): void => {
      const f = frames()[index];
      if (!f) {
        cellPlaybackStore.update({ showing: false });
        return;
      }
      if (f.id === getState().cellAnimation.currentFrameId) {
        cellPlaybackStore.update({ showing: false, index });
        return;
      }
      cellPlaybackStore.update({ showing: hasPreview(index), index });
      void cellRef.current.goToFrame(f.id).finally(() => {
        // A newer step may have moved on; only hide the overlay for ours.
        if (!cellPlaybackStore.snapshot.playing && cellPlaybackStore.snapshot.index === index) {
          cellPlaybackStore.update({ showing: false });
        }
      });
      cellRef.current.selectFrames([f.id]);
    },
    [frames, getState, hasPreview],
  );

  const pause = useCallback((): void => {
    if (!cellPlaybackStore.snapshot.playing) return;
    stopClock();
    land(cellPlaybackStore.snapshot.index);
  }, [stopClock, land]);

  const play = useCallback((): void => {
    if (cellPlaybackStore.snapshot.playing) return;
    const list = frames();
    if (list.length === 0) return;
    let index = currentIndex();
    // At the end of a non-looping run, play again from the start.
    if (!loopingRef.current && index >= list.length - 1) index = 0;
    setIsPlaying(true);
    cellPlaybackStore.update({ playing: true, showing: true, index });

    void cellRef.current.refreshCurrentPreview().then(() => {
      if (!cellPlaybackStore.snapshot.playing) return;
      let last = performance.now();
      let elapsed = 0;
      const step = (now: number): void => {
        if (!cellPlaybackStore.snapshot.playing) return;
        const s = getState().cellAnimation;
        const tickMs = 1000 / Math.max(1, s.fps);
        elapsed += now - last;
        last = now;
        let i = cellPlaybackStore.snapshot.index;
        // Advance through as many frames as the elapsed time covers.
        for (;;) {
          const f = s.frames[i];
          if (!f) {
            i = 0;
            break;
          }
          const frameMs = tickMs * Math.max(1, f.duration);
          if (elapsed < frameMs) break;
          elapsed -= frameMs;
          if (i + 1 < s.frames.length) {
            i++;
          } else if (loopingRef.current) {
            i = 0;
          } else {
            cellPlaybackStore.update({ index: i });
            stopClock();
            land(i);
            return;
          }
        }
        cellPlaybackStore.update({ index: i });
        rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    });
  }, [frames, currentIndex, getState, stopClock, land]);

  const goTo = useCallback(
    (index: (cur: number, len: number) => number): void => {
      const len = frames().length;
      if (len === 0) return;
      const cur = currentIndex();
      stopClock();
      land(Math.max(0, Math.min(len - 1, index(cur, len))));
    },
    [frames, currentIndex, stopClock, land],
  );

  // Stop (without loading anything) when the document or mode changes.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      setIsPlaying(false);
      cellPlaybackStore.update({ playing: false, showing: false });
    };
  }, [activeTabId, active]);

  return useMemo(
    (): CellPlayback => ({
      isPlaying,
      isLooping,
      play,
      pause,
      togglePlay: () => (cellPlaybackStore.snapshot.playing ? pause() : play()),
      stop: () => goTo(() => 0),
      nextFrame: () =>
        goTo((cur, len) => (cur + 1 < len ? cur + 1 : loopingRef.current ? 0 : cur)),
      prevFrame: () =>
        goTo((cur, len) => (cur > 0 ? cur - 1 : loopingRef.current ? len - 1 : 0)),
      rewind: () => goTo(() => 0),
      toEnd: () => goTo((_cur, len) => len - 1),
      toggleLoop: () => setIsLooping((v) => !v),
    }),
    [isPlaying, isLooping, play, pause, goTo],
  );
}
