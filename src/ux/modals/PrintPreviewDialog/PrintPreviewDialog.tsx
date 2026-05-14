/**
 * Custom print-preview dialog. Replaces the OS print dialog so the user sees
 * a live preview of how the page will lay out before the job is sent to the
 * printer. Settings (printer, page size, orientation, margins, copies, colour,
 * DPI, ICC color management) feed straight into `webContents.print({ silent:
 * true, … })` via the `printer:print` IPC; no native print dialog is ever
 * shown.
 *
 * Color management:
 *   The dialog optionally runs the rasterised composite through lcms2 before
 *   handing it to the print pipeline — converting the document from its
 *   working space (sRGB) to the selected printer's ICC profile with the
 *   chosen rendering intent + BPC. When "Soft-proof" is on, the on-screen
 *   preview is fed the converted pixels too, so the user sees the colour
 *   shift the print will exhibit. When "Soft-proof" is off, the preview
 *   stays clean but the printed result is still colour-managed.
 *
 * The composite is fetched once on open via `getComposite()` and cached as
 * raw RGBA — encoding/conversion happens on demand from those bytes so a
 * settings tweak doesn't re-rasterise the document.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { notificationStore } from "@/core/store/notificationStore";
import { statusMessageStore } from "@/core/store/statusMessageStore";
import {
  colorProfileStore,
  useColorProfileCatalog,
} from "@/core/cms/colorProfileStore";
import {
  convertPixels,
  getWorkingSpaceProfile,
  isCmsAvailable,
  type RenderingIntent,
} from "@/core/cms/lcms2";
import { exportPng } from "@/core/io/exportPng";
import styles from "./PrintPreviewDialog.module.scss";

// ─── Types ────────────────────────────────────────────────────────────────────

type PaperSize = "A3" | "A4" | "A5" | "Legal" | "Letter" | "Tabloid";
type MarginMode = "default" | "none" | "custom";

interface PrinterInfo {
  name: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
}

/** Paper dimensions in millimetres (portrait). */
const PAPER_MM: Record<PaperSize, [number, number]> = {
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  Legal: [216, 356],
  Letter: [216, 279],
  Tabloid: [279, 432],
};

const PAPER_OPTIONS: PaperSize[] = [
  "A4",
  "A3",
  "A5",
  "Letter",
  "Legal",
  "Tabloid",
];

const DPI_OPTIONS = [150, 300, 600, 1200] as const;

const DEFAULT_MARGIN_MM = 12.7; // 0.5 inch — Chromium's "default" margin.

const RENDERING_INTENT_LABEL: Record<RenderingIntent, string> = {
  perceptual: "Perceptual",
  "relative-colorimetric": "Relative Colorimetric",
  saturation: "Saturation",
  "absolute-colorimetric": "Absolute Colorimetric",
};

const RENDERING_INTENT_OPTIONS: RenderingIntent[] = [
  "perceptual",
  "relative-colorimetric",
  "saturation",
  "absolute-colorimetric",
];

export interface PrintPreviewDialogProps {
  open: boolean;
  documentWidth: number;
  documentHeight: number;
  /** Returns the raw rasterised composite as sRGB-encoded RGBA bytes. */
  getComposite: () => Promise<{
    rgba: Uint8Array;
    width: number;
    height: number;
  }>;
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a `<canvas>` painted from RGBA bytes — used as a `drawImage` source. */
function canvasFromRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  // Copy into a fresh JS-owned buffer so the ImageData constructor sees a
  // plain ArrayBuffer (lcms2 output is backed by the WASM heap, which the
  // current TS typings flag as `ArrayBufferLike`).
  const clamped = new Uint8ClampedArray(rgba.length);
  clamped.set(rgba);
  ctx.putImageData(new ImageData(clamped, width, height), 0, 0);
  return c;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PrintPreviewDialog({
  open,
  documentWidth,
  documentHeight,
  getComposite,
  onClose,
}: PrintPreviewDialogProps): React.JSX.Element {
  // ── Settings ────────────────────────────────────────────────────────────
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [deviceName, setDeviceName] = useState<string>("");
  const [pageSize, setPageSize] = useState<PaperSize>("A4");
  const [landscape, setLandscape] = useState(false);
  const [marginMode, setMarginMode] = useState<MarginMode>("default");
  const [marginTop, setMarginTop] = useState(DEFAULT_MARGIN_MM);
  const [marginRight, setMarginRight] = useState(DEFAULT_MARGIN_MM);
  const [marginBottom, setMarginBottom] = useState(DEFAULT_MARGIN_MM);
  const [marginLeft, setMarginLeft] = useState(DEFAULT_MARGIN_MM);
  const [copies, setCopies] = useState(1);
  const [collate, setCollate] = useState(true);
  const [color, setColor] = useState(true);
  const [dpi, setDpi] = useState<number>(300);

  // ── Color management ────────────────────────────────────────────────────
  const profileCatalog = useColorProfileCatalog();
  const [cmsAvailable, setCmsAvailable] = useState<boolean | null>(null);
  const [useCms, setUseCms] = useState(false);
  const [printerProfileId, setPrinterProfileId] = useState<string>("");
  const [intent, setIntent] = useState<RenderingIntent>("perceptual");
  const [useBpc, setUseBpc] = useState(true);
  const [softProofPreview, setSoftProofPreview] = useState(true);

  // ── Composite state ─────────────────────────────────────────────────────
  const [srcRgba, setSrcRgba] = useState<Uint8Array | null>(null);
  const [srcCanvas, setSrcCanvas] = useState<HTMLCanvasElement | null>(null);
  const [convertedCanvas, setConvertedCanvas] =
    useState<HTMLCanvasElement | null>(null);
  const [convertedRgba, setConvertedRgba] = useState<Uint8Array | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);

  // ── Load printers, refresh profile catalog, fetch composite on open ────
  useEffect(() => {
    if (!open) {
      setSrcRgba(null);
      setSrcCanvas(null);
      setConvertedCanvas(null);
      setConvertedRgba(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await window.api.listPrinters();
      if (cancelled) return;
      if (!Array.isArray(result)) {
        notificationStore.error(`Failed to list printers: ${result.error}`);
        return;
      }
      setPrinters(result);
      const def = result.find((p) => p.isDefault) ?? result[0];
      if (def) setDeviceName(def.name);
    })();
    void (async () => {
      const avail = await isCmsAvailable();
      if (cancelled) return;
      setCmsAvailable(avail);
      if (avail) await colorProfileStore.refresh();
    })();
    void (async () => {
      try {
        const c = await getComposite();
        if (cancelled) return;
        setSrcRgba(c.rgba);
        const canvas = canvasFromRgba(c.rgba, c.width, c.height);
        if (canvas) setSrcCanvas(canvas);
      } catch (e) {
        if (!cancelled) {
          notificationStore.error(
            `Failed to render document preview: ${(e as Error).message}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, getComposite]);

  // ── Run the CMS conversion whenever a relevant input changes ─────────────
  useEffect(() => {
    let cancelled = false;
    if (!useCms || !printerProfileId || !srcRgba || !cmsAvailable) {
      setConvertedCanvas(null);
      setConvertedRgba(null);
      return;
    }
    setIsConverting(true);
    void (async () => {
      try {
        const [src, dst] = await Promise.all([
          getWorkingSpaceProfile("rgba8"),
          colorProfileStore.readBytes(printerProfileId),
        ]);
        if (cancelled) return;
        if (!src || !dst) {
          notificationStore.error(
            "Color management is unavailable — falling back to passthrough.",
          );
          setConvertedCanvas(null);
          setConvertedRgba(null);
          return;
        }
        const converted = await convertPixels(
          srcRgba,
          src,
          dst,
          "rgba8",
          intent,
          useBpc,
        );
        if (cancelled) return;
        if (!converted || !(converted instanceof Uint8Array)) {
          notificationStore.error(
            "Color conversion failed — printing without CMS.",
          );
          setConvertedCanvas(null);
          setConvertedRgba(null);
          return;
        }
        setConvertedRgba(converted);
        const canvas = canvasFromRgba(
          converted,
          documentWidth,
          documentHeight,
        );
        if (canvas) setConvertedCanvas(canvas);
      } catch (e) {
        notificationStore.error(
          `Color conversion error: ${(e as Error).message}`,
        );
      } finally {
        if (!cancelled) setIsConverting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    useCms,
    printerProfileId,
    intent,
    useBpc,
    srcRgba,
    cmsAvailable,
    documentWidth,
    documentHeight,
  ]);

  // ── Effective page dimensions (mm, orientation-adjusted) ────────────────
  const [pageMmW, pageMmH] = useMemo<[number, number]>(() => {
    const [w, h] = PAPER_MM[pageSize];
    return landscape ? [h, w] : [w, h];
  }, [pageSize, landscape]);

  const margins = useMemo(() => {
    if (marginMode === "none") {
      return { top: 0, right: 0, bottom: 0, left: 0 };
    }
    if (marginMode === "default") {
      return {
        top: DEFAULT_MARGIN_MM,
        right: DEFAULT_MARGIN_MM,
        bottom: DEFAULT_MARGIN_MM,
        left: DEFAULT_MARGIN_MM,
      };
    }
    return {
      top: marginTop,
      right: marginRight,
      bottom: marginBottom,
      left: marginLeft,
    };
  }, [marginMode, marginTop, marginRight, marginBottom, marginLeft]);

  // Source the preview canvas uses: converted (soft-proof) or untouched.
  const previewSource =
    useCms && softProofPreview && convertedCanvas ? convertedCanvas : srcCanvas;

  // ── Preview canvas ──────────────────────────────────────────────────────
  const previewRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const DPR = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(cssW * DPR));
    canvas.height = Math.max(1, Math.round(cssH * DPR));
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const PADDING = 16;
    const availW = Math.max(50, cssW - PADDING * 2);
    const availH = Math.max(50, cssH - PADDING * 2);
    const scale = Math.min(availW / pageMmW, availH / pageMmH);
    const drawW = pageMmW * scale;
    const drawH = pageMmH * scale;
    const x = (cssW - drawW) / 2;
    const y = (cssH - drawH) / 2;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, drawW, drawH);
    ctx.restore();
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, drawW - 1, drawH - 1);

    const mx0 = x + margins.left * scale;
    const my0 = y + margins.top * scale;
    const mw = drawW - (margins.left + margins.right) * scale;
    const mh = drawH - (margins.top + margins.bottom) * scale;

    if (previewSource && mw > 0 && mh > 0) {
      const imgAspect = documentWidth / documentHeight;
      const boxAspect = mw / mh;
      let iw: number;
      let ih: number;
      if (imgAspect > boxAspect) {
        iw = mw;
        ih = mw / imgAspect;
      } else {
        ih = mh;
        iw = mh * imgAspect;
      }
      const ix = mx0 + (mw - iw) / 2;
      const iy = my0 + (mh - ih) / 2;
      ctx.save();
      if (!color) ctx.filter = "grayscale(1)";
      ctx.drawImage(previewSource, ix, iy, iw, ih);
      ctx.restore();
    }

    if (mw > 0 && mh > 0 && marginMode !== "none") {
      ctx.save();
      ctx.strokeStyle = "rgba(0, 120, 255, 0.7)";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(mx0, my0, mw, mh);
      ctx.restore();
    }

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.font = "11px system-ui, sans-serif";
    const label = `${Math.round(pageMmW)} × ${Math.round(pageMmH)} mm`;
    ctx.fillText(label, x, y + drawH + 14);
  }, [
    pageMmW,
    pageMmH,
    margins,
    marginMode,
    previewSource,
    documentWidth,
    documentHeight,
    color,
  ]);

  useEffect(() => {
    if (!open) return;
    const c = previewRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setPaperResizeTick((n) => n + 1));
    ro.observe(c);
    return () => ro.disconnect();
  }, [open]);
  const [, setPaperResizeTick] = useState(0);

  // ── Print ───────────────────────────────────────────────────────────────
  const onPrint = useCallback(async (): Promise<void> => {
    if (!deviceName || !srcRgba) return;
    setIsPrinting(true);
    try {
      // Print path: prefer the colour-managed buffer when CMS is enabled
      // and the conversion succeeded. Fall back to the unconverted source
      // (so Print still works if the user toggles CMS without picking a
      // profile, or if lcms2 is missing).
      const rgbaForPrint =
        useCms && convertedRgba ? convertedRgba : srcRgba;
      const pngDataUrl = await exportPng(
        rgbaForPrint,
        documentWidth,
        documentHeight,
      );
      const pngBase64 = pngDataUrl.slice("data:image/png;base64,".length);

      const result = await window.api.print({
        deviceName,
        pngBase64,
        pageSize,
        landscape,
        margins: {
          marginType: marginMode === "default" ? "default" : marginMode,
          ...(marginMode === "custom"
            ? {
                topMicrons: Math.round(marginTop * 1000),
                rightMicrons: Math.round(marginRight * 1000),
                bottomMicrons: Math.round(marginBottom * 1000),
                leftMicrons: Math.round(marginLeft * 1000),
              }
            : {}),
        },
        color,
        copies: Math.max(1, Math.floor(copies)),
        collate,
        dpi,
      });
      if (result.success) {
        statusMessageStore.show(`Sent to printer: ${deviceName}`);
        onClose();
      } else {
        notificationStore.error(
          `Print failed: ${result.reason ?? result.error ?? "unknown error"}`,
        );
      }
    } catch (e) {
      notificationStore.error(`Print failed: ${(e as Error).message}`);
    } finally {
      setIsPrinting(false);
    }
  }, [
    deviceName,
    srcRgba,
    convertedRgba,
    useCms,
    documentWidth,
    documentHeight,
    pageSize,
    landscape,
    marginMode,
    marginTop,
    marginRight,
    marginBottom,
    marginLeft,
    color,
    copies,
    collate,
    dpi,
    onClose,
  ]);

  return (
    <ModalDialog open={open} title="Print Preview" width={920} onClose={onClose}>
      <div className={styles.body}>
        <div className={styles.previewWrap}>
          <canvas ref={previewRef} className={styles.preview} />
          {isConverting && (
            <div className={styles.previewOverlay}>Applying color profile…</div>
          )}
        </div>
        <div className={styles.settings}>
          <div className={styles.group}>
            <label className={styles.label}>Printer</label>
            <select
              className={styles.select}
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              disabled={printers.length === 0}
            >
              {printers.length === 0 && (
                <option value="">(No printers found)</option>
              )}
              {printers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.displayName || p.name}
                  {p.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.group}>
            <label className={styles.label}>Paper</label>
            <select
              className={styles.select}
              value={pageSize}
              onChange={(e) => setPageSize(e.target.value as PaperSize)}
            >
              {PAPER_OPTIONS.map((sz) => {
                const [w, h] = PAPER_MM[sz];
                return (
                  <option key={sz} value={sz}>
                    {sz} ({w}×{h} mm)
                  </option>
                );
              })}
            </select>
          </div>

          <div className={styles.group}>
            <label className={styles.label}>Orientation</label>
            <div className={styles.segmented}>
              <button
                type="button"
                className={!landscape ? styles.segmentActive : styles.segment}
                onClick={() => setLandscape(false)}
              >
                Portrait
              </button>
              <button
                type="button"
                className={landscape ? styles.segmentActive : styles.segment}
                onClick={() => setLandscape(true)}
              >
                Landscape
              </button>
            </div>
          </div>

          <div className={styles.group}>
            <label className={styles.label}>Margins</label>
            <div className={styles.segmented}>
              <button
                type="button"
                className={marginMode === "default" ? styles.segmentActive : styles.segment}
                onClick={() => setMarginMode("default")}
              >
                Default
              </button>
              <button
                type="button"
                className={marginMode === "none" ? styles.segmentActive : styles.segment}
                onClick={() => setMarginMode("none")}
              >
                None
              </button>
              <button
                type="button"
                className={marginMode === "custom" ? styles.segmentActive : styles.segment}
                onClick={() => setMarginMode("custom")}
              >
                Custom
              </button>
            </div>
            {marginMode === "custom" && (
              <div className={styles.marginGrid}>
                <label className={styles.subLabel}>
                  <span>Top</span>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={marginTop}
                    onChange={(e) => setMarginTop(Number(e.target.value) || 0)}
                    className={styles.numInput}
                  />
                  <span>mm</span>
                </label>
                <label className={styles.subLabel}>
                  <span>Right</span>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={marginRight}
                    onChange={(e) => setMarginRight(Number(e.target.value) || 0)}
                    className={styles.numInput}
                  />
                  <span>mm</span>
                </label>
                <label className={styles.subLabel}>
                  <span>Bottom</span>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={marginBottom}
                    onChange={(e) => setMarginBottom(Number(e.target.value) || 0)}
                    className={styles.numInput}
                  />
                  <span>mm</span>
                </label>
                <label className={styles.subLabel}>
                  <span>Left</span>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={marginLeft}
                    onChange={(e) => setMarginLeft(Number(e.target.value) || 0)}
                    className={styles.numInput}
                  />
                  <span>mm</span>
                </label>
              </div>
            )}
          </div>

          <div className={styles.group}>
            <label className={styles.label}>Copies</label>
            <div className={styles.copiesRow}>
              <input
                type="number"
                min={1}
                step={1}
                value={copies}
                onChange={(e) =>
                  setCopies(Math.max(1, Math.floor(Number(e.target.value) || 1)))
                }
                className={styles.numInput}
              />
              <label className={styles.subLabelInline}>
                <input
                  type="checkbox"
                  checked={collate}
                  onChange={(e) => setCollate(e.target.checked)}
                  disabled={copies < 2}
                />
                Collate
              </label>
            </div>
          </div>

          <div className={styles.group}>
            <label className={styles.label}>Color</label>
            <div className={styles.segmented}>
              <button
                type="button"
                className={color ? styles.segmentActive : styles.segment}
                onClick={() => setColor(true)}
              >
                Color
              </button>
              <button
                type="button"
                className={!color ? styles.segmentActive : styles.segment}
                onClick={() => setColor(false)}
              >
                Grayscale
              </button>
            </div>
          </div>

          <div className={styles.group}>
            <label className={styles.label}>DPI</label>
            <select
              className={styles.select}
              value={dpi}
              onChange={(e) => setDpi(Number(e.target.value))}
            >
              {DPI_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} dpi
                </option>
              ))}
            </select>
          </div>

          <div className={styles.divider} />

          <div className={styles.group}>
            <label className={styles.subLabelInline}>
              <input
                type="checkbox"
                checked={useCms}
                disabled={cmsAvailable === false}
                onChange={(e) => setUseCms(e.target.checked)}
              />
              Color management
            </label>
            {cmsAvailable === false && (
              <div className={styles.hint}>
                Color management is not available in this build.
              </div>
            )}
            {useCms && (
              <>
                <label className={styles.label} style={{ marginTop: 6 }}>
                  Printer Profile
                </label>
                <select
                  className={styles.select}
                  value={printerProfileId}
                  onChange={(e) => setPrinterProfileId(e.target.value)}
                >
                  <option value="">(Select profile…)</option>
                  {profileCatalog.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.filename}
                      {p.source === "user" ? " (imported)" : ""}
                    </option>
                  ))}
                </select>
                <label className={styles.label} style={{ marginTop: 6 }}>
                  Rendering Intent
                </label>
                <select
                  className={styles.select}
                  value={intent}
                  onChange={(e) => setIntent(e.target.value as RenderingIntent)}
                >
                  {RENDERING_INTENT_OPTIONS.map((it) => (
                    <option key={it} value={it}>
                      {RENDERING_INTENT_LABEL[it]}
                    </option>
                  ))}
                </select>
                <label className={styles.subLabelInline} style={{ marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={useBpc}
                    onChange={(e) => setUseBpc(e.target.checked)}
                  />
                  Black point compensation
                </label>
                <label className={styles.subLabelInline}>
                  <input
                    type="checkbox"
                    checked={softProofPreview}
                    onChange={(e) => setSoftProofPreview(e.target.checked)}
                  />
                  Soft-proof in preview
                </label>
              </>
            )}
          </div>
        </div>
      </div>

      <div className={styles.footer}>
        <DialogButton onClick={onClose} disabled={isPrinting}>
          Cancel
        </DialogButton>
        <DialogButton
          primary
          onClick={() => void onPrint()}
          disabled={
            isPrinting ||
            !srcRgba ||
            !deviceName ||
            printers.length === 0 ||
            isConverting
          }
        >
          {isPrinting ? "Printing…" : "Print"}
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
