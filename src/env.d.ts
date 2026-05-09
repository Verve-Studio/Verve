/// <reference types="vite/client" />

declare module "*.module.scss" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*.scss" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*.css" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "gifenc" {
  type QuantizeFormat = "rgb565" | "rgb444" | "rgba4444";
  type Palette =
    | [number, number, number][]
    | [number, number, number, number][];

  export interface WriteFrameOptions {
    transparent?: boolean;
    transparentIndex?: number;
    /** Frame display delay in milliseconds. */
    delay?: number;
    palette?: Palette;
    /** 0 = loop forever, -1 = play once, N = loop N times. Only honoured
     *  on the first frame. */
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
    first?: boolean;
  }

  export interface GIFEncoderInstance {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    readonly buffer: ArrayBuffer;
    writeHeader(): void;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: WriteFrameOptions,
    ): void;
  }

  export function GIFEncoder(options?: {
    initialCapacity?: number;
    auto?: boolean;
  }): GIFEncoderInstance;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: {
      format?: QuantizeFormat;
      clearAlpha?: boolean;
      clearAlphaColor?: number;
      clearAlphaThreshold?: number;
      oneBitAlpha?: boolean | number;
    },
  ): Palette;
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: QuantizeFormat,
  ): Uint8Array;
}
