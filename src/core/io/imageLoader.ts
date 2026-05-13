import * as UTIF from "utif";
import { decodeRgbe } from "./hdrCodec";
import {
  decodeExr,
  getDdsInfo,
  decodeDds,
  decodeDdsF32,
  DdsFormat,
} from "@/wasm";
import {
  extractIccFromPng,
  extractIccFromJpeg,
  extractIccFromTiff,
} from "@/core/cms/iccProfile";

// ─── Supported image extensions + MIME types ─────────────────────────────────

export const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".gif",
  ".bmp",
  ".tga",
  ".tif",
  ".tiff",
  ".exr",
  ".hdr",
  ".dds",
  ".pcx",
]);

export const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tga": "image/tga",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".exr": "image/x-exr",
  ".hdr": "image/vnd.radiance",
  ".dds": "image/vnd.ms-dds",
  ".pcx": "image/x-pcx",
};

// ─── TGA decoder ─────────────────────────────────────────────────────────────

function decodeTgaPixels(raw: Uint8Array): {
  data: Uint8Array;
  width: number;
  height: number;
} {
  const idLength = raw[0];
  const imageType = raw[2];
  // Bytes 5–6: color map length; byte 7: color map entry size (bits)
  const cmEntries = raw[5] | (raw[6] << 8);
  const cmEntrySize = raw[7];
  const cmBytes = Math.ceil((cmEntries * cmEntrySize) / 8);
  const width = raw[12] | (raw[13] << 8);
  const height = raw[14] | (raw[15] << 8);
  const pixelDepth = raw[16];
  const descriptor = raw[17];
  const topToBottom = !!(descriptor & 0x20);
  const bytesPerPixel = Math.ceil(pixelDepth / 8);
  const pixelStart = 18 + idLength + cmBytes;
  const isGray = imageType === 3 || imageType === 11;
  const output = new Uint8Array(width * height * 4);

  function writePixel(dstOff: number, srcOff: number): void {
    if (isGray) {
      const v = raw[srcOff];
      output[dstOff] = output[dstOff + 1] = output[dstOff + 2] = v;
      output[dstOff + 3] = 255;
    } else {
      // TGA stores BGR(A)
      output[dstOff] = raw[srcOff + 2]; // R
      output[dstOff + 1] = raw[srcOff + 1]; // G
      output[dstOff + 2] = raw[srcOff + 0]; // B
      output[dstOff + 3] = bytesPerPixel === 4 ? raw[srcOff + 3] : 255;
    }
  }

  if (imageType === 2 || imageType === 3) {
    for (let i = 0; i < width * height; i++) {
      writePixel(i * 4, pixelStart + i * bytesPerPixel);
    }
  } else if (imageType === 10 || imageType === 11) {
    let srcOff = pixelStart;
    let dstPx = 0;
    while (dstPx < width * height) {
      const packet = raw[srcOff++];
      const count = (packet & 0x7f) + 1;
      if (packet & 0x80) {
        // Run-length packet: same pixel repeated
        const pixSrc = srcOff;
        srcOff += bytesPerPixel;
        for (let j = 0; j < count; j++) writePixel(dstPx++ * 4, pixSrc);
      } else {
        // Raw packet: count distinct pixels
        for (let j = 0; j < count; j++) {
          writePixel(dstPx++ * 4, srcOff);
          srcOff += bytesPerPixel;
        }
      }
    }
  } else {
    throw new Error(`Unsupported TGA image type: ${imageType}`);
  }

  // TGA default scan order is bottom-to-top; flip unless bit 5 of descriptor is set
  if (!topToBottom) {
    const rowBytes = width * 4;
    const tmp = new Uint8Array(rowBytes);
    for (let y = 0; y < Math.floor(height / 2); y++) {
      const topOff = y * rowBytes;
      const botOff = (height - 1 - y) * rowBytes;
      tmp.set(output.subarray(topOff, topOff + rowBytes));
      output.copyWithin(topOff, botOff, botOff + rowBytes);
      output.set(tmp, botOff);
    }
  }

  return { data: output, width, height };
}

// ─── PCX decoder ─────────────────────────────────────────────────────────────

/** Decode a ZSoft Paintbrush (.pcx) file into RGBA pixels. Supports the
 *  common variants: 1 plane × 1/2/4/8 bpp (palette-indexed) and 3-plane ×
 *  8 bpp (24-bit RGB). RLE (encoding=1) and raw (encoding=0) are both
 *  supported. */
function decodePcxPixels(raw: Uint8Array): {
  data: Uint8Array;
  width: number;
  height: number;
} {
  if (raw.length < 128 || raw[0] !== 0x0a) {
    throw new Error("Not a PCX file");
  }
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const encoding = raw[2];
  const bpp = raw[3];
  const xmin = dv.getUint16(4, true);
  const ymin = dv.getUint16(6, true);
  const xmax = dv.getUint16(8, true);
  const ymax = dv.getUint16(10, true);
  const planes = raw[65];
  const bytesPerLine = dv.getUint16(66, true);
  const width = xmax - xmin + 1;
  const height = ymax - ymin + 1;
  if (width <= 0 || height <= 0) throw new Error("Invalid PCX dimensions");
  if (encoding !== 0 && encoding !== 1) {
    throw new Error(`Unsupported PCX encoding: ${encoding}`);
  }

  // 16-entry header palette (EGA / 4-bpp etc.).
  const headerPalette: [number, number, number][] = [];
  for (let i = 0; i < 16; i++) {
    headerPalette.push([raw[16 + i * 3], raw[17 + i * 3], raw[18 + i * 3]]);
  }

  // 256-entry VGA palette is appended after the image data, prefixed by 0x0C.
  // Only present for 8-bpp single-plane files.
  let vgaPalette: [number, number, number][] | null = null;
  let imageDataEnd = raw.length;
  if (
    bpp === 8 &&
    planes === 1 &&
    raw.length >= 769 &&
    raw[raw.length - 769] === 0x0c
  ) {
    vgaPalette = [];
    const off = raw.length - 768;
    for (let i = 0; i < 256; i++) {
      vgaPalette.push([raw[off + i * 3], raw[off + i * 3 + 1], raw[off + i * 3 + 2]]);
    }
    imageDataEnd = raw.length - 769;
  }

  // Decompress the scan-line buffer (bytesPerLine * planes * height bytes).
  const totalBytes = bytesPerLine * planes * height;
  const decompressed = new Uint8Array(totalBytes);
  if (encoding === 0) {
    decompressed.set(raw.subarray(128, 128 + totalBytes));
  } else {
    let src = 128;
    let dst = 0;
    while (dst < totalBytes && src < imageDataEnd) {
      const byte = raw[src++];
      if ((byte & 0xc0) === 0xc0) {
        const count = byte & 0x3f;
        const value = raw[src++];
        const end = Math.min(dst + count, totalBytes);
        while (dst < end) decompressed[dst++] = value;
      } else {
        decompressed[dst++] = byte;
      }
    }
  }

  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowOff = y * bytesPerLine * planes;
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0;
      const a = 255;
      if (bpp === 8 && planes === 1) {
        const idx = decompressed[rowOff + x];
        const c = (vgaPalette ?? headerPalette)[idx] ?? [idx, idx, idx];
        [r, g, b] = c;
      } else if (bpp === 8 && planes >= 3) {
        r = decompressed[rowOff + x];
        g = decompressed[rowOff + bytesPerLine + x];
        b = decompressed[rowOff + bytesPerLine * 2 + x];
      } else if (bpp === 4 && planes === 1) {
        const byte = decompressed[rowOff + (x >> 1)];
        const idx = x & 1 ? byte & 0x0f : byte >> 4;
        [r, g, b] = headerPalette[idx];
      } else if (bpp === 1) {
        // 1-bit per plane, N planes → palette index in [0, 2^N).
        let idx = 0;
        for (let p = 0; p < planes; p++) {
          const byte = decompressed[rowOff + p * bytesPerLine + (x >> 3)];
          const bit = (byte >> (7 - (x & 7))) & 1;
          idx |= bit << p;
        }
        const c = headerPalette[idx];
        if (c) {
          [r, g, b] = c;
        } else {
          // Fallback for monochrome with no usable header palette.
          r = g = b = idx ? 255 : 0;
        }
      } else {
        throw new Error(`Unsupported PCX format: ${bpp}bpp × ${planes} planes`);
      }
      const o = (y * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return { data: out, width, height };
}

// ─── Decode a data URL into raw RGBA pixels ───────────────────────────────────

export async function loadImagePixels(
  dataUrl: string,
): Promise<{
  data: Uint8Array | Float32Array;
  width: number;
  height: number;
  isHdr?: boolean;
  /** Raw ICC profile bytes extracted from the source file, when present.
   *  PNG iCCP chunks, JPEG APP2 markers, and TIFF tag 34675 are honoured;
   *  every other format returns no profile. */
  iccProfile?: Uint8Array;
}> {
  // DDS — decoded via WASM.
  if (dataUrl.startsWith("data:image/vnd.ms-dds;base64,")) {
    try {
      const base64 = dataUrl.slice("data:image/vnd.ms-dds;base64,".length);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const info = await getDdsInfo(bytes);
      if (info.fmt === DdsFormat.BC6H || info.fmt === DdsFormat.RGBA32F) {
        const result = await decodeDdsF32(bytes);
        return {
          data: result.pixels,
          width: result.width,
          height: result.height,
          isHdr: true,
        };
      } else {
        const result = await decodeDds(bytes);
        return {
          data: result.pixels,
          width: result.width,
          height: result.height,
        };
      }
    } catch (err) {
      return Promise.reject(
        new Error(`Failed to decode DDS: ${(err as Error).message}`),
      );
    }
  }

  // EXR — decoded via WASM (tinyexr).
  if (dataUrl.startsWith("data:image/x-exr;base64,")) {
    try {
      const base64 = dataUrl.slice("data:image/x-exr;base64,".length);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const result = await decodeExr(bytes);
      return {
        data: result.pixels,
        width: result.width,
        height: result.height,
        isHdr: true,
      };
    } catch (err) {
      return Promise.reject(
        new Error(`Failed to decode EXR: ${(err as Error).message}`),
      );
    }
  }

  // Radiance RGBE (.hdr) — pure TypeScript codec.
  if (dataUrl.startsWith("data:image/vnd.radiance;base64,")) {
    try {
      const base64 = dataUrl.slice("data:image/vnd.radiance;base64,".length);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const result = decodeRgbe(bytes);
      return {
        data: result.pixels,
        width: result.width,
        height: result.height,
        isHdr: true,
      };
    } catch (err) {
      return Promise.reject(
        new Error(`Failed to decode HDR: ${(err as Error).message}`),
      );
    }
  }

  // PCX is not supported by the browser's <img> element — decode manually.
  if (dataUrl.startsWith("data:image/x-pcx;base64,")) {
    try {
      const base64 = dataUrl.slice("data:image/x-pcx;base64,".length);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return Promise.resolve(decodePcxPixels(bytes));
    } catch (err) {
      return Promise.reject(
        new Error(`Failed to decode PCX: ${(err as Error).message}`),
      );
    }
  }

  // TGA is not supported by the browser's <img> element — decode manually.
  if (dataUrl.startsWith("data:image/tga;base64,")) {
    try {
      const base64 = dataUrl.slice("data:image/tga;base64,".length);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return Promise.resolve(decodeTgaPixels(bytes));
    } catch (err) {
      return Promise.reject(
        new Error(`Failed to decode TGA: ${(err as Error).message}`),
      );
    }
  }

  // TIFF is not supported by the browser's <img> element — decode via UTIF.
  if (dataUrl.startsWith("data:image/tiff;base64,")) {
    try {
      const base64 = dataUrl.slice("data:image/tiff;base64,".length);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const iccProfile = extractIccFromTiff(bytes) ?? undefined;
      const ifds = UTIF.decode(bytes.buffer as ArrayBuffer);
      if (ifds.length === 0) throw new Error("No images found in TIFF file");
      UTIF.decodeImage(bytes.buffer as ArrayBuffer, ifds[0]);
      const ifd = ifds[0] as Record<string, number[]>;
      // Detect 32-bit float TIFF (SampleFormat=3, BitsPerSample=32)
      if (ifd["t339"]?.[0] === 3 && ifd["t258"]?.[0] === 32) {
        const w = ifds[0].width;
        const h = ifds[0].height;
        const rawData = (ifds[0] as unknown as { data: Uint8Array }).data;
        const floatView = new Float32Array(
          rawData.buffer,
          rawData.byteOffset,
          rawData.byteLength / 4,
        );
        const samplesPerPixel = ifd["t277"]?.[0] ?? 3;
        const pixels = new Float32Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          pixels[i * 4] = floatView[i * samplesPerPixel];
          pixels[i * 4 + 1] =
            samplesPerPixel > 1
              ? floatView[i * samplesPerPixel + 1]
              : floatView[i * samplesPerPixel];
          pixels[i * 4 + 2] =
            samplesPerPixel > 2
              ? floatView[i * samplesPerPixel + 2]
              : floatView[i * samplesPerPixel];
          pixels[i * 4 + 3] =
            samplesPerPixel > 3 ? floatView[i * samplesPerPixel + 3] : 1.0;
        }
        return Promise.resolve({
          data: pixels,
          width: w,
          height: h,
          isHdr: true,
          iccProfile,
        });
      }
      const rgba = UTIF.toRGBA8(ifds[0]);
      return Promise.resolve({
        data: rgba,
        width: ifds[0].width,
        height: ifds[0].height,
        iccProfile,
      });
    } catch (err) {
      return Promise.reject(
        new Error(`Failed to decode TIFF: ${(err as Error).message}`),
      );
    }
  }

  // PNG / JPEG decode through the browser's <img> element, which strips
  // any embedded ICC profile. Extract the profile from the raw bytes
  // first, then hand off pixel decoding to the browser.
  let extractedProfile: Uint8Array | undefined;
  if (dataUrl.startsWith("data:image/png;base64,")) {
    try {
      const base64 = dataUrl.slice("data:image/png;base64,".length);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      extractedProfile = (await extractIccFromPng(bytes)) ?? undefined;
    } catch {
      extractedProfile = undefined;
    }
  } else if (dataUrl.startsWith("data:image/jpeg;base64,")) {
    try {
      const base64 = dataUrl.slice("data:image/jpeg;base64,".length);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      extractedProfile = extractIccFromJpeg(bytes) ?? undefined;
    } catch {
      extractedProfile = undefined;
    }
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const tmp = document.createElement("canvas");
      tmp.width = img.naturalWidth;
      tmp.height = img.naturalHeight;
      const ctx = tmp.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      resolve({
        data: new Uint8Array(
          ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data
            .buffer,
        ),
        width: img.naturalWidth,
        height: img.naturalHeight,
        iccProfile: extractedProfile,
      });
    };
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = dataUrl;
  });
}
