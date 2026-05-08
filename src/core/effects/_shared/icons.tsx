/** Generic fallback shown when an effect doesn't define its own icon. */
export const EffectFallbackIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.2"
    aria-hidden="true"
  >
    <circle cx="6" cy="6" r="1.8" />
    <circle cx="6" cy="6" r="4" />
  </svg>
);

/** Shared by the distortion effects (Pinch, PolarCoordinates, Ripple, Shear,
 *  Twirl, Displace, LensDistortion) — they all currently render with the
 *  same SVG. */
export const DistortionIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <rect x="1.5" y="1.5" width="9" height="9" rx="1" />
    <path d="M2.5 4 Q6 2.6 9.5 4" />
    <path d="M2.5 8 Q6 9.4 9.5 8" />
    <path d="M4 2.5 Q2.6 6 4 9.5" />
    <path d="M8 2.5 Q9.4 6 8 9.5" />
  </svg>
);
