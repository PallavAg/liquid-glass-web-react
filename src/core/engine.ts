import { renderDisplacementMap } from "./displacementMap";
import { DEFAULT_OPTIONS, type LiquidGlassOptions } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

/** DOM elements the engine drives. */
export interface LiquidGlassHost {
  /** Element the lens lives in; overlays are positioned relative to it. */
  container: HTMLElement;
  /**
   * Wrapper around the refracted content; receives `style.filter`. The SVG
   * filter's coordinate space belongs to this element, so all lens math is
   * measured against it.
   */
  filtered: HTMLElement;
  /** Empty element the engine renders the `<svg><defs>` filter into. */
  defsHost: HTMLElement;
  /** Optional element positioned over the lens (shadow / rim chrome). */
  shadow?: HTMLElement | null;
}

let instanceCounter = 0;

const UA = typeof navigator !== "undefined" ? navigator.userAgent : "";
/**
 * iOS WebKit (every iOS browser) misplaces filter primitive subregions
 * expressed in objectBoundingBox units, so the engine runs the filter in
 * userSpaceOnUse units there instead.
 */
const IS_IOS =
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(UA) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
/**
 * Safari caches SVG filter output by filter ID and keeps serving stale
 * results when attributes change. Only there does every update need a fresh
 * ID; forcing it on other engines would rebuild the filter chain per frame.
 */
const IS_SAFARI = IS_IOS || /^((?!chrome|chromium|android).)*safari/i.test(UA);

function fe(name: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, name);
  for (const key of Object.keys(attrs)) el.setAttribute(key, String(attrs[key]));
  return el;
}

/**
 * Imperative core of liquid-glass-web-react. Owns the SVG filter, the displacement map
 * and all per-frame attribute updates. Framework-agnostic by design; the
 * React component is a thin wrapper around this class.
 *
 * Two update paths, mirroring how the effect stays cheap to animate:
 * - `setPosition` / fast options only move the filter's lens subregion and
 *   never touch the map.
 * - Shape/surface options regenerate the map, throttled to one per frame.
 */
export class LiquidGlassEngine {
  private host: LiquidGlassHost;
  private options: LiquidGlassOptions;

  private filterEl: SVGElement | null = null;
  private feImageEl: SVGElement | null = null;
  private lensRegionEls: SVGElement[] = [];
  private dispEls: SVGElement[] = [];
  private blurEl: SVGElement | null = null;
  private specularEl: SVGElement | null = null;

  private x = 0.5;
  private y = 0.5;
  private mapUrl = "";
  private mapCanvas: HTMLCanvasElement | null = null;

  private readonly id: string;
  private version = 0;
  private regenQueued = false;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;
  private warnedFootprint = false;

  /** Called whenever a new displacement map has been generated. */
  onMap: ((url: string) => void) | null = null;

  constructor(host: LiquidGlassHost, options?: Partial<LiquidGlassOptions>) {
    this.host = host;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.id = `liquid-glass-web-react-${++instanceCounter}`;

    this.buildFilter();
    this.regenerate();

    this.resizeObserver = new ResizeObserver(() => this.update());
    this.resizeObserver.observe(host.container);
    if (host.filtered !== host.container) this.resizeObserver.observe(host.filtered);
  }

  /** Lens center as fractions (0–1) of the glass surface (filtered box). */
  setPosition(x: number, y: number): void {
    this.x = Math.min(1, Math.max(0, x));
    this.y = Math.min(1, Math.max(0, y));
    this.update();
  }

  getPosition(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /** Latest generated displacement map as a PNG data URL. */
  getMapUrl(): string {
    return this.mapUrl;
  }

  /** Merge new options; regenerates the map only when the shape changed. */
  setOptions(partial: Partial<LiquidGlassOptions>): void {
    const prev = this.options;
    const next = { ...prev, ...partial };
    this.options = next;

    const needsRegen = (
      [
        "width",
        "height",
        "radius",
        "depth",
        "curvature",
        "splay",
        "glow",
        "glowSpread",
        "glowExponent",
        "edgeHighlight",
        "edgeWidth",
        "edgeExponent",
        "specularAngle",
        "quality",
      ] as const
    ).some((key) => prev[key] !== next[key]);

    if (needsRegen) this.scheduleRegenerate();
    else this.update();
  }

  getOptions(): LiquidGlassOptions {
    return { ...this.options };
  }

  /** Re-measure and re-apply everything (e.g. after layout changes). */
  refresh(): void {
    this.update();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.host.filtered.style.filter = "";
    this.host.defsHost.replaceChildren();
    if (this.mapCanvas) {
      this.mapCanvas.width = 0;
      this.mapCanvas.height = 0;
      this.mapCanvas = null;
    }
  }

  // -- internals ----------------------------------------------------------

  private get halfWidth(): number {
    return this.options.width / 2;
  }

  private get halfHeight(): number {
    return this.options.height / 2;
  }

  private get cornerRadius(): number {
    const { radius } = this.options;
    const max = Math.min(this.halfWidth, this.halfHeight);
    return radius === "auto" ? max : Math.min(radius, max);
  }

  /**
   * Builds the filter primitive chain:
   *
   *   neutral flood ─ feImage(map at lens) ─▶ map
   *   source ─ feGaussianBlur(optional) ─▶ blurred
   *   3 × feDisplacementMap at offset scales, one per RGB channel,
   *     recombined additively ─▶ chromatic refraction
   *   map blue channel ─▶ specular highlight, composited over
   *   lens punched out of source, refraction composited back in
   *
   * Everything tagged `data-lens` is restricted to the lens subregion, so
   * content outside the lens is the browser's original render and the
   * filter's cost scales with the lens, not the container.
   */
  private buildFilter(): void {
    const units = IS_IOS ? "userSpaceOnUse" : "objectBoundingBox";
    const filter = fe("filter", {
      filterUnits: units,
      primitiveUnits: units,
      "color-interpolation-filters": "sRGB",
      x: 0,
      y: 0,
      width: 1, // userSpaceOnUse sizes are set in px on every update
      height: 1,
    });

    filter.appendChild(
      fe("feFlood", { "flood-color": "rgb(128,128,128)", "flood-opacity": 1, result: "mapBg" }),
    );
    this.feImageEl = fe("feImage", {
      "data-lens": "",
      preserveAspectRatio: "none",
      result: "rawMap",
    });
    filter.appendChild(this.feImageEl);
    filter.appendChild(fe("feComposite", { in: "rawMap", in2: "mapBg", operator: "over", result: "map" }));

    this.blurEl = fe("feGaussianBlur", { in: "SourceGraphic", stdDeviation: "0 0", result: "blurred" });
    filter.appendChild(this.blurEl);

    const channelMatrices = [
      "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0",
      "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0",
      "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0",
    ];
    const results = ["dispR", "dispG", "dispB"];
    for (let i = 0; i < 3; i++) {
      filter.appendChild(
        fe("feDisplacementMap", {
          "data-lens": "",
          in: "SourceGraphic",
          in2: "map",
          scale: 0,
          xChannelSelector: "R",
          yChannelSelector: "G",
        }),
      );
      filter.appendChild(fe("feColorMatrix", { type: "matrix", values: channelMatrices[i], result: results[i] }));
    }
    filter.appendChild(
      fe("feComposite", { in: "dispR", in2: "dispG", operator: "arithmetic", k1: 0, k2: 1, k3: 1, k4: 0 }),
    );
    filter.appendChild(
      fe("feComposite", { in2: "dispB", operator: "arithmetic", k1: 0, k2: 1, k3: 1, k4: 0, result: "lensResult" }),
    );

    // The specular pass costs whatever area it reads. On Safari, reading the
    // lens-sized rawMap instead of the full-region map produces an identical
    // result (outside the lens both resolve to zero alpha) at a fraction of
    // the cost. Chromium shows sub-pixel flicker along the lens edge with the
    // restricted read, so it keeps the full-region input.
    filter.appendChild(
      fe("feColorMatrix", {
        in: IS_SAFARI ? "rawMap" : "map",
        type: "matrix",
        values: `0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 1 0 ${-128 / 255}`,
        result: "specMask",
      }),
    );
    this.specularEl = fe("feComposite", {
      in: "specMask",
      in2: "lensResult",
      operator: "arithmetic",
      k1: 0,
      k2: this.options.specular,
      k3: 1,
      k4: 0,
      result: "lensResult",
    });
    filter.appendChild(this.specularEl);

    // The map's alpha channel is the exact lens shape. Clip the refracted
    // result to it and punch the same shape out of the source, so the lens
    // (and any blur) follows the rounded geometry, not its bounding rect.
    filter.appendChild(
      fe("feColorMatrix", {
        in: "rawMap",
        type: "matrix",
        values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0",
        result: "lensShape",
      }),
    );
    filter.appendChild(
      fe("feComposite", { in: "lensResult", in2: "lensShape", operator: "in", result: "lensResult" }),
    );
    filter.appendChild(fe("feComposite", { in: "SourceGraphic", in2: "lensShape", operator: "out", result: "holedSG" }));
    filter.appendChild(fe("feComposite", { in: "lensResult", in2: "holedSG", operator: "over" }));

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    const defs = document.createElementNS(SVG_NS, "defs");
    defs.appendChild(filter);
    svg.appendChild(defs);
    this.host.defsHost.replaceChildren(svg);

    this.filterEl = filter;
    this.lensRegionEls = Array.from(filter.querySelectorAll("[data-lens]"));
    this.dispEls = Array.from(filter.querySelectorAll("feDisplacementMap"));
  }

  private scheduleRegenerate(): void {
    if (this.regenQueued) return;
    this.regenQueued = true;
    this.rafId = requestAnimationFrame(() => {
      this.regenQueued = false;
      this.rafId = null;
      if (!this.destroyed) this.regenerate();
    });
  }

  private regenerate(): void {
    const o = this.options;
    const hw = this.halfWidth;
    const hh = this.halfHeight;
    if (!this.mapCanvas) this.mapCanvas = document.createElement("canvas");

    this.mapUrl = renderDisplacementMap(
      {
        size: o.quality,
        halfWidth: hw,
        halfHeight: hh,
        radius: this.cornerRadius,
        depth: o.depth,
        domeDepth: Math.max(0, Math.min(1, o.curvature)) * Math.min(hw, hh),
        splay: o.splay,
        glow: o.glow,
        glowSpread: o.glowSpread,
        glowExponent: o.glowExponent,
        edgeHighlight: o.edgeHighlight,
        edgeWidth: o.edgeWidth,
        edgeExponent: o.edgeExponent,
        specularAngle: o.specularAngle,
      },
      this.mapCanvas,
    );
    this.feImageEl?.setAttribute("href", this.mapUrl);
    this.onMap?.(this.mapUrl);
    this.update();
  }

  /**
   * Fast path: repositions the lens subregion, updates scales/blur, bumps
   * the filter ID. Safari caches filter output by ID and keeps serving stale
   * results otherwise, so every update assigns a fresh one.
   */
  private update(): void {
    if (!this.filterEl || this.destroyed) return;
    // The filter's user space is the filtered element's box. Measuring the
    // container instead would desync the lens whenever the two differ (e.g.
    // padding on the container).
    const rect = this.host.filtered.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    if (W <= 0 || H <= 0) return;

    // Safari caps the source-graphic size an SVG filter can process; past it
    // the effect tiles into mismatched blocks or drops entirely. The exact
    // ceiling varies by version and device, so warn once at a conservative
    // threshold rather than failing silently.
    if (IS_SAFARI && !this.warnedFootprint && W * H > 2_500_000) {
      this.warnedFootprint = true;
      console.warn(
        `[liquid-glass-web-react] Refracting a ${Math.round(W)}×${Math.round(H)}px element. ` +
          "Safari limits the source size an SVG filter can process and may degrade or drop " +
          "the effect — consider scoping the glass to a smaller region on Safari/iOS.",
      );
    }

    const o = this.options;
    const hw = this.halfWidth;
    const hh = this.halfHeight;
    const left = this.x * W - hw;
    const top = this.y * H - hh;
    const bias = 0.5; // shrink the subregion slightly to avoid edge artifacts

    // userSpaceOnUse works in px; objectBoundingBox in fractions of the box.
    const sx = IS_IOS ? 1 : 1 / W;
    const sy = IS_IOS ? 1 : 1 / H;
    if (IS_IOS) {
      this.filterEl.setAttribute("width", String(W));
      this.filterEl.setAttribute("height", String(H));
    }

    const fx = String((left + bias) * sx);
    const fy = String((top + bias) * sy);
    const fw = String(Math.max(0, 2 * hw - 2 * bias) * sx);
    const fh = String(Math.max(0, 2 * hh - 2 * bias) * sy);
    for (const el of this.lensRegionEls) {
      el.setAttribute("x", fx);
      el.setAttribute("y", fy);
      el.setAttribute("width", fw);
      el.setAttribute("height", fh);
    }

    // In objectBoundingBox units the browser resolves a displacement scale
    // of `s` to s·√(W²+H²)/√2 px; in userSpaceOnUse, apply that ourselves so
    // `strength` means the same thing on every platform.
    const s = IS_IOS
      ? (o.strength * Math.sqrt(W * W + H * H)) / Math.SQRT2
      : o.strength;
    const c = o.chromaticAberration;
    const scales = [s * (1 + 0.2 * c), s * (1 + 0.1 * c), s];
    const blurInput = o.blur > 0 ? "blurred" : "SourceGraphic";
    for (let i = 0; i < this.dispEls.length; i++) {
      this.dispEls[i].setAttribute("scale", String(scales[i]));
      this.dispEls[i].setAttribute("in", blurInput);
    }
    this.blurEl?.setAttribute(
      "stdDeviation",
      IS_IOS ? `${o.blur} ${o.blur}` : `${o.blur / W} ${o.blur / H}`,
    );
    this.specularEl?.setAttribute("k2", String(o.specular));

    if (IS_SAFARI) {
      // Fresh ID every update, or Safari serves the cached filter output.
      this.filterEl.id = `${this.id}-v${++this.version}`;
      this.host.filtered.style.filter = `url(#${this.filterEl.id})`;
    } else if (!this.filterEl.id) {
      // Everywhere else attribute updates apply in place; assign the filter
      // once and never invalidate it, which keeps dragging cheap.
      this.filterEl.id = this.id;
      this.host.filtered.style.filter = `url(#${this.id})`;
    }

    const shadow = this.host.shadow;
    if (shadow) {
      // The overlay lives in the container, which may be offset from the
      // filtered element; bridge the two coordinate spaces.
      let ox = 0;
      let oy = 0;
      if (this.host.filtered !== this.host.container) {
        const crect = this.host.container.getBoundingClientRect();
        ox = rect.left - crect.left;
        oy = rect.top - crect.top;
      }
      shadow.style.transform = `translate(${ox + left}px, ${oy + top}px)`;
      shadow.style.width = `${2 * hw}px`;
      shadow.style.height = `${2 * hh}px`;
      shadow.style.borderRadius = `${this.cornerRadius}px`;
    }
  }
}
