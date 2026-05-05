/**
 * Computes a sourceMask for content-aware inpainting.
 * radiusPx = 0 → returns null (unconstrained, sample entire image).
 * radiusPx > 0 → BFS from fill-boundary pixels outward; marks pixels
 *                within radiusPx pixels as eligible (1), rest as 0.
 */
export function computeSourceMask(
  fillMask: Uint8Array,
  width: number,
  height: number,
  radiusPx: number,
): Uint8Array | null {
  if (radiusPx <= 0) return null;

  const n = width * height;
  const dist = new Int32Array(n).fill(-1); // -1 = not yet reached / not a fill pixel
  const queue: number[] = [];
  const dx4 = [-1, 1, 0, 0];
  const dy4 = [0, 0, -1, 1];

  // Seed: source pixels adjacent to fill boundary get dist 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (fillMask[idx]) continue; // fill pixel, not a source candidate
      for (let d = 0; d < 4; d++) {
        const nx = x + dx4[d],
          ny = y + dy4[d];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if (fillMask[ny * width + nx]) {
          dist[idx] = 0;
          queue.push(idx);
          break;
        }
      }
    }
  }

  // BFS outward
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cy = Math.floor(cur / width);
    const cx = cur % width;
    const curDist = dist[cur];
    if (curDist >= radiusPx) continue;
    for (let d = 0; d < 4; d++) {
      const nx = cx + dx4[d],
        ny = cy + dy4[d];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      if (fillMask[ni]) continue; // fill pixel
      if (dist[ni] !== -1) continue;
      dist[ni] = curDist + 1;
      queue.push(ni);
    }
  }

  // Build mask: 1 if dist >= 0 (reachable within radius), 0 otherwise
  const result = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!fillMask[i] && dist[i] >= 0) result[i] = 1;
  }
  return result;
}
