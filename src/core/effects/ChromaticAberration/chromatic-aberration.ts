// Chromatic Aberration render shader.
//
// Supports two modes selected by CAParams.aberrationType:
//   0 = Radial   — R/B channels displaced outward/inward from image centre
//   1 = Directional — R/B channels displaced along a fixed angle
//
// In both modes the green channel is kept at the original sample position.
// R is displaced by +distance, B by -distance (in the relevant direction).

import CHROMATIC_ABERRATION_COMPUTE from "./wgsl/chromatic-aberration.wgsl?raw";
export { CHROMATIC_ABERRATION_COMPUTE };
