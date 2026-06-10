import { describe, expect, it } from "vitest";
import { computeDisplacementMap } from "./displacementMap";
import type { DisplacementMapParams } from "./types";

const base: DisplacementMapParams = {
  size: 64,
  halfWidth: 70,
  halfHeight: 60,
  radius: 28,
  depth: 10,
  domeDepth: 40,
  splay: 1,
  glow: 0.1,
  glowSpread: 1,
  glowExponent: 1.5,
  edgeHighlight: 0.25,
  edgeWidth: 3,
  edgeExponent: 1.5,
  specularAngle: 45,
};

function px(data: Uint8ClampedArray, size: number, x: number, y: number) {
  const i = (y * size + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

describe("computeDisplacementMap", () => {
  it("is opaque inside the lens, transparent outside (alpha = shape mask)", () => {
    const data = computeDisplacementMap(base);
    const c = base.size / 2;
    expect(px(data, base.size, c, c).a).toBe(255);
    expect(px(data, base.size, 0, 0).a).toBe(0);
  });

  it("is neutral outside the rounded-rect lens", () => {
    const data = computeDisplacementMap(base);
    const corner = px(data, base.size, 0, 0);
    expect(corner).toEqual({ r: 128, g: 128, b: 128, a: 0 });
  });

  it("is near-neutral at the center", () => {
    const data = computeDisplacementMap(base);
    const c = base.size / 2;
    const center = px(data, base.size, c, c);
    expect(Math.abs(center.r - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(center.g - 128)).toBeLessThanOrEqual(2);
  });

  it("displaces opposite directions on opposite sides", () => {
    const data = computeDisplacementMap(base);
    const mid = base.size / 2;
    const left = px(data, base.size, 8, mid);
    const right = px(data, base.size, base.size - 1 - 8, mid);
    expect(left.r).toBeGreaterThan(128);
    expect(right.r).toBeLessThan(128);
    // Mirror symmetry within rounding error.
    expect(Math.abs(left.r + right.r - 255)).toBeLessThanOrEqual(1);
    expect(left.g).toBe(right.g);
  });

  it("has four-fold displacement symmetry", () => {
    const data = computeDisplacementMap(base);
    const s = base.size;
    for (const [x, y] of [
      [5, 9],
      [12, 20],
      [20, 30],
    ] as const) {
      const tl = px(data, s, x, y);
      const tr = px(data, s, s - 1 - x, y);
      const bl = px(data, s, x, s - 1 - y);
      const br = px(data, s, s - 1 - x, s - 1 - y);
      expect(Math.abs(tl.r + tr.r - 255)).toBeLessThanOrEqual(1);
      expect(Math.abs(tl.g + bl.g - 255)).toBeLessThanOrEqual(1);
      expect(tl.r).toBe(bl.r);
      expect(tl.g).toBe(tr.g);
      expect(tl.b).toBe(br.b);
      expect(tr.b).toBe(bl.b);
    }
  });

  it("bakes no specular when glow and edge highlight are zero", () => {
    const data = computeDisplacementMap({ ...base, glow: 0, edgeHighlight: 0 });
    for (let i = 2; i < data.length; i += 4) expect(data[i]).toBe(128);
  });

  it("bakes a specular mask >= neutral when enabled", () => {
    const data = computeDisplacementMap(base);
    let max = 0;
    for (let i = 2; i < data.length; i += 4) {
      expect(data[i]).toBeGreaterThanOrEqual(128);
      if (data[i] > max) max = data[i];
    }
    expect(max).toBeGreaterThan(140);
  });

  it("respects the sharp boundary when radius is 0", () => {
    const data = computeDisplacementMap({ ...base, radius: 0, depth: 5 });
    // Just inside each corner of the lens rect should be active (non-neutral
    // somewhere in the map), corners of the bitmap outside still neutral.
    const inside = px(data, base.size, 1, 1);
    expect(inside.a).toBe(255);
  });
});
