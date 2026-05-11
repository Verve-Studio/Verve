import BLIT_SHADER from "./wgsl/blit.wgsl?raw";
export { BLIT_SHADER };

export const FBO_BLIT_SHADER = BLIT_SHADER;

// ─── HDR display blit shader ──────────────────────────────────────────────────
// Used only for the on-screen display blit. Branches internally on isFp32 so
// a single pipeline handles both rgba8 (pass-through) and rgba32f (tone-map).

import HDR_BLIT_SHADER from "./wgsl/hdr-blit.wgsl?raw";
export { HDR_BLIT_SHADER };
