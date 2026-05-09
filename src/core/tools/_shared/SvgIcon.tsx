import React from "react";

/**
 * Inflates a raw SVG string (loaded via `?raw`) into a sized inline element
 * that fills its container. Used by tools whose icon ships as an asset.
 */
export function SvgIcon({ src }: { src: string }): React.JSX.Element {
  const svg = src
    .replace(/width="\d+(\.\d+)?"/, 'width="100%"')
    .replace(/height="\d+(\.\d+)?"/, 'height="100%"');
  return (
    <span
      style={{ display: "block", width: "100%", height: "100%" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * Wraps an inline `<svg>` element in the same fill-container box as
 * `SvgIcon`, so asset-icons and inline-icons render identically in
 * the toolbar.
 */
export function InlineIcon({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span style={{ display: "block", width: "100%", height: "100%" }}>
      {children}
    </span>
  );
}
