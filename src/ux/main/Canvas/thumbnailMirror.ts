/**
 * Version counter for the canvas's 2D thumbnail mirror (drawn by
 * `useCanvasRenderLoop`). Readers such as the Navigator compare it to the
 * version they last drew, and skip copying the mirror when nothing changed.
 */
let version = 0;

export const thumbnailMirror = {
  get version(): number {
    return version;
  },
  bump(): void {
    version++;
  },
};
