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

struct LensFlareParams {
  centerX       : u32,
  centerY       : u32,
  brightness    : u32,
  lensType      : u32,
  ringOpacity   : u32,
  streakStrength: u32,
  streakWidth   : u32,
  streakRotation: u32,
  imgWidth      : u32,
  imgHeight     : u32,
  _pad0         : u32,
  _pad1         : u32,
}

@group(0) @binding(0) var<uniform> params : LensFlareParams;

fn gauss1(d : f32, sigma : f32) -> f32 {
  return exp(-(d * d) / (sigma * sigma));
}

fn ring(dist: f32, r: f32, sigma: f32, col: vec3f) -> vec4f {
  let v = gauss1(dist - r, sigma);
  return vec4f(col * v, v);
}

fn disc(d: f32, radius: f32, col: vec3f) -> vec4f {
  let v = gauss1(d, radius * 0.5);
  return vec4f(col * v, v);
}

fn radial_streaks(dx: f32, dy: f32, dist: f32, diag: f32,
                  nSpokes: u32, tightness: f32, falloff: f32) -> f32 {
  let angle  = atan2(dy, dx);
  let period = 3.14159265 / f32(nSpokes);
  let mod_a  = angle - period * round(angle / period);
  let angShape = exp(-(mod_a * mod_a) / (tightness * tightness));
  let radShape = exp(-dist / (falloff * diag)) / max(dist / (0.008 * diag), 1.0);
  return clamp(angShape * radShape, 0.0, 1.0);
}

fn flare_zoom(rdx: f32, rdy: f32, odx: f32, ody: f32, dist: f32, cx: f32, cy: f32, diag: f32, w: f32, h: f32, ringO: f32, streakS: f32, streakWF: f32) -> vec4f {
  var col = vec4f(0.0);
  let rawAxX  = w * 0.5 - cx;
  let rawAxY  = h * 0.5 - cy;
  let axisLen = max(sqrt(rawAxX * rawAxX + rawAxY * rawAxY), diag * 0.001);
  let axX = rawAxX / axisLen;
  let axY = rawAxY / axisLen;
  let outerGlow = gauss1(dist, 0.20 * diag);
  col += vec4f(1.0, 0.40, 0.06, outerGlow) * outerGlow * 0.55;
  let midBloom = gauss1(dist, 0.07 * diag);
  col += vec4f(1.0, 0.68, 0.20, midBloom) * midBloom * 0.90;
  let innerCore = gauss1(dist, 0.025 * diag);
  col += vec4f(1.0, 0.92, 0.80, innerCore) * innerCore * 1.5;
  let sv = radial_streaks(rdx, rdy, dist, diag, 4u, 0.080 * streakWF, 0.35);
  col += vec4f(1.0, 0.88, 0.60, sv) * sv * streakS;
  let g1x  = odx - axX * 1.45 * axisLen;
  let g1y  = ody - axY * 1.45 * axisLen;
  let g1d  = sqrt(g1x * g1x + g1y * g1y);
  let g1v  = gauss1(g1d - 0.24 * diag, 0.018 * diag) + gauss1(g1d, 0.12 * diag) * 0.35;
  col += vec4f(1.0, 0.32, 0.04, g1v) * g1v * 0.75 * ringO;
  var arcT   = array<f32,  3>(1.55, 2.00, 2.55);
  var arcRad = array<f32,  3>(0.50, 0.78, 1.02);
  var arcAlp = array<f32,  3>(0.55, 0.42, 0.28);
  var arcCol = array<vec3f, 3>(vec3f(0.90,0.34,0.05), vec3f(0.72,0.24,0.03), vec3f(0.50,0.14,0.02));
  for (var i = 0u; i < 3u; i++) {
    let ex = odx - axX * arcT[i] * axisLen;
    let ey = ody - axY * arcT[i] * axisLen;
    let rv = gauss1(sqrt(ex*ex+ey*ey) - arcRad[i]*diag, 0.010*diag);
    col += vec4f(arcCol[i]*rv, rv) * arcAlp[i] * ringO;
  }
  return col;
}

fn flare_prime35(dx: f32, dy: f32, dist: f32, cx: f32, cy: f32, diag: f32, ringO: f32, streakS: f32, streakWF: f32) -> vec4f {
  var col = vec4f(0.0);
  let core = gauss1(dist, 0.02 * diag);
  col += vec4f(vec3f(core), core);
  let sv = radial_streaks(dx, dy, dist, diag, 8u, 0.088 * streakWF, 0.40);
  col += vec4f(0.80, 0.92, 1.0, sv) * sv * streakS;
  let halo = gauss1(dist, 0.06 * diag);
  col += vec4f(0.85, 0.90, 1.0, halo) * halo * ringO;
  return col;
}

fn flare_prime105(dx: f32, dy: f32, dist: f32, diag: f32, ringO: f32, streakS: f32, streakWF: f32) -> vec4f {
  var col = vec4f(0.0);
  let bloom = gauss1(dist, 0.20 * diag);
  col += vec4f(1.0, 0.72, 0.30, bloom) * bloom;
  let core = gauss1(dist, 0.03 * diag);
  col += vec4f(1.0, 0.90, 0.75, core) * core;
  let sv = radial_streaks(dx, dy, dist, diag, 3u, 0.1333 * streakWF, 0.22);
  col += vec4f(1.0, 0.85, 0.55, sv) * sv * 0.6 * streakS;
  let rngV = gauss1(dist - 0.28*diag, 0.035*diag) * 0.45;
  col += vec4f(1.0, 0.60, 0.15, rngV) * rngV * ringO;
  return col;
}

fn flare_movie_prime(rdx: f32, rdy: f32, odx: f32, ody: f32, dist: f32, cx: f32, cy: f32, diag: f32, w: f32, h: f32, ringO: f32, streakS: f32, streakWF: f32) -> vec4f {
  var col = vec4f(0.0);
  let bloom = gauss1(dist, 0.05 * diag);
  col += vec4f(0.88, 0.92, 1.0, bloom) * bloom;
  let sv = radial_streaks(rdx, rdy, dist, diag, 6u, 0.0933 * streakWF, 0.38);
  col += vec4f(0.90, 0.95, 1.0, sv) * sv * streakS;
  col += ring(dist, 0.18*diag, 0.010*diag, vec3f(0.85,0.90,1.0)) * ringO;
  let rawAxX  = 0.5*w - cx;
  let rawAxY  = 0.5*h - cy;
  let axisLen = sqrt(rawAxX*rawAxX + rawAxY*rawAxY);
  var axX = 1.0; var axY = 0.0;
  if (axisLen > 0.001*diag) { axX = rawAxX/axisLen; axY = rawAxY/axisLen; }
  var artT = array<f32, 7>(0.25,0.50,0.70,0.90,1.15,1.40,1.65);
  var artR = array<f32, 7>(0.030,0.018,0.022,0.010,0.015,0.008,0.012);
  var artC = array<vec3f,7>(vec3f(0.75,0.80,1.0),vec3f(0.88,0.88,1.0),vec3f(0.70,0.85,1.0),vec3f(0.80,0.82,0.98),vec3f(0.65,0.78,1.0),vec3f(0.85,0.90,1.0),vec3f(0.72,0.80,0.95));
  for (var i = 0u; i < 7u; i++) {
    let ex = odx - axX*artT[i]*diag;
    let ey = ody - axY*artT[i]*diag;
    col += disc(sqrt(ex*ex+ey*ey), artR[i]*diag, artC[i]) * ringO;
  }
  return col;
}

fn flare_anamorphic(rdx: f32, rdy: f32, odx: f32, ody: f32, dist: f32, cx: f32, cy: f32, diag: f32, w: f32, h: f32, ringO: f32, streakS: f32, streakWF: f32) -> vec4f {
  var col = vec4f(0.0);
  let sigmaY  = max(0.006*diag, 4.0) * (streakWF / 0.20);
  let streakV = exp(-(rdy*rdy)/(sigmaY*sigmaY)) * streakS;
  col += vec4f(0.25, 0.60, 1.00, streakV) * streakV;
  let wideV = exp(-(rdy*rdy)/((sigmaY*1.8)*(sigmaY*1.8))) * streakS;
  col += vec4f(1.0, 0.3, 0.2, wideV) * wideV * 0.15;
  let sigX = 0.05*diag; let sigY = 0.025*diag;
  let ev = exp(-(rdx*rdx)/(sigX*sigX) - (rdy*rdy)/(sigY*sigY));
  col += vec4f(0.85, 0.90, 1.0, ev) * ev;
  let ringR  = 0.08*diag; let ringRY = ringR/3.0;
  let ringSN = 0.006*diag/ringR;
  var ringTs = array<f32,5>(-0.30,-0.55,0.35,0.65,1.0);
  for (var i = 0u; i < 5u; i++) {
    let ex = odx - ringTs[i]*diag; let ey = ody;
    let ed = sqrt((ex/ringR)*(ex/ringR)+(ey/ringRY)*(ey/ringRY));
    col += vec4f(0.3,0.65,1.0,1.0) * gauss1(ed-1.0,ringSN) * ringO;
  }
  return col;
}

@fragment
fn fs_lens_flare(in: AdjVertOut) -> @location(0) vec4<f32> {
  let px = in.pos.x; let py = in.pos.y;
  let cx = f32(params.centerX); let cy = f32(params.centerY);
  let dx = px - cx; let dy = py - cy;
  let dist = sqrt(dx*dx + dy*dy);
  let w = f32(params.imgWidth); let h = f32(params.imgHeight);
  let diag = sqrt(w*w + h*h);
  let brightnessF = f32(params.brightness)     / 100.0;
  let ringO       = f32(params.ringOpacity)    / 100.0;
  let streakS     = f32(params.streakStrength) / 100.0;
  let streakWF    = f32(params.streakWidth)    / 100.0;
  let rotRad      = f32(params.streakRotation) * (3.14159265358979 / 180.0);
  let cosR        = cos(rotRad);
  let sinR        = sin(rotRad);
  let rdx         = dx * cosR + dy * sinR;
  let rdy         = -dx * sinR + dy * cosR;
  var color = vec4f(0.0);
  if      (params.lensType == 0u) { color = flare_zoom(rdx,rdy,dx,dy,dist,cx,cy,diag,w,h,ringO,streakS,streakWF); }
  else if (params.lensType == 1u) { color = flare_prime35(rdx,rdy,dist,cx,cy,diag,ringO,streakS,streakWF); }
  else if (params.lensType == 2u) { color = flare_prime105(rdx,rdy,dist,diag,ringO,streakS,streakWF); }
  else if (params.lensType == 3u) { color = flare_movie_prime(rdx,rdy,dx,dy,dist,cx,cy,diag,w,h,ringO,streakS,streakWF); }
  else                             { color = flare_anamorphic(rdx,rdy,dx,dy,dist,cx,cy,diag,w,h,ringO,streakS,streakWF); }
  return clamp(color * brightnessF, vec4f(0.0), vec4f(1.0));
}
