struct AdjVertOut {
  @builtin(position) pos : vec4f,
  @location(0) uv        : vec2f,
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

struct MaskFlags {
  hasMask : u32,
  _pad    : vec3u,
}

// Modes: 0 = none (no repeats on this axis), 1 = negative (left / up),
//        2 = positive (right / down), 3 = both. Background: 0 = passthrough,
// 1 = transparent.
struct RepeatParams {
  rect       : vec4<i32>,
  spacing    : i32,
  xMode      : u32,
  yMode      : u32,
  background : u32,
}

@group(0) @binding(0) var srcTex     : texture_2d<f32>;
@group(0) @binding(1) var smp        : sampler;
@group(0) @binding(2) var<uniform>   params    : RepeatParams;
@group(0) @binding(3) var selMask    : texture_2d<f32>;
@group(0) @binding(4) var<uniform>   maskFlags : MaskFlags;

@fragment
fn fs_repeat(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord = vec2i(i32(in.pos.x), i32(in.pos.y));
  let passThrough = textureLoad(srcTex, coord, 0);

  let rw = params.rect.z;
  let rh = params.rect.w;
  // Degenerate rect → no-op. (rectW or rectH <= 0)
  if rw <= 0 || rh <= 0 {
    return passThrough;
  }

  let pitchX = rw + params.spacing;
  let pitchY = rh + params.spacing;

  let dx = coord.x - params.rect.x;
  let dy = coord.y - params.rect.y;

  // Tile index + position within the cell. When the axis is disabled or
  // the pitch collapses to ≤ 0 (e.g. negative spacing eats the rect), fall
  // back to a single tile centred on the source rect.
  var tx: i32 = 0;
  var ty: i32 = 0;
  var lx: i32 = dx;
  var ly: i32 = dy;
  if params.xMode != 0u && pitchX > 0 {
    tx = i32(floor(f32(dx) / f32(pitchX)));
    lx = dx - tx * pitchX;
  }
  if params.yMode != 0u && pitchY > 0 {
    ty = i32(floor(f32(dy) / f32(pitchY)));
    ly = dy - ty * pitchY;
  }

  // Direction gate — a tile only "counts" if its index sits on the side
  // the user asked for.
  var xOk = false;
  if params.xMode == 0u { xOk = tx == 0; }
  else if params.xMode == 1u { xOk = tx <= 0; }
  else if params.xMode == 2u { xOk = tx >= 0; }
  else { xOk = true; }

  var yOk = false;
  if params.yMode == 0u { yOk = ty == 0; }
  else if params.yMode == 1u { yOk = ty <= 0; }
  else if params.yMode == 2u { yOk = ty >= 0; }
  else { yOk = true; }

  // Inside the tile interior (not in the spacing gap).
  let inside = lx >= 0 && lx < rw && ly >= 0 && ly < rh;

  var out_color: vec4<f32>;
  if xOk && yOk && inside {
    let dimsU = textureDimensions(srcTex);
    let dims  = vec2i(i32(dimsU.x), i32(dimsU.y));
    let src   = vec2i(params.rect.x + lx, params.rect.y + ly);
    let s     = clamp(src, vec2i(0, 0), dims - vec2i(1, 1));
    out_color = textureLoad(srcTex, s, 0);
  } else {
    if params.background == 1u {
      out_color = vec4f(0.0);
    } else {
      out_color = passThrough;
    }
  }

  if maskFlags.hasMask != 0u {
    let mask_val = textureSampleLevel(selMask, smp, in.uv, 0.0).r;
    return mix(passThrough, out_color, mask_val);
  }

  return out_color;
}
