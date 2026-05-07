/**
 * Full-canvas quad as two triangles. Position helpers are wrapped in a function
 * because the quad is sized to the canvas, while UVs are static.
 */

export const QUAD_POSITIONS = (w: number, h: number): Float32Array =>
  new Float32Array([0, 0, w, 0, 0, h, 0, h, w, 0, w, h]);

export const QUAD_UVS = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
