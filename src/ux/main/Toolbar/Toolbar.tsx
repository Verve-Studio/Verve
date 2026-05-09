import { useAppContext } from "@/core/store/AppContext";
import type { RGBAColor, Tool } from "@/types";
import { ColorPickerDialog } from "@/ux/modals/ColorPickerDialog/ColorPickerDialog";
import { IndexedPaletteColorPicker } from "@/ux/widgets/IndexedPaletteColorPicker/IndexedPaletteColorPicker";
// Side-effect import: registers every tool in `toolRegistry` on first load.
import "@/tools";
import { toolRegistry } from "@/tools/toolRegistry";
import type { ITool } from "@/tools";
import React, { useState } from "react";
import styles from "./Toolbar.module.scss";

// ─── Component ────────────────────────────────────────────────────────────────

interface ToolbarProps {
  activeTool?: Tool;
  onToolChange?: (tool: Tool) => void;
}

/**
 * Generic per-tool toolbar button. Tools opt out by exposing `customRender`
 * (the shape tool uses this for its caret + flyout).
 */
function StandardToolButton({
  tool,
  active,
  disabled,
  onActivate,
}: {
  tool: ITool;
  active: boolean;
  disabled: boolean;
  onActivate: () => void;
}): React.JSX.Element {
  const labelText = tool.shortcut
    ? `${tool.label}  (${tool.shortcut})`
    : tool.label;
  const titleText = tool.shortcut
    ? `${tool.label}  ${tool.shortcut}`
    : tool.label;
  return (
    <button
      className={`${styles.toolBtn} ${active ? styles.active : ""}`}
      onClick={onActivate}
      disabled={disabled}
      aria-label={labelText}
      aria-pressed={active}
      title={titleText}
    >
      {tool.icon}
    </button>
  );
}

export function Toolbar({
  activeTool = "pencil",
  onToolChange,
}: ToolbarProps): React.JSX.Element {
  const { state, dispatch } = useAppContext();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTarget, setDialogTarget] = useState<"fg" | "bg">("fg");
  const [dialogIsSwatchAdd, setDialogIsSwatchAdd] = useState(false);
  const [indexedPickerTarget, setIndexedPickerTarget] = useState<
    "fg" | "bg" | null
  >(null);
  const [indexedPickerAnchor, setIndexedPickerAnchor] = useState<{
    x: number;
    y: number;
  }>({ x: 0, y: 0 });

  const activeLayer =
    state.layers.find((l) => l.id === state.activeLayerId) ?? null;
  const pixelToolsDisabled =
    activeLayer == null ||
    ("type" in activeLayer && activeLayer.type !== "mask");
  const indexedModeActive = state.pixelFormat === "indexed8";

  const isToolDisabled = (tool: ITool): boolean =>
    Boolean(
      (tool.pixelOnly && pixelToolsDisabled) ||
        (tool.indexed8Unsupported && indexedModeActive),
    );

  const activate = (tool: ITool): void => {
    if (isToolDisabled(tool)) return;
    onToolChange?.(tool.id);
  };

  const groups = toolRegistry.toolbarGroups();

  const fgColor = state.primaryColor;
  const bgColor = state.secondaryColor;
  // primaryColor/secondaryColor are float [0,∞). Convert to 0-255 for CSS.
  const fgStyle = `rgb(${Math.round(Math.min(fgColor.r, 1) * 255)},${Math.round(Math.min(fgColor.g, 1) * 255)},${Math.round(Math.min(fgColor.b, 1) * 255)})`;
  const bgStyle = `rgb(${Math.round(Math.min(bgColor.r, 1) * 255)},${Math.round(Math.min(bgColor.g, 1) * 255)},${Math.round(Math.min(bgColor.b, 1) * 255)})`;

  const openPicker = (target: "fg" | "bg", e: React.MouseEvent): void => {
    if (state.pixelFormat === "indexed8") {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setIndexedPickerAnchor({ x: rect.right + 8, y: rect.top });
      setIndexedPickerTarget(target);
      return;
    }
    setDialogTarget(target);
    setDialogOpen(true);
  };

  const handleConfirm = (color: RGBAColor): void => {
    if (dialogIsSwatchAdd) {
      dispatch({
        type: "ADD_SWATCH",
        payload: {
          r: Math.round(color.r * 255),
          g: Math.round(color.g * 255),
          b: Math.round(color.b * 255),
          a: Math.round(color.a * 255),
        },
      });
    } else {
      dispatch({
        type:
          dialogTarget === "fg" ? "SET_PRIMARY_COLOR" : "SET_SECONDARY_COLOR",
        payload: color,
      });
    }
    setDialogIsSwatchAdd(false);
    setDialogOpen(false);
  };

  const handleSwap = (): void => {
    dispatch({ type: "SET_PRIMARY_COLOR", payload: bgColor });
    dispatch({ type: "SET_SECONDARY_COLOR", payload: fgColor });
  };

  const handleReset = (): void => {
    dispatch({
      type: "SET_PRIMARY_COLOR",
      payload: { r: 0, g: 0, b: 0, a: 1 },
    });
    dispatch({
      type: "SET_SECONDARY_COLOR",
      payload: { r: 1, g: 1, b: 1, a: 1 },
    });
  };

  return (
    <>
      <nav className={styles.toolbar} aria-label="Drawing tools">
        <ul className={styles.grid} role="list">
          {groups.map((group, groupIdx) => (
            <React.Fragment key={`g-${groupIdx}`}>
              {groupIdx !== 0 && (
                <li className={styles.separator} aria-hidden="true" />
              )}
              {group.map((row, rowIdx) => (
                <li className={styles.row} key={`g-${groupIdx}-r-${rowIdx}`}>
                  {row.map((tool, colIdx) => {
                    if (!tool) {
                      return (
                        <div
                          key={`empty-${colIdx}`}
                          className={styles.emptyCell}
                          aria-hidden="true"
                        />
                      );
                    }
                    const active = activeTool === tool.id;
                    const disabled = isToolDisabled(tool);
                    const onActivate = (): void => activate(tool);
                    if (tool.customRender) {
                      return (
                        <React.Fragment key={tool.id}>
                          {tool.customRender({
                            active,
                            disabled,
                            styles: styles as unknown as {
                              [key: string]: string;
                            },
                            onActivate,
                          })}
                        </React.Fragment>
                      );
                    }
                    return (
                      <StandardToolButton
                        key={tool.id}
                        tool={tool}
                        active={active}
                        disabled={disabled}
                        onActivate={onActivate}
                      />
                    );
                  })}
                </li>
              ))}
            </React.Fragment>
          ))}
        </ul>

        {/* ── Foreground / Background color swatches ───────────────────── */}
        <div className={styles.swatches}>
          <button
            className={styles.swatchBg}
            style={{ background: bgStyle }}
            title="Background color (click to edit)"
            aria-label="Background color"
            onClick={(e) => openPicker("bg", e)}
          />
          <button
            className={styles.swatchFg}
            style={{ background: fgStyle }}
            title="Foreground color (click to edit)"
            aria-label="Foreground color"
            onClick={(e) => openPicker("fg", e)}
          />
          <button
            className={styles.swatchReset}
            title="Reset to Default (D)"
            aria-label="Reset colors to default"
            onClick={handleReset}
          />
          <button
            className={styles.swatchSwap}
            title="Swap Colors (X)"
            aria-label="Swap foreground/background"
            onClick={handleSwap}
          >
            <svg viewBox="0 0 10 10" fill="currentColor" width="9" height="9">
              <path d="M6.5 1L9 3.5 6.5 6V4.5H2V3h4.5zM3.5 9L1 6.5 3.5 4v1.5H8V7H3.5z" />
            </svg>
          </button>
        </div>
      </nav>

      <ColorPickerDialog
        open={dialogOpen}
        title={
          dialogIsSwatchAdd
            ? "Add Color to Palette"
            : `Color Picker (${dialogTarget === "fg" ? "Foreground" : "Background"} Color)`
        }
        initialColor={dialogTarget === "fg" ? fgColor : bgColor}
        onConfirm={handleConfirm}
        onCancel={() => {
          setDialogIsSwatchAdd(false);
          setDialogOpen(false);
        }}
        onAddSwatch={(c) =>
          dispatch({
            type: "ADD_SWATCH",
            payload: {
              r: Math.round(c.r * 255),
              g: Math.round(c.g * 255),
              b: Math.round(c.b * 255),
              a: Math.round(c.a * 255),
            },
          })
        }
        pixelFormat={state.pixelFormat}
      />
      {indexedPickerTarget !== null && (
        <IndexedPaletteColorPicker
          palette={state.swatches}
          activeIndex={state.activePaletteIndex}
          anchorPos={indexedPickerAnchor}
          onSelect={(index, color) => {
            dispatch({ type: "SET_ACTIVE_SWATCH", payload: index });
            dispatch({
              type:
                indexedPickerTarget === "fg"
                  ? "SET_PRIMARY_COLOR"
                  : "SET_SECONDARY_COLOR",
              payload: {
                r: color.r / 255,
                g: color.g / 255,
                b: color.b / 255,
                a: color.a / 255,
              },
            });
          }}
          onClose={() => setIndexedPickerTarget(null)}
          onAddColor={() => {
            setDialogIsSwatchAdd(true);
            setDialogOpen(true);
          }}
        />
      )}
    </>
  );
}
