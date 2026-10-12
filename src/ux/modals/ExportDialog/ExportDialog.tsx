import React, { useState, useEffect, useCallback, useRef } from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import styles from "./ExportDialog.module.scss";
import {
  applyExportExtension,
  maxDdsMipLevels as computeMaxDdsMipLevels,
  type DdsCompression,
  type ExportFormat,
  type ExportSettings,
  type LayerExportMode,
} from "@/core/io/exportSettings";

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  DdsCompression,
  ExportFormat,
  ExportSettings,
  LayerExportMode,
} from "@/core/io/exportSettings";

export interface ExportableLayerOption {
  id: string;
  name: string;
}

export interface ExportDialogProps {
  open: boolean;
  isHdrDocument?: boolean;
  documentWidth?: number;
  documentHeight?: number;
  /** Layers that the user can pick from when "Export each layer as a
   *  separate file" is enabled. Filtered to pixel-bearing layers (no
   *  groups / masks / adjustments). */
  exportableLayers?: ExportableLayerOption[];
  onConfirm: (settings: ExportSettings) => void;
  onCancel: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a CSS hex colour (#rrggbb) to the format expected by <input type="color">. */
function toColorInputValue(hex: string): string {
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : "#ffffff";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ExportDialog({
  open,
  isHdrDocument,
  documentWidth,
  documentHeight,
  exportableLayers,
  onConfirm,
  onCancel,
}: ExportDialogProps): React.JSX.Element | null {
  const [filePath, setFilePath] = useState("");
  const [format, setFormat] = useState<ExportFormat>("png");
  const [jpegQuality, setJpegQuality] = useState(92);
  const [jpegBg, setJpegBg] = useState("#ffffff");
  const [webpQuality, setWebpQuality] = useState(90);
  const [exrCompression, setExrCompression] = useState<0 | 1 | 2 | 3>(0);
  const [exrHalfFloat, setExrHalfFloat] = useState(false);
  const [ddsCompression, setDdsCompression] = useState<DdsCompression>("bc7");
  const [ddsMipLevels, setDdsMipLevels] = useState(1);
  const [perLayerIds, setPerLayerIds] = useState<string[]>([]);

  // Format families ─────────────────────────────────────────────────────────
  // - Flat LDR formats: support "single" (default) and "separate" output.
  // - Layer-capable formats (PSD, EXR): support all three modes; default
  //   "multilayer" so a layered Verve doc round-trips.
  // - HDR / TIFF32 / DDS: no layer model — always "single".
  const isFlatLdr =
    format === "png" ||
    format === "jpeg" ||
    format === "webp" ||
    format === "tga" ||
    format === "tiff";
  const isLayerCapable = format === "psd" || format === "exr";
  const layerSelectorSupported = isFlatLdr || isLayerCapable;
  const [layerMode, setLayerMode] = useState<LayerExportMode>("single");

  const maxDdsMipLevels = computeMaxDdsMipLevels(documentWidth ?? 0, documentHeight ?? 0);

  // Reset state on every open (closed → open only: the parent may pass a
  // fresh `exportableLayers` array on any re-render, which must not wipe
  // what the user has entered).
  const exportableLayersRef = useRef(exportableLayers);
  exportableLayersRef.current = exportableLayers;
  useEffect(() => {
    if (open) {
      setFilePath("");
      setFormat("png");
      setJpegQuality(92);
      setJpegBg("#ffffff");
      setWebpQuality(90);
      setExrCompression(0);
      setExrHalfFloat(false);
      setDdsCompression("bc7");
      setDdsMipLevels(1);
      setLayerMode("single");
      // Default to "all layers selected" so switching to "separate"
      // exports everything; the user can trim down from there.
      setPerLayerIds((exportableLayersRef.current ?? []).map((l) => l.id));
    }
  }, [open]);

  // When the format changes the available layer modes change too.  Reset to
  // each format's natural default so the user never lands on an invalid
  // combination (e.g. "multilayer" while exporting PNG).
  useEffect(() => {
    if (isLayerCapable) setLayerMode("multilayer");
    else setLayerMode("single");
  }, [format, isLayerCapable]);

  // When format changes, update the extension on the stored path.
  const handleFormatChange = useCallback((fmt: ExportFormat): void => {
    setFormat(fmt);
    setFilePath((p) => applyExportExtension(p, fmt));
  }, []);

  // Native browse dialog
  const handleBrowse = useCallback(async (): Promise<void> => {
    const chosen = await window.api.exportBrowse(format);
    if (chosen) setFilePath(chosen);
  }, [format]);

  // The active mode after clamping to what the current format supports.
  const effectiveLayerMode: LayerExportMode = layerSelectorSupported
    ? layerMode
    : "single";

  const handleConfirm = useCallback((): void => {
    if (!filePath.trim()) return;
    onConfirm({
      filePath: filePath.trim(),
      format,
      jpegQuality: Math.max(1, Math.min(100, Math.round(jpegQuality))),
      jpegBackground: jpegBg,
      webpQuality: Math.max(1, Math.min(100, Math.round(webpQuality))),
      exrCompression,
      exrHalfFloat,
      ddsCompression,
      ddsMipLevels: Math.max(
        1,
        Math.min(maxDdsMipLevels, Math.floor(ddsMipLevels)),
      ),
      layerMode: effectiveLayerMode,
      perLayerIds:
        effectiveLayerMode === "separate" ? perLayerIds.slice() : undefined,
    });
  }, [
    filePath,
    format,
    jpegQuality,
    jpegBg,
    webpQuality,
    exrCompression,
    exrHalfFloat,
    ddsCompression,
    ddsMipLevels,
    maxDdsMipLevels,
    effectiveLayerMode,
    perLayerIds,
    onConfirm,
  ]);


  const canExport = filePath.trim().length > 0;

  return (
    <ModalDialog
      open={open}
      title="Export As"
      width={440}
      onClose={onCancel}
      onSubmit={handleConfirm}
    >
      {/* ── Body ──────────────────────────────────────────────── */}
      <div className={styles.body}>
        <p className={styles.sectionTitle}>EXPORT SETTINGS</p>

        {/* Filename */}
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="ex-path">
            File
          </label>
          <input
            id="ex-path"
            type="text"
            className={styles.textInput}
            value={filePath}
            placeholder="Choose a file path…"
            onChange={(e) => setFilePath(e.target.value)}
          />
          <DialogButton onClick={handleBrowse} className={styles.browseBtn}>
            Browse…
          </DialogButton>
        </div>

        {/* Format */}
        <div className={styles.fieldRow}>
          <label className={styles.fieldLabel} htmlFor="ex-format">
            Format
          </label>
          <select
            id="ex-format"
            className={styles.select}
            value={format}
            onChange={(e) => handleFormatChange(e.target.value as ExportFormat)}
          >
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
            <option value="tga">TGA</option>
            <option value="tiff">TIFF</option>
            <option value="dds">DDS</option>
            <option value="psd">PSD (Photoshop)</option>
            <option value="pdf">PDF</option>
            {isHdrDocument && (
              <>
                <option disabled>──────────</option>
                <option value="exr">OpenEXR</option>
                <option value="hdr">Radiance HDR (.hdr)</option>
                <option value="tiff32">TIFF (32-bit float)</option>
              </>
            )}
          </select>
        </div>

        {/* Per-format options */}
        <div className={styles.optionsDivider} />

        <div className={styles.optionsSection}>
          {format === "png" && (
            <>
              <p className={styles.sectionTitle}>PNG OPTIONS</p>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel}>Compression</label>
                <span className={styles.staticNote}>
                  Lossless — automatically optimised by the browser
                </span>
              </div>
            </>
          )}

          {format === "jpeg" && (
            <>
              <p className={styles.sectionTitle}>JPEG OPTIONS</p>

              {/* Quality */}
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel} htmlFor="ex-quality">
                  Quality
                </label>
                <div className={styles.sliderGroup}>
                  <input
                    id="ex-quality"
                    type="range"
                    className={styles.slider}
                    min={1}
                    max={100}
                    value={jpegQuality}
                    onChange={(e) => setJpegQuality(e.target.valueAsNumber)}
                  />
                  <input
                    type="number"
                    className={styles.sliderValue}
                    min={1}
                    max={100}
                    value={jpegQuality}
                    onChange={(e) => {
                      const v = e.target.valueAsNumber;
                      if (!isNaN(v))
                        setJpegQuality(Math.max(1, Math.min(100, v)));
                    }}
                  />
                </div>
              </div>

              {/* Background colour for transparent pixels */}
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel} htmlFor="ex-bg">
                  Background
                </label>
                <div className={styles.colorInputWrapper}>
                  <label
                    className={styles.colorSwatch}
                    title="Pick background colour"
                  >
                    <input
                      type="color"
                      value={toColorInputValue(jpegBg)}
                      onChange={(e) => setJpegBg(e.target.value)}
                    />
                    <span className={styles.srOnly}>
                      Background colour picker
                    </span>
                  </label>
                  <input
                    id="ex-bg"
                    type="text"
                    className={styles.colorHex}
                    value={jpegBg}
                    maxLength={7}
                    onChange={(e) => {
                      const v = e.target.value;
                      setJpegBg(v);
                    }}
                    onBlur={(e) => {
                      const v = e.target.value;
                      if (!/^#[0-9a-f]{6}$/i.test(v)) setJpegBg("#ffffff");
                    }}
                  />
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--color-text-muted, #7a7a7a)",
                    }}
                  >
                    for transparency
                  </span>
                </div>
              </div>
            </>
          )}

          {format === "tga" && (
            <>
              <p className={styles.sectionTitle}>TGA OPTIONS</p>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel}>Compression</label>
                <span className={styles.staticNote}>
                  Lossless — uncompressed 32-bit RGBA
                </span>
              </div>
            </>
          )}

          {format === "tiff" && (
            <>
              <p className={styles.sectionTitle}>TIFF OPTIONS</p>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel}>Compression</label>
                <span className={styles.staticNote}>
                  Lossless — uncompressed 32-bit RGBA
                </span>
              </div>
            </>
          )}

          {format === "webp" && (
            <>
              <p className={styles.sectionTitle}>WEBP OPTIONS</p>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel} htmlFor="ex-wquality">
                  Quality
                </label>
                <div className={styles.sliderGroup}>
                  <input
                    id="ex-wquality"
                    type="range"
                    className={styles.slider}
                    min={1}
                    max={100}
                    value={webpQuality}
                    onChange={(e) => setWebpQuality(e.target.valueAsNumber)}
                  />
                  <input
                    type="number"
                    className={styles.sliderValue}
                    min={1}
                    max={100}
                    value={webpQuality}
                    onChange={(e) => {
                      const v = e.target.valueAsNumber;
                      if (!isNaN(v))
                        setWebpQuality(Math.max(1, Math.min(100, v)));
                    }}
                  />
                </div>
              </div>
            </>
          )}

          {format === "exr" && (
            <>
              <p className={styles.sectionTitle}>OPENEXR OPTIONS</p>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel} htmlFor="ex-exr-comp">
                  Compression
                </label>
                <select
                  id="ex-exr-comp"
                  className={styles.select}
                  value={exrCompression}
                  onChange={(e) =>
                    setExrCompression(Number(e.target.value) as 0 | 1 | 2 | 3)
                  }
                >
                  <option value={0}>None</option>
                  <option value={1}>ZIP (lossless, scanline)</option>
                  <option value={2}>ZIPS (lossless, single scanline)</option>
                  <option value={3}>PIZ (lossless, wavelet)</option>
                </select>
              </div>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel} htmlFor="ex-exr-half">
                  Bit depth
                </label>
                <label className={styles.checkboxLabel}>
                  <input
                    id="ex-exr-half"
                    type="checkbox"
                    checked={exrHalfFloat}
                    onChange={(e) => setExrHalfFloat(e.target.checked)}
                  />
                  Half float (16-bit)
                </label>
              </div>
            </>
          )}

          {format === "hdr" && (
            <>
              <p className={styles.sectionTitle}>RADIANCE HDR OPTIONS</p>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel}>Encoding</label>
                <span className={styles.staticNote}>
                  RGBE — lossless shared exponent
                </span>
              </div>
            </>
          )}

          {format === "tiff32" && (
            <>
              <p className={styles.sectionTitle}>TIFF 32-BIT FLOAT OPTIONS</p>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel}>Compression</label>
                <span className={styles.staticNote}>
                  Uncompressed — full float precision
                </span>
              </div>
            </>
          )}

          {format === "dds" && (
            <>
              <p className={styles.sectionTitle}>DDS OPTIONS</p>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel} htmlFor="ex-dds-comp">
                  Compression
                </label>
                <select
                  id="ex-dds-comp"
                  className={styles.select}
                  value={ddsCompression}
                  onChange={(e) =>
                    setDdsCompression(e.target.value as DdsCompression)
                  }
                >
                  <option value="bc7">BC7 — high quality, RGBA</option>
                  <option value="bc3">BC3 — DXT5, RGBA</option>
                  <option value="bc1">BC1 — DXT1, RGB (smallest)</option>
                  {isHdrDocument && (
                    <>
                      <option disabled>──────────</option>
                      <option value="bc6h">BC6H — HDR, lossy</option>
                      <option value="rgba32f">RGBA32F — HDR, lossless</option>
                    </>
                  )}
                </select>
              </div>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel} htmlFor="ex-dds-mips">
                  Mip levels
                </label>
                <select
                  id="ex-dds-mips"
                  className={styles.select}
                  value={ddsMipLevels}
                  onChange={(e) =>
                    setDdsMipLevels(parseInt(e.target.value, 10))
                  }
                >
                  {Array.from({ length: maxDdsMipLevels }, (_, i) => i + 1).map(
                    (n) => (
                      <option key={n} value={n}>
                        {n === 1
                          ? "1 (base only)"
                          : `${n} (down to ${Math.max(1, (documentWidth ?? 0) >> (n - 1))}×${Math.max(1, (documentHeight ?? 0) >> (n - 1))})`}
                      </option>
                    ),
                  )}
                </select>
              </div>
            </>
          )}

          {format === "pdf" && (
            <>
              <p className={styles.sectionTitle}>PDF OPTIONS</p>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel}>Output</label>
                <span className={styles.staticNote}>
                  Text layers export as live, selectable PDF text (Helvetica /
                  Times / Courier — closest base font is picked from the layer's
                  family). Shape layers export as native vector paths. All
                  other layers (raster, frame, group, composite, text with
                  attached adjustments or non-ASCII characters) are rasterized
                  into the PDF.
                </span>
              </div>
            </>
          )}

          {format === "psd" && (
            <>
              <p className={styles.sectionTitle}>PSD OPTIONS</p>
              <div className={styles.fieldRow}>
                <label className={styles.fieldLabel}>Rasterization</label>
                <span className={styles.staticNote}>
                  Text, shape, frame, and composite layers — along with all
                  attached adjustments, effects, and filters — are rasterized
                  to plain pixel data on export. Group folders, layer masks,
                  opacity, blend modes, and visibility are preserved.
                </span>
              </div>
            </>
          )}

          {layerSelectorSupported &&
            exportableLayers &&
            exportableLayers.length > 0 && (
              <>
                <div className={styles.optionsDivider} />
                <p className={styles.sectionTitle}>LAYER OUTPUT</p>
                <div className={styles.fieldRow}>
                  <label className={styles.fieldLabel} htmlFor="ex-layer-mode">
                    Mode
                  </label>
                  <select
                    id="ex-layer-mode"
                    className={styles.select}
                    value={effectiveLayerMode}
                    onChange={(e) =>
                      setLayerMode(e.target.value as LayerExportMode)
                    }
                  >
                    {isLayerCapable && (
                      <option value="multilayer">
                        Preserve layers (one {format === "psd" ? "PSD" : "EXR"} file)
                      </option>
                    )}
                    <option value="single">Flatten to single image</option>
                    <option value="separate">Separate file per layer</option>
                  </select>
                </div>

                {effectiveLayerMode === "separate" && (
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>Layers</span>
                    <div className={styles.perLayerList}>
                      {exportableLayers.map((l) => {
                        const checked = perLayerIds.includes(l.id);
                        return (
                          <label
                            key={l.id}
                            className={styles.perLayerItem}
                            title={l.name}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setPerLayerIds((prev) =>
                                  prev.includes(l.id)
                                    ? prev.filter((x) => x !== l.id)
                                    : [...prev, l.id],
                                )
                              }
                            />
                            <span className={styles.perLayerName}>{l.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
        </div>
      </div>

      {/* ── Footer ────────────────────────────────────────────── */}
      <div className={styles.footer}>
        <DialogButton onClick={onCancel}>Cancel</DialogButton>
        <DialogButton
          onClick={handleConfirm}
          primary
          title={canExport ? undefined : "Choose a file path first"}
        >
          Export
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
