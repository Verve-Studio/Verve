import React from "react";
import type { TimeOfDay } from "@/utils/paletteGenerators";
import styles from "./TimeOfDayIcon.module.scss";

/** Small glyph per time of day: sunrise, sun, sunset, moon. */
export function TimeOfDayIcon({ mode }: { mode: TimeOfDay }): React.JSX.Element {
  const common = {
    className: styles.icon,
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.3,
    strokeLinecap: "round" as const,
    "aria-hidden": true,
  };
  switch (mode) {
    case "dawn":
      return (
        <svg {...common}>
          <path d="M3 12a5 5 0 0 1 10 0" />
          <path d="M1 12h14M8 3v2M3.2 6.2l1.2 1.2M12.8 6.2l-1.2 1.2" />
          <path d="M6 1.8L8 0.6l2 1.2" />
        </svg>
      );
    case "day":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13" />
        </svg>
      );
    case "dusk":
      return (
        <svg {...common}>
          <path d="M3 12a5 5 0 0 1 10 0" />
          <path d="M1 12h14M8 3v2M3.2 6.2l1.2 1.2M12.8 6.2l-1.2 1.2" />
          <path d="M6 14.2L8 15.4l2-1.2" />
        </svg>
      );
    case "night":
      return (
        <svg {...common}>
          <path d="M13 10.5A6 6 0 0 1 5.5 3a6 6 0 1 0 7.5 7.5z" />
        </svg>
      );
  }
}
