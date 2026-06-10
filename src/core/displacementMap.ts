import { computeDomeConstants, domeGradient, erf } from "./math";
import type { DisplacementMapParams } from "./types";

/**
 * Computes the displacement map as raw RGBA pixels.
 *
 * Red encodes horizontal displacement and green vertical (128 = neutral).
 * Blue carries the baked specular mask (glow + edge highlight). Outside the
 * rounded-rect lens every pixel is neutral, so the filter leaves those
 * pixels untouched.
 *
 * The map has four-fold symmetry: only the top-left quadrant is computed and
 * each pixel is written into all four quadrants, negating X displacement
 * across the vertical axis and Y across the horizontal one. The specular
 * projection |x·cosθ ± y·sinθ| yields two values per quadrant pair, which is
 * what the sum/diff split below handles.
 *
 * Pure function (no DOM), so it is unit-testable and worker-friendly.
 */
export function computeDisplacementMap(p: DisplacementMapParams): Uint8ClampedArray {
  const size = p.size;
  const half = size >> 1;
  const data = new Uint8ClampedArray(size * size * 4);

  const hw = p.halfWidth;
  const hh = p.halfHeight;

  const cornerR = Math.min(p.radius, Math.min(hw, hh));
  const innerW = Math.max(0, hw - p.depth);
  const innerH = Math.max(0, hh - p.depth);
  const innerR = Math.max(0, Math.min(p.radius, Math.min(innerW, innerH)));
  const falloffK = p.depth > 0 ? 1 / (p.depth * Math.SQRT2) : 1e6;

  const hasSpecular = p.glow > 0 || p.edgeHighlight > 0;
  const theta = (p.specularAngle * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const glowLo = (1 - p.glowSpread) * Math.SQRT2;
  const glowRange = p.glowSpread * Math.SQRT2;
  const glowInv = glowRange > 0.001 ? 1 / glowRange : 0;
  const edgeInv = p.edgeWidth > 0 ? 1 / p.edgeWidth : 0;

  const stepX = (2 * hw) / size;
  const stepY = (2 * hh) / size;
  const invW = 1 / hw;
  const invH = 1 / hh;

  const dome = p.domeDepth > 0 ? computeDomeConstants(p.domeDepth, hw, hh) : null;
  let domeColumns: Float32Array | null = null;
  if (dome) {
    domeColumns = new Float32Array(half);
    const rr = dome.Rx * dome.Rx;
    const cap = 0.999 * dome.Rx;
    for (let c = 0; c < half; c++) {
      const ax = -((c + 0.5) * stepX - hw);
      const s = ax < cap ? ax : cap;
      domeColumns[c] = (s / Math.sqrt(rr - s * s)) * dome.scaleX;
    }
  }

  const doSplay = p.splay < 1;
  const splayMix = 1 - p.splay;
  const splayHalf = 0.5 * Math.min(hw, hh);
  const splayInv = splayHalf > 0 ? 1 / splayHalf : 0;

  for (let row = 0; row < half; row++) {
    const mirrorRow = size - 1 - row;
    const ay = -((row + 0.5) * stepY - hh); // positive y offset (top half)
    const sdfY = ay - hh + cornerR;
    const fallY = ay - innerH + innerR;
    const gradY = dome
      ? domeGradient(ay, dome.Ry, dome.scaleY)
      : ay * invH > 1
        ? 1
        : ay * invH;
    const clampY = ay * invH > 1 ? 1 : ay * invH;
    const splayY = doSplay ? Math.max(0, 1 - (hh - ay) * splayInv) : 0;

    for (let col = 0; col < half; col++) {
      const mirrorCol = size - 1 - col;
      const ax = -((col + 0.5) * stepX - hw); // positive x offset (left half)
      const sdfX = ax - hw + cornerR;

      // Signed distance to the rounded-rect lens boundary.
      const ox = sdfX > 0 ? sdfX : 0;
      const oy = sdfY > 0 ? sdfY : 0;
      const oo = ox * ox + oy * oy;
      const sdf =
        (oo > 0 ? Math.sqrt(oo) : 0) +
        (sdfX > sdfY ? (sdfX > 0 ? 0 : sdfX) : sdfY > 0 ? 0 : sdfY) -
        cornerR;

      const iTL = (row * size + col) * 4;
      const iTR = (row * size + mirrorCol) * 4;
      const iBL = (mirrorRow * size + col) * 4;
      const iBR = (mirrorRow * size + mirrorCol) * 4;

      if (sdf >= 0) {
        // Outside the lens: neutral color, transparent alpha. The alpha
        // channel doubles as the lens-shape mask in the filter, so blur and
        // refraction clip to the rounded shape instead of the bounding rect.
        data[iTL] = data[iTL + 1] = data[iTL + 2] = 128;
        data[iTR] = data[iTR + 1] = data[iTR + 2] = 128;
        data[iBL] = data[iBL + 1] = data[iBL + 2] = 128;
        data[iBR] = data[iBR + 1] = data[iBR + 2] = 128;
        data[iTL + 3] = data[iTR + 3] = data[iBL + 3] = data[iBR + 3] = 0;
        continue;
      }

      let dispX = dome && domeColumns ? domeColumns[col] : ax * invW > 1 ? 1 : ax * invW;
      let dispY = gradY;

      if (doSplay) {
        const attX = splayY * splayMix; // damps X displacement near top/bottom
        const attY = Math.max(0, 1 - (hw - ax) * splayInv) * splayMix; // damps Y near left/right
        if (attX > 0.001 || attY > 0.001) {
          const x0 = dispX;
          const y0 = dispY;
          dispX = x0 * (1 - attX);
          dispY = y0 * (1 - attY);
          const m0 = Math.sqrt(x0 * x0 + y0 * y0);
          const m1 = Math.sqrt(dispX * dispX + dispY * dispY);
          if (m1 > 0.001) {
            const k = m0 / m1;
            dispX *= k;
            dispY *= k;
          }
        }
      }

      // Smooth falloff: flat center, ramping up across the edge band.
      const ex = ax - innerW + innerR;
      const rx = ex > 0 ? ex : 0;
      const ry = fallY > 0 ? fallY : 0;
      const innerSdf =
        Math.sqrt(rx * rx + ry * ry) +
        (ex > fallY ? (ex > 0 ? 0 : ex) : fallY > 0 ? 0 : fallY) -
        innerR;
      const fall = 0.5 * (1 + erf(innerSdf * falloffK));

      const hx = 0.5 * dispX * fall;
      const hy = 0.5 * dispY * fall;
      const rPlus = ((0.5 + hx) * 255 + 0.5) | 0;
      const rMinus = ((0.5 - hx) * 255 + 0.5) | 0;
      const gPlus = ((0.5 + hy) * 255 + 0.5) | 0;
      const gMinus = ((0.5 - hy) * 255 + 0.5) | 0;

      let bSum = 128;
      let bDiff = 128;
      if (hasSpecular) {
        const px = (ax * invW > 1 ? 1 : ax * invW) * cosT;
        const py = clampY * sinT;
        const projSum = Math.abs(px + py); // TL and BR quadrants
        const projDiff = Math.abs(px - py); // TR and BL quadrants

        let band = 0;
        if (p.edgeHighlight > 0) {
          band = 1 + sdf * edgeInv;
          if (band < 0) band = 0;
        }

        let vSum = 0;
        let vDiff = 0;
        if (p.glow > 0) {
          const tS = (projSum - glowLo) * glowInv;
          vSum += p.glow * Math.pow(tS < 0 ? 0 : tS > 1 ? 1 : tS, p.glowExponent) * fall;
          const tD = (projDiff - glowLo) * glowInv;
          vDiff += p.glow * Math.pow(tD < 0 ? 0 : tD > 1 ? 1 : tD, p.glowExponent) * fall;
        }
        if (p.edgeHighlight > 0) {
          vSum += p.edgeHighlight * band * Math.pow(projSum, p.edgeExponent);
          vDiff += p.edgeHighlight * band * Math.pow(projDiff, p.edgeExponent);
        }
        if (vSum > 1) vSum = 1;
        if (vDiff > 1) vDiff = 1;
        bSum = (127 * vSum + 128 + 0.5) | 0;
        bDiff = (127 * vDiff + 128 + 0.5) | 0;
      }

      data[iTL] = rPlus;
      data[iTL + 1] = gPlus;
      data[iTL + 2] = bSum;
      data[iTL + 3] = 255;
      data[iTR] = rMinus;
      data[iTR + 1] = gPlus;
      data[iTR + 2] = bDiff;
      data[iTR + 3] = 255;
      data[iBL] = rPlus;
      data[iBL + 1] = gMinus;
      data[iBL + 2] = bDiff;
      data[iBL + 3] = 255;
      data[iBR] = rMinus;
      data[iBR + 1] = gMinus;
      data[iBR + 2] = bSum;
      data[iBR + 3] = 255;
    }
  }

  return data;
}

/**
 * Renders the displacement map to a PNG data URL via a (reusable) canvas.
 */
export function renderDisplacementMap(
  p: DisplacementMapParams,
  canvas: HTMLCanvasElement = document.createElement("canvas"),
): string {
  canvas.width = p.size;
  canvas.height = p.size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const image = ctx.createImageData(p.size, p.size);
  image.data.set(computeDisplacementMap(p));
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}
