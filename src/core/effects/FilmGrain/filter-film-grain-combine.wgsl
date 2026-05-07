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

struct FilmGrainCombineParams {
  intensity : u32,  // 1–200 (%)
  roughness : u32,  // 0–100
  _pad0     : u32,
  _pad1     : u32,
}

@group(0) @binding(0) var srcTex          : texture_2d<f32>;
@group(0) @binding(1) var smp             : sampler;
@group(0) @binding(2) var noiseTex        : texture_2d<f32>;
@group(0) @binding(3) var<uniform> params : FilmGrainCombineParams;

@fragment
fn fs_film_grain_combine(in: AdjVertOut) -> @location(0) vec4<f32> {
  let coord      = vec2i(i32(in.pos.x), i32(in.pos.y));
  let orig       = textureLoad(srcTex,   coord, 0);
  let noiseTexel = textureLoad(noiseTex, coord, 0);

  let noiseVal   = noiseTexel.r * 2.0 - 1.0;
  let intensityF = f32(params.intensity) / 100.0;
  let roughnessF = f32(params.roughness) / 100.0;

  let luma   = 0.299 * orig.r + 0.587 * orig.g + 0.114 * orig.b;
  let weight = (1.0 - roughnessF) * (1.0 - luma) + roughnessF * 1.0;

  let grainVal = noiseVal * (127.0 / 255.0) * weight * intensityF;

  let outRGB = clamp(orig.rgb + grainVal, vec3f(0.0), vec3f(1.0));
  return vec4f(outRGB, orig.a);
}
