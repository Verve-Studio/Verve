// ─── Seamless Texture – Pass 1: Break Repetition ─────────────────────────────
// Irregular jittered Voronoi tessellation. Each cell shows a randomly-placed
// and randomly-rotated (0/90/180/270°) patch from anywhere in the source image.
// At Voronoi boundaries the TWO neighbouring cells' content are cross-faded so
// the blend bleeds across the boundary into both adjacent cells — no blending
// back to the original source, no hard cuts.

struct AdjVertOut {
  @builtin(position) pos : vec4f,
  @location(0)       uv  : vec2f,
}
@vertex
fn vs_adj(@builtin(vertex_index) vi: u32) -> AdjVertOut {
  let positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0), vec2f(1.0, -1.0), vec2f(1.0,  1.0),
  );
  let uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
    vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
  );
  return AdjVertOut(vec4f(positions[vi], 0.0, 1.0), uvs[vi]);
}

struct BreakParams {
  imgWidth    : u32,
  imgHeight   : u32,
  cellSize    : u32,
  blendRadius : u32,
  seed        : u32,
  _pad0       : u32,
  _pad1       : u32,
  _pad2       : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(2) var<uniform> params : BreakParams;

// ─── Hash helpers (robust — no zero fixed-point) ─────────────────────────────
// Two independent Wang-hash streams; +1 / +1234567 prevent degeneracy at zero.

fn cellHash2(cu: vec2u, s: u32) -> vec2f {
  var a = (cu.x * 2747636419u) + (cu.y * 2654435761u) + s + 1u;
  var b = (cu.y * 2747636419u) + (cu.x * 2654435761u) + s + 1234567u;
  a ^= (a >> 16u); a *= 0x45D9F3Bu; a ^= (a >> 16u);
  b ^= (b >> 16u); b *= 0xB5297A4Du; b ^= (b >> 16u);
  return vec2f(f32(a & 0xFFFFu), f32(b & 0xFFFFu)) / 65535.0;
}

fn cellHash1(cu: vec2u, s: u32) -> f32 {
  var v = (cu.x * 2747636419u) + (cu.y * 2654435761u) + s + 1u;
  v ^= (v >> 16u); v *= 0x45D9F3Bu; v ^= (v >> 16u);
  return f32(v & 0xFFFFFFu) / 16777215.0;
}

// ─── Bilinear sample with toroidal wrapping ───────────────────────────────────

fn sampleBilinear(fpx: vec2f) -> vec4f {
  let iw = i32(params.imgWidth);
  let ih = i32(params.imgHeight);
  let fw = f32(iw);
  let fh = f32(ih);
  let wx = ((fpx.x % fw) + fw) % fw;
  let wy = ((fpx.y % fh) + fh) % fh;
  let x0 = i32(floor(wx));
  let y0 = i32(floor(wy));
  let x1 = (x0 + 1) % iw;
  let y1 = (y0 + 1) % ih;
  let tx = wx - floor(wx);
  let ty = wy - floor(wy);
  let c00 = textureLoad(srcTex, vec2i(x0, y0), 0);
  let c10 = textureLoad(srcTex, vec2i(x1, y0), 0);
  let c01 = textureLoad(srcTex, vec2i(x0, y1), 0);
  let c11 = textureLoad(srcTex, vec2i(x1, y1), 0);
  return mix(mix(c00, c10, tx), mix(c01, c11, tx), ty);
}

// ─── Jittered Voronoi cell centre (pixel coords) ──────────────────────────────

fn cellCentre(ci: vec2i, cellSizeF: f32) -> vec2f {
  let cu  = vec2u(u32(ci.x) & 0xFFFFu, u32(ci.y) & 0xFFFFu);
  // Jitter in [0.05, 0.95] x cellSize for maximum irregularity
  let jit = cellHash2(cu, params.seed) * 0.90 + 0.05;
  return (vec2f(ci) + jit) * cellSizeF;
}

// ─── Sample the content belonging to cell ci at output pixel px ───────────────

fn sampleCell(ci: vec2i, px: vec2f) -> vec4f {
  let cellSizeF = f32(params.cellSize);
  let cu        = vec2u(u32(ci.x) & 0xFFFFu, u32(ci.y) & 0xFFFFu);
  let fw        = f32(params.imgWidth);
  let fh        = f32(params.imgHeight);

  // Large random translation: each cell draws content from a random location
  let origin  = cellHash2(cu, params.seed ^ 0x8B3Du) * vec2f(fw, fh);

  // Random rotation: 0, 90 CCW, 180, 90 CW
  let rotStep = u32(cellHash1(cu, params.seed ^ 0xF1A2u) * 4.0);

  // Offset of the output pixel from this cell's Voronoi centre
  let centre  = cellCentre(ci, cellSizeF);
  let local   = px - centre;

  // Rotate the local offset so the sampled content appears rotated
  var srcLocal: vec2f;
  switch (rotStep) {
    case 1u: { srcLocal = vec2f(-local.y,  local.x); }   // 90 CCW
    case 2u: { srcLocal = vec2f(-local.x, -local.y); }   // 180
    case 3u: { srcLocal = vec2f( local.y, -local.x); }   // 90 CW
    default: { srcLocal = local; }                        // 0
  }

  return sampleBilinear(origin + srcLocal);
}

// ─── Smooth value-noise warp ──────────────────────────────────────────────────
// Bilinear interpolation of a per-cell hash gives a smooth low-frequency field
// used to displace coords before the Voronoi computation. This curves every
// boundary so no axis-aligned seams remain.

fn warpAxis(p: vec2f, s: u32) -> f32 {
  let ix = i32(floor(p.x));
  let iy = i32(floor(p.y));
  let fx = p.x - floor(p.x);
  let fy = p.y - floor(p.y);
  // Smoothstep fade for C1-continuous noise
  let ux = fx * fx * (3.0 - 2.0 * fx);
  let uy = fy * fy * (3.0 - 2.0 * fy);
  let h00 = cellHash1(vec2u(u32(ix    ) & 0xFFFFu, u32(iy    ) & 0xFFFFu), s);
  let h10 = cellHash1(vec2u(u32(ix + 1) & 0xFFFFu, u32(iy    ) & 0xFFFFu), s);
  let h01 = cellHash1(vec2u(u32(ix    ) & 0xFFFFu, u32(iy + 1) & 0xFFFFu), s);
  let h11 = cellHash1(vec2u(u32(ix + 1) & 0xFFFFu, u32(iy + 1) & 0xFFFFu), s);
  return mix(mix(h00, h10, ux), mix(h01, h11, ux), uy) - 0.5;
}

fn warpedPx(px: vec2f, cellSizeF: f32) -> vec2f {
  // Warp at ~2 cells per period, amplitude ~0.5 cell. Two independent axes.
  let warpFreq = 1.0 / (cellSizeF * 2.0);
  let warpAmp  = cellSizeF * 0.6;
  let q        = px * warpFreq;
  let dx = warpAxis(q,                       params.seed ^ 0xA17Bu);
  let dy = warpAxis(q + vec2f(31.7, 17.3),   params.seed ^ 0x53C9u);
  return px + vec2f(dx, dy) * warpAmp;
}

// ─── Fragment shader ──────────────────────────────────────────────────────────

@fragment
fn fs_seamless_break(in: AdjVertOut) -> @location(0) vec4<f32> {
  let pxRaw     = vec2f(in.pos.xy);
  let cellSizeF = f32(params.cellSize);
  let blendR    = max(f32(params.blendRadius), 1.0);

  // Curve-warp the coordinate so Voronoi boundaries are organic, not axial.
  let px  = warpedPx(pxRaw, cellSizeF);
  let ci0 = vec2i(floor(px / cellSizeF));

  // Pass 1: find the nearest cell distance.
  // Wider 7×7 search needed because the warp can push px up to 0.6·cellSize.
  var minDist = 1.0e38;
  for (var dy = -3; dy <= 3; dy++) {
    for (var dx = -3; dx <= 3; dx++) {
      let ci   = ci0 + vec2i(dx, dy);
      let cent = cellCentre(ci, cellSizeF);
      let d    = length(px - cent);
      if (d < minDist) { minDist = d; }
    }
  }

  // Pass 2: weighted blend of every cell within blendR of the nearest.
  // weight = (1 - excess/blendR)^2  where excess = d - minDist.
  // C1-continuous across boundaries AND triple junctions.
  var totalW = 0.0;
  var color  = vec4f(0.0);
  for (var dy = -3; dy <= 3; dy++) {
    for (var dx = -3; dx <= 3; dx++) {
      let ci     = ci0 + vec2i(dx, dy);
      let cent   = cellCentre(ci, cellSizeF);
      let d      = length(px - cent);
      let excess = d - minDist;
      let wRaw   = max(0.0, 1.0 - excess / blendR);
      let w      = wRaw * wRaw;
      if (w > 0.0) {
        totalW += w;
        // Sample using the original (un-warped) pixel so per-cell content
        // stays sharp; only the BOUNDARY shapes are warped.
        color  += w * sampleCell(ci, pxRaw);
      }
    }
  }

  return color / totalW;
}
