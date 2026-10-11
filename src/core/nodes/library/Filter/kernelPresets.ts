/** Built-in convolution kernels, generated for any odd size. */

export interface KernelPreset {
  readonly id: string;
  readonly label: string;
  build(size: number): number[];
}

const at = (size: number, f: (dx: number, dy: number) => number): number[] => {
  const r = (size - 1) / 2;
  const out: number[] = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out.push(f(x - r, y - r));
  return out;
};

/** Binomial row (1 2 1, 1 4 6 4 1, …) — a Gaussian approximation. */
function binomial(size: number): number[] {
  let row = [1];
  for (let i = 1; i < size; i++) row = [...row, 0].map((v, j) => v + (j > 0 ? row[j - 1] : 0));
  return row;
}

/** A 3×3 kernel centred in a larger grid. */
const centred3 = (k: readonly number[]) => (size: number) =>
  at(size, (dx, dy) => (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 ? k[(dy + 1) * 3 + dx + 1] : 0));

export const KERNEL_PRESETS: readonly KernelPreset[] = [
  { id: "identity", label: "Identity", build: (n) => at(n, (dx, dy) => (dx === 0 && dy === 0 ? 1 : 0)) },
  { id: "box", label: "Box Blur", build: (n) => at(n, () => 1) },
  {
    id: "gaussian",
    label: "Gaussian Blur",
    build: (n) => {
      const b = binomial(n);
      const r = (n - 1) / 2;
      return at(n, (dx, dy) => b[dx + r] * b[dy + r]);
    },
  },
  {
    // Identity + (identity − Gaussian): unsharp masking.
    id: "sharpen",
    label: "Sharpen",
    build: (n) => {
      const b = binomial(n);
      const r = (n - 1) / 2;
      const total = b.reduce((s, v) => s + v, 0) ** 2;
      return at(n, (dx, dy) => (dx === 0 && dy === 0 ? 2 : 0) - (b[dx + r] * b[dy + r]) / total);
    },
  },
  {
    id: "edges",
    label: "Edge Detect",
    build: (n) => at(n, (dx, dy) => (dx === 0 && dy === 0 ? n * n - 1 : -1)),
  },
  { id: "emboss", label: "Emboss", build: centred3([-2, -1, 0, -1, 1, 1, 0, 1, 2]) },
  { id: "sobelX", label: "Sobel X", build: centred3([-1, 0, 1, -2, 0, 2, -1, 0, 1]) },
  { id: "sobelY", label: "Sobel Y", build: centred3([-1, -2, -1, 0, 0, 0, 1, 2, 1]) },
];
