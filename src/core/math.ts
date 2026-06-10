/** Fast error-function approximation, used for the smooth edge falloff. */
export function erf(x: number): number {
  return Math.tanh(1.7724538509 * x);
}

export interface DomeConstants {
  Rx: number;
  Ry: number;
  scaleX: number;
  scaleY: number;
}

/**
 * Average gradient magnitude of a circular cap of radius `R` sampled across
 * `half`. Used to normalize the dome profile so its mean refraction strength
 * matches the linear profile, keeping `strength` perceptually stable while
 * `curvature` changes.
 */
function averageDomeGradient(R: number, half: number): number {
  let sum = 0;
  for (let i = 0; i <= 200; i++) {
    const s = (i / 200) * half;
    const v = s / Math.sqrt(R * R - s * s);
    sum += i === 0 || i === 200 ? 0.5 * v : v;
  }
  return sum / 200;
}

/** Sphere radii + normalization for a dome of `depth` px over the lens. */
export function computeDomeConstants(
  depth: number,
  halfWidth: number,
  halfHeight: number,
): DomeConstants {
  const d = Math.max(0.01, Math.min(depth, Math.min(halfWidth, halfHeight) - 1));
  const Rx = (halfWidth * halfWidth + d * d) / (2 * d);
  const Ry = (halfHeight * halfHeight + d * d) / (2 * d);
  const gx = averageDomeGradient(Rx, halfWidth);
  const gy = averageDomeGradient(Ry, halfHeight);
  return {
    Rx,
    Ry,
    scaleX: gx > 0 ? 0.5 / gx : 1,
    scaleY: gy > 0 ? 0.5 / gy : 1,
  };
}

/** Surface gradient of the dome at offset `x` from the lens center. */
export function domeGradient(x: number, R: number, scale: number): number {
  const s = Math.min(x, 0.999 * R);
  return (s / Math.sqrt(R * R - s * s)) * scale;
}
