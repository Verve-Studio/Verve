import { effectRegistry } from "./effectRegistry";
import { PixelateEffect } from "./PixelateEffect";
import { BrightnessContrastEffect } from "./BrightnessContrastEffect";
import { BloomEffect } from "./BloomEffect";
import { GaussianBlurEffect } from "./GaussianBlurEffect";
import { BoxBlurEffect } from "./BoxBlurEffect";
import { RadialBlurEffect } from "./RadialBlurEffect";
import { MotionBlurEffect } from "./MotionBlurEffect";
import { RemoveMotionBlurEffect } from "./RemoveMotionBlurEffect";
import { LensBlurEffect } from "./LensBlurEffect";
import { SharpenEffect } from "./SharpenEffect";
import { SharpenMoreEffect } from "./SharpenMoreEffect";
import { UnsharpMaskEffect } from "./UnsharpMaskEffect";
import { SmartSharpenEffect } from "./SmartSharpenEffect";
import { AddNoiseEffect } from "./AddNoiseEffect";
import { FilmGrainEffect } from "./FilmGrainEffect";
import { MedianFilterEffect } from "./MedianFilterEffect";
import { BilateralFilterEffect } from "./BilateralFilterEffect";
import { ReduceNoiseEffect } from "./ReduceNoiseEffect";
import { CloudsEffect } from "./CloudsEffect";
import { OffsetEffect } from "./OffsetEffect";
import { SeamlessTextureEffect } from "./SeamlessTextureEffect";
import { HueSaturationEffect } from "./HueSaturationEffect";
import { ColorVibranceEffect } from "./ColorVibranceEffect";
import { ColorBalanceEffect } from "./ColorBalanceEffect";
import { BlackAndWhiteEffect } from "./BlackAndWhiteEffect";
import { ColorTemperatureEffect } from "./ColorTemperatureEffect";
import { HalftoneEffect } from "./HalftoneEffect";
import { ColorKeyEffect } from "./ColorKeyEffect";
import { ChromaticAberrationEffect } from "./ChromaticAberrationEffect";
import { VignetteEffect } from "./VignetteEffect";
import { LensDistortionEffect } from "./LensDistortionEffect";
import { PinchEffect } from "./PinchEffect";
import { PolarCoordinatesEffect } from "./PolarCoordinatesEffect";
import { RippleEffect } from "./RippleEffect";
import { ShearEffect } from "./ShearEffect";
import { TwirlEffect } from "./TwirlEffect";
import { DisplaceEffect } from "./DisplaceEffect";
import { ColorInvertEffect } from "./ColorInvertEffect";
import { SelectiveColorEffect } from "./SelectiveColorEffect";
import { ChannelMixerEffect } from "./ChannelMixerEffect";
import { AutoMatchEffect } from "./AutoMatchEffect";
import { CurvesEffect } from "./CurvesEffect";
import { ColorGradingEffect } from "./ColorGradingEffect";
import { ReduceColorsEffect } from "./ReduceColorsEffect";
import { ColorDitheringEffect } from "./ColorDitheringEffect";
import { HalationEffect } from "./HalationEffect";
import { DropShadowEffect } from "./DropShadowEffect";
import { GlowEffect } from "./GlowEffect";
import { OutlineEffect } from "./OutlineEffect";
import { BevelEffect } from "./BevelEffect";
import { InnerShadowEffect } from "./InnerShadowEffect";
import { InnerGlowEffect } from "./InnerGlowEffect";
import { LensFlareEffect } from "./LensFlareEffect";

// Eager registration — importing this module is the single side-effecting step
// that makes registered effects reachable through the plan builder, encoder,
// and panel host. Add new effects here.
effectRegistry.register(PixelateEffect);
effectRegistry.register(BrightnessContrastEffect);
effectRegistry.register(BloomEffect);
effectRegistry.register(GaussianBlurEffect);
effectRegistry.register(BoxBlurEffect);
effectRegistry.register(RadialBlurEffect);
effectRegistry.register(MotionBlurEffect);
effectRegistry.register(RemoveMotionBlurEffect);
effectRegistry.register(LensBlurEffect);
effectRegistry.register(SharpenEffect);
effectRegistry.register(SharpenMoreEffect);
effectRegistry.register(UnsharpMaskEffect);
effectRegistry.register(SmartSharpenEffect);
effectRegistry.register(AddNoiseEffect);
effectRegistry.register(FilmGrainEffect);
effectRegistry.register(MedianFilterEffect);
effectRegistry.register(BilateralFilterEffect);
effectRegistry.register(ReduceNoiseEffect);
effectRegistry.register(CloudsEffect);
effectRegistry.register(OffsetEffect);
effectRegistry.register(SeamlessTextureEffect);
effectRegistry.register(HueSaturationEffect);
effectRegistry.register(ColorVibranceEffect);
effectRegistry.register(ColorBalanceEffect);
effectRegistry.register(BlackAndWhiteEffect);
effectRegistry.register(ColorTemperatureEffect);
effectRegistry.register(HalftoneEffect);
effectRegistry.register(ColorKeyEffect);
effectRegistry.register(ChromaticAberrationEffect);
effectRegistry.register(VignetteEffect);
effectRegistry.register(LensDistortionEffect);
effectRegistry.register(PinchEffect);
effectRegistry.register(PolarCoordinatesEffect);
effectRegistry.register(RippleEffect);
effectRegistry.register(ShearEffect);
effectRegistry.register(TwirlEffect);
effectRegistry.register(DisplaceEffect);
effectRegistry.register(ColorInvertEffect);
effectRegistry.register(SelectiveColorEffect);
effectRegistry.register(ChannelMixerEffect);
effectRegistry.register(AutoMatchEffect);
effectRegistry.register(CurvesEffect);
effectRegistry.register(ColorGradingEffect);
effectRegistry.register(ReduceColorsEffect);
effectRegistry.register(ColorDitheringEffect);
effectRegistry.register(HalationEffect);
effectRegistry.register(DropShadowEffect);
effectRegistry.register(GlowEffect);
effectRegistry.register(OutlineEffect);
effectRegistry.register(BevelEffect);
effectRegistry.register(InnerShadowEffect);
effectRegistry.register(InnerGlowEffect);
effectRegistry.register(LensFlareEffect);

export { effectRegistry } from "./effectRegistry";
export type {
  IPipelineEffect,
  MenuPlacement,
  MenuRoot,
  PanelProps,
  PlanContext,
  EncodeContext,
} from "./IPipelineEffect";
