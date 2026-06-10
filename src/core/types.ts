/** Options accepted by the engine and the `<LiquidGlass>` component. */
export interface LiquidGlassOptions {
  /** Lens width in px. */
  width: number;
  /** Lens height in px. */
  height: number;
  /** Corner radius in px, or `"auto"` for a fully rounded pill/circle. */
  radius: number | "auto";

  /**
   * Refraction strength as a fraction of the container size (0–0.25 is a
   * sensible range). Cheap to change: does not regenerate the map.
   */
  strength: number;
  /** Chromatic aberration along the lens edge, 0–1. */
  chromaticAberration: number;
  /** Gaussian blur of the refracted content in px. */
  blur: number;

  /** Width of the refracting edge band in px. Larger = thicker glass rim. */
  depth: number;
  /**
   * Lens profile, 0–1. At 0 displacement ramps linearly from the center;
   * at 1 the lens is a full spherical dome.
   */
  curvature: number;
  /**
   * How much displacement near an edge stays perpendicular to it, 0–1.
   * 1 splays the refraction outwards at the corners, 0 keeps it radial.
   */
  splay: number;

  /** Inner specular glow strength, 0–1. */
  glow: number;
  /** Fraction of the lens the glow spreads across, 0–1. */
  glowSpread: number;
  /** Falloff exponent of the glow. */
  glowExponent: number;
  /** Bright rim along the lens edge, 0–1. */
  edgeHighlight: number;
  /** Width of the edge highlight band in px. */
  edgeWidth: number;
  /** Falloff exponent of the edge highlight. */
  edgeExponent: number;
  /** Master intensity of the baked specular pass (glow + edge), 0–2. */
  specular: number;
  /** Direction of the specular light in degrees. */
  specularAngle: number;

  /** Resolution of the generated displacement map (power of two). */
  quality: number;
}

export const DEFAULT_OPTIONS: LiquidGlassOptions = {
  width: 160,
  height: 120,
  radius: "auto",
  strength: 0.1,
  chromaticAberration: 0.2,
  blur: 0,
  depth: 10,
  curvature: 0.65,
  splay: 1,
  glow: 0.1,
  glowSpread: 1,
  glowExponent: 1.5,
  edgeHighlight: 0.25,
  edgeWidth: 3,
  edgeExponent: 1.5,
  specular: 1,
  specularAngle: 45,
  quality: 512,
};

/** Parameters of the raw displacement-map computation, all in lens space. */
export interface DisplacementMapParams {
  /** Output bitmap size (square, even). */
  size: number;
  halfWidth: number;
  halfHeight: number;
  radius: number;
  depth: number;
  /** Dome depth in px; 0 for a linear profile. */
  domeDepth: number;
  splay: number;
  glow: number;
  glowSpread: number;
  glowExponent: number;
  edgeHighlight: number;
  edgeWidth: number;
  edgeExponent: number;
  specularAngle: number;
}
