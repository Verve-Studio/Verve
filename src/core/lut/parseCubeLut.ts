// ─── Adobe `.cube` LUT parser ────────────────────────────────────────────────
//
// Reference: "Cube LUT Specification 1.0" (Adobe). Plain-text format with
// a small header (TITLE, LUT_3D_SIZE / LUT_1D_SIZE, DOMAIN_MIN/MAX) and
// one RGB triple per line. We support both 1D and 3D variants; a file that
// contains a 1D LUT is returned as a `ShaperLut`, a 3D file as a `CubeLut`.
//
// Tolerant to: blank lines, # comments, CRLF, leading/trailing whitespace,
// and the (common in the wild) practice of using tabs as separators.

import type { CubeLut, ShaperLut } from "./LUT";

export interface ParsedCube {
  title: string | null;
  cube?: CubeLut;
  shaper?: ShaperLut;
}

export function parseCubeLut(source: string): ParsedCube {
  let title: string | null = null;
  let size3d: number | null = null;
  let size1d: number | null = null;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const triples: number[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const stripped = rawLine.replace(/#.*$/, "").trim();
    if (stripped.length === 0) continue;

    const upper = stripped.toUpperCase();
    if (upper.startsWith("TITLE")) {
      const m = stripped.match(/TITLE\s+"([^"]*)"/i);
      title = m ? m[1] : stripped.slice("TITLE".length).trim();
      continue;
    }
    if (upper.startsWith("LUT_3D_SIZE")) {
      size3d = parseInt(stripped.split(/\s+/)[1], 10);
      continue;
    }
    if (upper.startsWith("LUT_1D_SIZE")) {
      size1d = parseInt(stripped.split(/\s+/)[1], 10);
      continue;
    }
    if (upper.startsWith("DOMAIN_MIN")) {
      const parts = stripped.split(/\s+/).slice(1).map(Number);
      if (parts.length === 3) domainMin = [parts[0], parts[1], parts[2]];
      continue;
    }
    if (upper.startsWith("DOMAIN_MAX")) {
      const parts = stripped.split(/\s+/).slice(1).map(Number);
      if (parts.length === 3) domainMax = [parts[0], parts[1], parts[2]];
      continue;
    }
    // RGB triple — allow extra whitespace / tabs
    const parts = stripped.split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      triples.push(parts[0], parts[1], parts[2]);
    }
  }

  const result: ParsedCube = { title };

  if (size3d !== null) {
    const expected = size3d * size3d * size3d * 3;
    if (triples.length < expected) {
      throw new Error(
        `[parseCubeLut] truncated 3D LUT: expected ${expected / 3} triples, got ${triples.length / 3}`,
      );
    }
    result.cube = {
      size: size3d,
      table: new Float32Array(triples.slice(0, expected)),
      domain: { min: domainMin, max: domainMax },
    };
    return result;
  }

  if (size1d !== null) {
    const expected = size1d * 3;
    if (triples.length < expected) {
      throw new Error(
        `[parseCubeLut] truncated 1D LUT: expected ${size1d} triples, got ${triples.length / 3}`,
      );
    }
    result.shaper = {
      size: size1d,
      table: new Float32Array(triples.slice(0, expected)),
      domain: [domainMin[0], domainMax[0]],
    };
    return result;
  }

  throw new Error(
    "[parseCubeLut] no LUT_1D_SIZE or LUT_3D_SIZE declared in file",
  );
}
