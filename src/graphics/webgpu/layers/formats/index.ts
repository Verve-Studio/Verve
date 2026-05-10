import type { PixelFormat } from "@/types";
import type { PixelFormatStrategy } from "./PixelFormatStrategy";
import { Rgba8Strategy } from "./Rgba8Strategy";
import { Rgba32fStrategy } from "./Rgba32fStrategy";
import { Indexed8Strategy } from "./Indexed8Strategy";

const STRATEGIES: Record<PixelFormat, PixelFormatStrategy> = {
  rgba8: Rgba8Strategy,
  rgba32f: Rgba32fStrategy,
  indexed8: Indexed8Strategy,
};

export function getStrategy(format: PixelFormat): PixelFormatStrategy {
  return STRATEGIES[format];
}

export type { PixelFormatStrategy } from "./PixelFormatStrategy";
export { Rgba8Strategy, Rgba32fStrategy, Indexed8Strategy };
