import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useSyncExternalStore,
} from "react";
import type { Dispatch } from "react";
import type { AppAction } from "@/core/store/AppContext";
import type { AppState, AnimationDef } from "@/types";
import {
  computeEffectivePalette,
  paletteCycleStore,
  paletteCyclePeriod,
} from "@/core/store/paletteCycleStore";
import type { CanvasHandle } from "@/ux/main/Canvas/Canvas";

// ─── Public interface ──────────────────────────────────────────────────────────

export interface AnimationPlayback {
  isPlaying: boolean;
  isLooping: boolean;
  /** 0-based index of the displayed frame within the selected animation. */
  currentFrameIdx: number;
  selectedAnim: AnimationDef | null;
  /** 0-based tick within the palette-cycle period (palette mode only). */
  paletteFrameIdx: number;
  /** Total number of ticks before every cycling group returns to start. */
  paletteTotalFrames: number;
  onPlayPause: () => void;
  onLoopToggle: () => void;
  onPrevFrame: () => void;
  onNextFrame: () => void;
  onPrevAnimation: () => void;
  onNextAnimation: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAnimationPlayback(
  state: AppState,
  dispatch: Dispatch<AppAction>,
  canvasHandleRef: { readonly current: CanvasHandle | null },
): AnimationPlayback {
  const ss = state.spritesheet;

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [currentFrameIdx, setCurrentFrameIdx] = useState(0);

  // ── Refs for use inside interval callbacks (avoid stale closures) ──────────
  const isPlayingRef = useRef(false);
  const isLoopingRef = useRef(false);
  const currentFrameIdxRef = useRef(0);
  const directionRef = useRef<1 | -1>(1); // ping-pong direction
  const tickRef = useRef(0); // ticks elapsed on current frame
  // Tracks ping-pong "return leg done" flag (for non-looping ping-pong)
  const ppReturnedRef = useRef(false);

  // Keep refs in sync with state
  isPlayingRef.current = isPlaying;
  isLoopingRef.current = isLooping;

  const selectedAnim =
    ss.animations.find((a) => a.id === ss.selectedAnimationId) ??
    ss.animations[0] ??
    null;

  const selectedAnimRef = useRef<AnimationDef | null>(selectedAnim);
  selectedAnimRef.current = selectedAnim;

  // ── Reset everything when the selected animation changes ──────────────────
  const prevAnimIdRef = useRef(ss.selectedAnimationId);
  useEffect(() => {
    if (ss.selectedAnimationId === prevAnimIdRef.current) return;
    prevAnimIdRef.current = ss.selectedAnimationId;
    setIsPlaying(false);
    setCurrentFrameIdx(0);
    currentFrameIdxRef.current = 0;
    directionRef.current = 1;
    tickRef.current = 0;
    ppReturnedRef.current = false;
    const anim = ss.animations.find((a) => a.id === ss.selectedAnimationId);
    if (anim?.frames[0]) {
      dispatch({ type: "SET_SELECTED_FRAME", payload: anim.frames[0].id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ss.selectedAnimationId]);

  // ── Sync from external frame-panel clicks (only when paused) ─────────────
  const lastDispatchedFrameIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (isPlayingRef.current) return;
    if (!selectedAnim || !ss.selectedFrameId) return;
    if (ss.selectedFrameId === lastDispatchedFrameIdRef.current) return;
    const fi = selectedAnim.frames.findIndex(
      (f) => f.id === ss.selectedFrameId,
    );
    if (fi >= 0 && fi !== currentFrameIdxRef.current) {
      setCurrentFrameIdx(fi);
      currentFrameIdxRef.current = fi;
      tickRef.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ss.selectedFrameId]);

  // ── Helper: go to a specific frame index in an animation ─────────────────
  const goToFrame = useCallback(
    (anim: AnimationDef, idx: number): void => {
      const frame = anim.frames[idx];
      if (!frame) return;
      currentFrameIdxRef.current = idx;
      tickRef.current = 0;
      setCurrentFrameIdx(idx);
      lastDispatchedFrameIdRef.current = frame.id;
      dispatch({ type: "SET_SELECTED_FRAME", payload: frame.id });
    },
    [dispatch],
  );

  // ── Core advance: called each tick by the interval ────────────────────────
  const advanceTick = useCallback((): void => {
    const anim = selectedAnimRef.current;
    if (!anim || anim.frames.length === 0) return;

    const len = anim.frames.length;
    const mode = anim.playbackMode;
    const looping = isLoopingRef.current;
    const idx = currentFrameIdxRef.current;
    const frame = anim.frames[idx];
    const duration = Math.max(1, frame?.duration ?? 1);

    tickRef.current++;
    if (tickRef.current < duration) return; // still showing this frame

    tickRef.current = 0;

    if (mode === "one-shot") {
      // One-shot always plays once and stops — looping flag has no effect
      if (idx >= len - 1) {
        setIsPlaying(false);
        return;
      }
      goToFrame(anim, idx + 1);
    } else if (mode === "loop") {
      if (looping) {
        goToFrame(anim, (idx + 1) % len);
      } else {
        // One iteration: stop at last frame
        if (idx >= len - 1) {
          setIsPlaying(false);
          return;
        }
        goToFrame(anim, idx + 1);
      }
    } else {
      // ping-pong
      const dir = directionRef.current;
      const next = idx + dir;

      if (next >= len) {
        // Hit the forward end → reverse
        directionRef.current = -1;
        if (len <= 1) {
          setIsPlaying(false);
          return;
        }
        if (!looping) ppReturnedRef.current = true; // started return leg
        goToFrame(anim, len - 2);
      } else if (next < 0) {
        // Hit the backward end
        if (looping) {
          directionRef.current = 1;
          if (len <= 1) {
            setIsPlaying(false);
            return;
          }
          goToFrame(anim, 1);
        } else {
          // Done one full cycle (0→end→0) — stop
          directionRef.current = 1;
          ppReturnedRef.current = false;
          setIsPlaying(false);
          goToFrame(anim, 0);
        }
      } else {
        goToFrame(anim, next);
      }
    }
  }, [goToFrame]);

  // ── Interval: ticks at animation fps ─────────────────────────────────────
  useEffect(() => {
    if (!isPlaying || !selectedAnim || selectedAnim.frames.length === 0) return;
    const fps = Math.max(1, selectedAnim.fps);
    const interval = Math.round(1000 / fps);
    const id = setInterval(advanceTick, interval);
    return () => clearInterval(id);
    // Restart when playing state or fps changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, selectedAnim?.fps, selectedAnim?.id, advanceTick]);

  // ── Palette animation: virtual cycle of indexed8 palette ────────────────
  // When palette animation is enabled and play is active, tick a counter at
  // the configured fps and re-flush every indexed8 layer with the cycled
  // palette. The underlying state.swatches is never mutated.
  const paletteEnabled = state.paletteAnimation.enabled;
  const paletteFps = Math.max(1, state.paletteAnimation.fps);
  const swatches = state.swatches;
  const swatchGroups = state.swatchGroups;
  const swatchesRef = useRef(swatches);
  const swatchGroupsRef = useRef(swatchGroups);
  swatchesRef.current = swatches;
  swatchGroupsRef.current = swatchGroups;
  const repaint = useCallback(
    (tick: number): void => {
      const handle = canvasHandleRef.current;
      if (!handle) return;
      const eff = computeEffectivePalette(
        swatchesRef.current,
        swatchGroupsRef.current,
        tick,
      );
      handle.repaintIndexedLayers(eff);
    },
    [canvasHandleRef],
  );
  // Total period of the active palette cycle (LCM across cycling groups).
  // 0 when nothing is cycling (or palette mode is off).
  const palettePeriod = paletteEnabled
    ? paletteCyclePeriod(swatchGroups)
    : 0;
  const palettePeriodRef = useRef(palettePeriod);
  palettePeriodRef.current = palettePeriod;

  useEffect(() => {
    if (!paletteEnabled || !isPlaying) return;
    const interval = Math.round(1000 / paletteFps);
    const id = setInterval(() => {
      const nextTick = paletteCycleStore.tick + 1;
      const period = palettePeriodRef.current;
      // Honour the loop toggle in palette mode: when looping is off, stop
      // playback at the end of one full cycle and snap back to tick 0.
      if (!isLoopingRef.current && period > 0 && nextTick >= period) {
        paletteCycleStore.set(0);
        repaint(0);
        setIsPlaying(false);
        return;
      }
      paletteCycleStore.set(nextTick);
      repaint(nextTick);
    }, interval);
    return () => clearInterval(id);
  }, [paletteEnabled, isPlaying, paletteFps, repaint]);

  // Subscribe to palette-cycle ticks so the playback bar's frame readout
  // updates live during playback. (The repaint above already keeps pixels in
  // sync; this is just to drive React re-renders.)
  const paletteTick = useSyncExternalStore(
    (cb) => paletteCycleStore.subscribe(cb),
    () => paletteCycleStore.tick,
  );

  // Default the loop toggle to ON the moment palette mode becomes active so
  // the bar reflects palette animation's natural cyclic behaviour.  Switching
  // back out of palette mode resets to OFF so spritesheet playback uses its
  // normal default.
  const wasPaletteEnabledRef = useRef(paletteEnabled);
  useEffect(() => {
    if (paletteEnabled && !wasPaletteEnabledRef.current) {
      setIsLooping(true);
    } else if (!paletteEnabled && wasPaletteEnabledRef.current) {
      setIsLooping(false);
    }
    wasPaletteEnabledRef.current = paletteEnabled;
  }, [paletteEnabled]);

  // Re-flush whenever palette-anim toggles, the cycle config changes, or
  // the swatch list changes — keeps the displayed colours in sync without
  // waiting for the next tick.
  useEffect(() => {
    if (paletteEnabled) {
      repaint(paletteCycleStore.tick);
    } else {
      // Restore original palette when the feature is turned off.
      paletteCycleStore.reset();
      repaint(0);
    }
  }, [paletteEnabled, swatches, swatchGroups, repaint]);

  // ── Manual navigation ──────────────────────────────────────────────────────

  const paletteEnabledRef = useRef(paletteEnabled);
  paletteEnabledRef.current = paletteEnabled;

  const handlePrevFrame = useCallback((): void => {
    if (paletteEnabledRef.current) {
      // In palette-animation mode "Previous Frame" steps the palette
      // cycle one tick backward and repaints with the cycled palette.
      // Pause the cycle so the manual step is preserved.
      setIsPlaying(false);
      const next = paletteCycleStore.tick - 1;
      paletteCycleStore.set(next);
      repaint(paletteCycleStore.tick);
      return;
    }
    const anim = selectedAnimRef.current;
    if (!anim || anim.frames.length === 0) return;
    const len = anim.frames.length;
    const mode = anim.playbackMode;
    const idx = currentFrameIdxRef.current;
    let next = idx - 1;

    if (mode === "loop") {
      next = (next + len) % len;
    } else if (mode === "one-shot") {
      next = Math.max(0, next);
    } else {
      // ping-pong: at frame 0, flip direction and stay
      if (next < 0) {
        directionRef.current = 1;
        next = 0;
      }
    }

    goToFrame(anim, next);
    setIsPlaying(false);
  }, [goToFrame, repaint]);

  const handleNextFrame = useCallback((): void => {
    if (paletteEnabledRef.current) {
      setIsPlaying(false);
      paletteCycleStore.set(paletteCycleStore.tick + 1);
      repaint(paletteCycleStore.tick);
      return;
    }
    const anim = selectedAnimRef.current;
    if (!anim || anim.frames.length === 0) return;
    const len = anim.frames.length;
    const mode = anim.playbackMode;
    const idx = currentFrameIdxRef.current;
    let next = idx + 1;

    if (mode === "loop") {
      next = next % len;
    } else if (mode === "one-shot") {
      next = Math.min(len - 1, next);
    } else {
      // ping-pong: at last frame, flip direction and stay
      if (next >= len) {
        directionRef.current = -1;
        next = len - 1;
      }
    }

    goToFrame(anim, next);
    setIsPlaying(false);
  }, [goToFrame, repaint]);

  const handlePrevAnimation = useCallback((): void => {
    // No-op in palette mode (UI gates the button as well).
    if (paletteEnabledRef.current) return;
    const anims = ss.animations;
    if (anims.length === 0) return;
    const currentIdx = anims.findIndex((a) => a.id === ss.selectedAnimationId);
    const currentAnim = anims[currentIdx];

    if (currentAnim && currentFrameIdxRef.current > 0) {
      // Not at frame 0 yet — reset to beginning of current animation
      goToFrame(currentAnim, 0);
      setIsPlaying(false);
      return;
    }

    // At frame 0 — go to previous animation
    const prevIdx = currentIdx - 1;
    if (prevIdx < 0) return;
    const prevAnim = anims[prevIdx];
    setIsPlaying(false);
    currentFrameIdxRef.current = 0;
    directionRef.current = 1;
    tickRef.current = 0;
    ppReturnedRef.current = false;
    dispatch({ type: "SET_SELECTED_ANIMATION", payload: prevAnim.id });
    // goToFrame will run after the selectedAnimationId effect resets position
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ss.animations, ss.selectedAnimationId, goToFrame, dispatch]);

  const handleNextAnimation = useCallback((): void => {
    if (paletteEnabledRef.current) return;
    const anims = ss.animations;
    if (anims.length === 0) return;
    const currentIdx = anims.findIndex((a) => a.id === ss.selectedAnimationId);
    const nextIdx = currentIdx + 1;
    if (nextIdx >= anims.length) return;
    setIsPlaying(false);
    currentFrameIdxRef.current = 0;
    directionRef.current = 1;
    tickRef.current = 0;
    ppReturnedRef.current = false;
    dispatch({ type: "SET_SELECTED_ANIMATION", payload: anims[nextIdx].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ss.animations, ss.selectedAnimationId, dispatch]);

  const handlePlayPause = useCallback((): void => {
    setIsPlaying((prev) => {
      const next = !prev;
      if (next) {
        // Reset ping-pong return flag when starting fresh from the last frame
        const anim = selectedAnimRef.current;
        if (anim && anim.playbackMode === "ping-pong") {
          const len = anim.frames.length;
          if (currentFrameIdxRef.current === 0) {
            directionRef.current = 1;
            ppReturnedRef.current = false;
          } else if (currentFrameIdxRef.current >= len - 1) {
            directionRef.current = -1;
            ppReturnedRef.current = !isLoopingRef.current; // one-cycle: already on return leg
          }
        }
        tickRef.current = 0;
      }
      return next;
    });
  }, []);

  const handleLoopToggle = useCallback((): void => {
    setIsLooping((prev) => !prev);
  }, []);

  // 0-based position within the current cycle period (clamps at 0 when
  // nothing is cycling so the bar still reads "0 of 0").
  const paletteFrameIdx =
    palettePeriod > 0 ? paletteTick % palettePeriod : 0;

  return {
    isPlaying,
    isLooping,
    currentFrameIdx,
    selectedAnim,
    paletteFrameIdx,
    paletteTotalFrames: palettePeriod,
    onPlayPause: handlePlayPause,
    onLoopToggle: handleLoopToggle,
    onPrevFrame: handlePrevFrame,
    onNextFrame: handleNextFrame,
    onPrevAnimation: handlePrevAnimation,
    onNextAnimation: handleNextAnimation,
  };
}
