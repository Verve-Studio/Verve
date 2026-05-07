import React from "react";
import styles from "./PlaybackBar.module.scss";

// ─── Icons ────────────────────────────────────────────────────────────────────

function IconPrevAnim(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
      <polygon points="2,2 2,14 4,14 4,2" />
      <polygon points="14,2 6,8 14,14" />
    </svg>
  );
}

function IconPrevFrame(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
      <polygon points="2,8 10,2 10,14" />
      <rect x="11" y="2" width="3" height="12" />
    </svg>
  );
}

function IconPlay(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
      <polygon points="3,2 13,8 3,14" />
    </svg>
  );
}

function IconPause(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
      <rect x="3" y="2" width="4" height="12" />
      <rect x="9" y="2" width="4" height="12" />
    </svg>
  );
}

function IconNextFrame(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
      <rect x="2" y="2" width="3" height="12" />
      <polygon points="14,8 6,2 6,14" />
    </svg>
  );
}

function IconNextAnim(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
      <polygon points="2,2 10,8 2,14" />
      <polygon points="12,2 12,14 14,14 14,2" />
    </svg>
  );
}

function IconLoop(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 8 C2 4.7 4.7 2 8 2 L11 2" />
      <polyline points="9,0 11,2 9,4" />
      <path d="M14 8 C14 11.3 11.3 14 8 14 L5 14" />
      <polyline points="7,12 5,14 7,16" />
    </svg>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface PlaybackBarProps {
  isPlaying: boolean;
  isLooping: boolean;
  currentFrame: number;
  totalFrames: number;
  onPrevAnimation: () => void;
  onPrevFrame: () => void;
  onPlayPause: () => void;
  onNextFrame: () => void;
  onNextAnimation: () => void;
  onLoopToggle: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PlaybackBar({
  isPlaying,
  isLooping,
  currentFrame,
  totalFrames,
  onPrevAnimation,
  onPrevFrame,
  onPlayPause,
  onNextFrame,
  onNextAnimation,
  onLoopToggle,
}: PlaybackBarProps): React.JSX.Element {
  return (
    <div className={styles.playbackBar}>
      <div className={styles.controls}>
        <button
          className={styles.btn}
          title="Previous Animation"
          aria-label="Previous Animation"
          onClick={onPrevAnimation}
        >
          <IconPrevAnim />
        </button>
        <button
          className={styles.btn}
          title="Previous Frame"
          aria-label="Previous Frame"
          onClick={onPrevFrame}
        >
          <IconPrevFrame />
        </button>
        <button
          className={`${styles.btn} ${styles.playBtn}`}
          title={isPlaying ? "Pause" : "Play"}
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={onPlayPause}
        >
          {isPlaying ? <IconPause /> : <IconPlay />}
        </button>
        <button
          className={styles.btn}
          title="Next Frame"
          aria-label="Next Frame"
          onClick={onNextFrame}
        >
          <IconNextFrame />
        </button>
        <button
          className={styles.btn}
          title="Next Animation"
          aria-label="Next Animation"
          onClick={onNextAnimation}
        >
          <IconNextAnim />
        </button>
        <button
          className={`${styles.btn} ${isLooping ? styles.btnActive : ""}`}
          title={isLooping ? "Loop: On" : "Loop: Off"}
          aria-label={isLooping ? "Loop: On" : "Loop: Off"}
          aria-pressed={isLooping}
          onClick={onLoopToggle}
        >
          <IconLoop />
        </button>
      </div>
      <div className={styles.frameInfo}>
        <span className={styles.frameLabel}>
          Frame {currentFrame} of {totalFrames}
        </span>
      </div>
    </div>
  );
}
