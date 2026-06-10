import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LiquidGlass, type LiquidGlassHandle } from "liquid-glass-web-react";

/* ------------------------------------------------------------------ *
 * The floating circle: one glass lens over the entire page, tuned by
 * the Playground sliders. An invisible grip div tracks the lens so
 * only the circle captures the pointer and the rest of the page stays
 * fully interactive.
 * ------------------------------------------------------------------ */

// On iOS, Safari's filter-output caching forces a full filter rebuild per
// frame, so a page-wide lens is too expensive there. The demo scopes the
// circle to the video instead.
const IS_IOS =
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

const IS_MOBILE =
  IS_IOS || (typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches);

const CIRCLE_INITIAL = {
  size: 170,
  strength: 0.06,
  chromaticAberration: IS_MOBILE ? 1 : 0.5,
  curvature: 0.8,
  depth: 26,
  splay: 1,
  blur: 0,
  glow: 0.8,
  edgeHighlight: 0.8,
  specularAngle: 130,
};

type CircleParams = typeof CIRCLE_INITIAL;

function FloatingLens({
  params,
  initial = { x: 0.42, y: 0.05 },
  initialSelector,
  followMouse = false,
  bleed = 0,
  idleWander = false,
  children,
}: {
  params: CircleParams;
  initial?: { x: number; y: number };
  /** Element to center the circle on at first layout, e.g. ".video". */
  initialSelector?: string;
  followMouse?: boolean;
  /**
   * Extends the glass container (and so the filter region) past the content
   * by this many px (per axis), compensated with a negative margin. Without
   * it the refraction clips hard at the container box.
   */
  bleed?: number | { x: number; y: number };
  /** Slowly bounce around on its own until the user grabs the circle. */
  idleWander?: boolean;
  children: React.ReactNode;
}) {
  const bleedX = typeof bleed === "number" ? bleed : (bleed?.x ?? 0);
  const bleedY = typeof bleed === "number" ? bleed : (bleed?.y ?? 0);
  const hasBleed = bleedX > 0 || bleedY > 0;
  const lensRef = useRef<LiquidGlassHandle>(null);
  const gripRef = useRef<HTMLDivElement>(null);
  const posRef = useRef(initial);
  const initializedRef = useRef(false);
  const sizeRef = useRef(params.size);
  sizeRef.current = params.size;
  const dragRef = useRef({ active: false, ox: 0, oy: 0 });

  const place = (fx: number, fy: number) => {
    const el = lensRef.current?.element;
    if (!el) return;
    // Keep the whole circle inside the glass container so it never pokes
    // into (or clips against) neighboring sections.
    const r = el.getBoundingClientRect();
    const half = sizeRef.current / 2;
    if (r.width > sizeRef.current) {
      const m = half / r.width;
      fx = Math.min(1 - m, Math.max(m, fx));
    }
    if (r.height > sizeRef.current) {
      const m = half / r.height;
      fy = Math.min(1 - m, Math.max(m, fy));
    }
    lensRef.current?.setPosition(fx, fy);
    const pos = lensRef.current?.engine?.getPosition() ?? { x: fx, y: fy };
    posRef.current = pos;
    const grip = gripRef.current;
    if (!grip) return;
    grip.style.transform = `translate(${pos.x * r.width - half}px, ${pos.y * r.height - half}px)`;
  };

  useLayoutEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      const target = initialSelector ? document.querySelector(initialSelector) : null;
      const container = lensRef.current?.element;
      if (target && container) {
        const tr = target.getBoundingClientRect();
        const cr = container.getBoundingClientRect();
        if (cr.width > 0 && cr.height > 0) {
          posRef.current = {
            x: (tr.left + tr.width / 2 - cr.left) / cr.width,
            y: (tr.top + tr.height / 2 - cr.top) / cr.height,
          };
        }
      }
    }
    place(posRef.current.x, posRef.current.y);
    const el = lensRef.current?.element;
    if (!el) return;
    const ro = new ResizeObserver(() => place(posRef.current.x, posRef.current.y));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.size]);

  // Idle wander: drift and bounce DVD-style (capped to the first viewport's
  // worth of the container) until the user grabs the circle.
  const idleRef = useRef({ stopped: false, raf: 0, vx: 0.034, vy: 0.026 });

  useEffect(() => {
    if (!idleWander || idleRef.current.stopped) return;
    const idle = idleRef.current;
    let last = performance.now();
    const tick = (now: number) => {
      if (idle.stopped) return;
      const el = lensRef.current?.element;
      const dt = Math.min(50, now - last);
      last = now;
      if (el && !dragRef.current.active) {
        const r = el.getBoundingClientRect();
        const half = sizeRef.current / 2;
        const minX = half;
        const maxX = r.width - half;
        const minY = half;
        const maxY = Math.min(r.height, window.innerHeight) - half;
        if (maxX > minX && maxY > minY) {
          let cx = posRef.current.x * r.width + idle.vx * dt;
          let cy = posRef.current.y * r.height + idle.vy * dt;
          if (cx >= maxX) {
            cx = maxX;
            idle.vx = -Math.abs(idle.vx);
          } else if (cx <= minX) {
            cx = minX;
            idle.vx = Math.abs(idle.vx);
          }
          if (cy >= maxY) {
            cy = maxY;
            idle.vy = -Math.abs(idle.vy);
          } else if (cy <= minY) {
            cy = minY;
            idle.vy = Math.abs(idle.vy);
          }
          place(cx / r.width, cy / r.height);
        }
      }
      idle.raf = requestAnimationFrame(tick);
    };
    idle.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(idle.raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idleWander]);

  // Follow-mouse mode: the circle tracks the cursor across the whole page.
  useEffect(() => {
    if (!followMouse) return;
    let raf = 0;
    let pending: { x: number; y: number } | null = null;
    const onPointerMove = (e: PointerEvent) => {
      const el = lensRef.current?.element;
      if (!el) return;
      const r = el.getBoundingClientRect();
      pending = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (pending) place(pending.x, pending.y);
        });
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followMouse]);

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = lensRef.current?.element;
    if (!el) return;
    // Grabbing the circle retires the idle wander for good.
    idleRef.current.stopped = true;
    cancelAnimationFrame(idleRef.current.raf);
    const r = el.getBoundingClientRect();
    dragRef.current = {
      active: true,
      ox: (e.clientX - r.left) / r.width - posRef.current.x,
      oy: (e.clientY - r.top) / r.height - posRef.current.y,
    };
    gripRef.current?.setPointerCapture(e.pointerId);
    gripRef.current?.classList.add("dragging");
    e.preventDefault();
  };

  // Coalesce pointermove (which can fire faster than the display refreshes)
  // into one filter update per frame.
  const moveRaf = useRef(0);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    const el = lensRef.current?.element;
    if (!el) return;
    const r = el.getBoundingClientRect();
    pendingMove.current = {
      x: (e.clientX - r.left) / r.width - dragRef.current.ox,
      y: (e.clientY - r.top) / r.height - dragRef.current.oy,
    };
    if (!moveRaf.current) {
      moveRaf.current = requestAnimationFrame(() => {
        moveRaf.current = 0;
        const p = pendingMove.current;
        if (p && dragRef.current.active) place(p.x, p.y);
      });
    }
  };

  const onUp = () => {
    dragRef.current.active = false;
    gripRef.current?.classList.remove("dragging");
    const p = pendingMove.current;
    if (p) place(p.x, p.y);
  };

  useEffect(() => () => cancelAnimationFrame(moveRaf.current), []);

  const { size, ...lensParams } = params;

  return (
    <div
      className="floatWrap"
      style={hasBleed ? { margin: `${-bleedY}px ${-bleedX}px` } : undefined}
    >
      <LiquidGlass
        ref={lensRef}
        width={size}
        height={size}
        {...lensParams}
        shadow="0 0 0 1px rgba(255,255,255,0.22), 0 18px 50px rgba(0,0,0,0.55)"
      >
        {/* Bleed must sit inside the filtered content so the filter's
            coordinate space and the engine's measurements stay aligned. */}
        {hasBleed ? (
          <div style={{ padding: `${bleedY}px ${bleedX}px` }}>{children}</div>
        ) : (
          children
        )}
      </LiquidGlass>
      <div
        ref={gripRef}
        className="floatGrip"
        style={{ width: size, height: size, pointerEvents: followMouse ? "none" : "auto" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Hero
 * ------------------------------------------------------------------ */

function Hero() {
  return (
    <header className="hero">
      <div className="badge">
        <span className="browser">
          <i className="dot chrome" />
          Chrome
        </span>
        <span className="browser">
          <i className="dot safari" />
          Safari
        </span>
        <span className="browser">
          <i className="dot firefox" />
          Firefox
        </span>
        <span className="badgeNote">no flags · no fallbacks</span>
      </div>
      <h1>
        Liquid glass
        <br />
        <span>for the web.</span>
      </h1>
      <p>
        A glass lens that bends your <em>live UI</em> — and uniquely runs in every modern
        browser, desktop and mobile. One React component.
      </p>
      <div className="ctaRow">
        <div className="install">
          <code>npm install liquid-glass-web-react</code>
        </div>
        <a
          className="repoLink"
          href="https://github.com/PallavAg/liquid-glass-web-react"
          target="_blank"
          rel="noreferrer"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          GitHub ↗
        </a>
        <a className="repoLink" href="https://x.com/pallavmac" target="_blank" rel="noreferrer">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644Z" />
          </svg>
          Twitter ↗
        </a>
      </div>
      <p className="hint">
        {IS_IOS
          ? "↗ Grab the glass circle — it floats around."
          : "↓ Grab the glass circle off the video — it floats over the whole page."}
      </p>
    </header>
  );
}

/* ------------------------------------------------------------------ *
 * Video: bring the circle here
 * ------------------------------------------------------------------ */

function VideoDemo() {
  return (
    <section>
      <h2>It refracts anything — even video</h2>
      <p>The circle starts here. Drag it across the footage — or anywhere else on the page.</p>
      <video
        className="video"
        src="https://res.cloudinary.com/demo/video/upload/sea_turtle.mp4"
        autoPlay
        muted
        loop
        playsInline
      />
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Component primitive: the toggle group with the glass as its
 * selection indicator.
 * ------------------------------------------------------------------ */

const OPTIONS = ["Hubs", "Spokes", "Reserves", "Assets", "Chains"];

function ToggleDemo() {
  const [selected, setSelected] = useState(0);
  const lensRef = useRef<LiquidGlassHandle>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const [lensWidth, setLensWidth] = useState(104);
  const animRef = useRef({ x: 0, v: 0, target: 0, raf: 0, settled: false });
  const dragRef = useRef({ active: false, movedPx: 0, offset: 0 });

  // Buttons are content-sized, so the lens follows their measured centers
  // rather than assuming equal widths.
  const measureCenters = () => {
    const container = lensRef.current?.element;
    const group = groupRef.current;
    if (!container || !group) return null;
    const crect = container.getBoundingClientRect();
    if (crect.width <= 0) return null;
    return Array.from(group.querySelectorAll("button")).map((button) => {
      const r = button.getBoundingClientRect();
      return {
        x: (r.left + r.width / 2 - crect.left) / crect.width,
        width: Math.round(r.width) + 8,
      };
    });
  };

  const startSpring = (target: number) => {
    const a = animRef.current;
    a.target = target;
    cancelAnimationFrame(a.raf);
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // critically damped-ish spring
      const k = 170;
      const damping = 20;
      a.v += (k * (a.target - a.x) - damping * a.v) * dt;
      a.x += a.v * dt;
      lensRef.current?.setPosition(a.x, 0.5);
      if (Math.abs(a.target - a.x) > 0.0005 || Math.abs(a.v) > 0.001) {
        a.raf = requestAnimationFrame(tick);
      } else {
        lensRef.current?.setPosition(a.target, 0.5);
      }
    };
    a.raf = requestAnimationFrame(tick);
  };

  useLayoutEffect(() => {
    const a = animRef.current;
    const centers = measureCenters();
    const target = centers?.[selected];
    if (!target) return;
    setLensWidth(target.width);

    if (!a.settled) {
      // First layout: snap into place, no spring.
      a.settled = true;
      a.x = target.x;
      a.target = target.x;
      lensRef.current?.setPosition(target.x, 0.5);
      return;
    }
    startSpring(target.x);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => () => cancelAnimationFrame(animRef.current.raf), []);

  // Keep the lens on its option across resizes.
  useEffect(() => {
    const onResize = () => {
      const target = measureCenters()?.[selected];
      if (!target) return;
      const a = animRef.current;
      a.target = target.x;
      a.x = target.x;
      a.v = 0;
      setLensWidth(target.width);
      lensRef.current?.setPosition(target.x, 0.5);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // While the glass is held, the refraction deepens and the chromatic
  // fringe widens; both ease back on release.
  const REST_GLASS = { strength: 0.02, chromaticAberration: 0.25 };
  const DRAG_GLASS = { strength: 0.042, chromaticAberration: 0.65 };
  const fxRef = useRef({ raf: 0, ...REST_GLASS });

  const animateGlass = (target: typeof REST_GLASS) => {
    const fx = fxRef.current;
    cancelAnimationFrame(fx.raf);
    const tick = () => {
      fx.strength += (target.strength - fx.strength) * 0.18;
      fx.chromaticAberration += (target.chromaticAberration - fx.chromaticAberration) * 0.18;
      const settled =
        Math.abs(target.strength - fx.strength) < 0.0005 &&
        Math.abs(target.chromaticAberration - fx.chromaticAberration) < 0.005;
      if (settled) {
        fx.strength = target.strength;
        fx.chromaticAberration = target.chromaticAberration;
      }
      lensRef.current?.engine?.setOptions({
        strength: fx.strength,
        chromaticAberration: fx.chromaticAberration,
      });
      if (!settled) fx.raf = requestAnimationFrame(tick);
    };
    fx.raf = requestAnimationFrame(tick);
  };

  useEffect(() => () => cancelAnimationFrame(fxRef.current.raf), []);

  // Drag the lens; on release it locks onto the nearest option.
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const container = lensRef.current?.element;
    if (!container) return;
    const crect = container.getBoundingClientRect();
    const fx = (e.clientX - crect.left) / crect.width;
    const a = animRef.current;
    const halfLens = lensWidth / 2 / crect.width;
    if (Math.abs(fx - a.x) > halfLens) return; // only grab the glass itself
    cancelAnimationFrame(a.raf);
    a.v = 0;
    dragRef.current = { active: true, movedPx: 0, offset: fx - a.x };
    e.currentTarget.setPointerCapture(e.pointerId);
    animateGlass(DRAG_GLASS);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag.active) return;
    const container = lensRef.current?.element;
    const centers = measureCenters();
    if (!container || !centers) return;
    const crect = container.getBoundingClientRect();
    const fx = (e.clientX - crect.left) / crect.width;
    const min = centers[0].x;
    const max = centers[centers.length - 1].x;
    const nx = Math.min(max, Math.max(min, fx - drag.offset));
    drag.movedPx += Math.abs(nx - animRef.current.x) * crect.width;
    animRef.current.x = nx;
    lensRef.current?.setPosition(nx, 0.5);
  };

  const handlePointerEnd = () => {
    const drag = dragRef.current;
    if (!drag.active) return;
    drag.active = false;
    animateGlass(REST_GLASS);
    const centers = measureCenters();
    if (!centers) return;
    const a = animRef.current;
    let nearest = 0;
    for (let i = 1; i < centers.length; i++) {
      if (Math.abs(centers[i].x - a.x) < Math.abs(centers[nearest].x - a.x)) nearest = i;
    }
    if (nearest !== selected) setSelected(nearest); // layout effect springs it home
    else startSpring(centers[nearest].x);
  };

  // A real drag shouldn't also count as a click on whatever button is under
  // the pointer when it's released.
  const handleClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dragRef.current.movedPx > 4) {
      e.preventDefault();
      e.stopPropagation();
    }
    dragRef.current.movedPx = 0;
  };

  return (
    <section>
      <h2>As a component primitive</h2>
      <p>
        The glass is the selection indicator — click an option or drag the lens and it locks
        onto the nearest one. Hold it to feel the press response.
      </p>
      <div className="toggleWrap">
        <LiquidGlass
          ref={lensRef}
          y={0.5}
          width={lensWidth}
          height={46}
          strength={REST_GLASS.strength}
          chromaticAberration={REST_GLASS.chromaticAberration}
          curvature={0.85}
          depth={8}
          glow={0.15}
          edgeHighlight={0.35}
          shadow="0 0 0 1px rgba(255,255,255,0.14), 0 4px 14px rgba(0,0,0,0.45)"
          style={{ touchAction: "none" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onClickCapture={handleClickCapture}
        >
          <div className="toggle" ref={groupRef}>
            {OPTIONS.map((label, i) => (
              <button key={label} aria-pressed={i === selected} onClick={() => setSelected(i)}>
                {label}
              </button>
            ))}
          </div>
        </LiquidGlass>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Playground: sliders that tune the floating circle
 * ------------------------------------------------------------------ */

interface SliderCfg {
  key: keyof CircleParams;
  label: string;
  min: number;
  max: number;
  step: number;
}

const SLIDERS: SliderCfg[] = [
  { key: "size", label: "Size", min: 100, max: 280, step: 2 },
  { key: "strength", label: "Strength", min: 0, max: 0.08, step: 0.001 },
  { key: "chromaticAberration", label: "Chroma", min: 0, max: 1, step: 0.01 },
  { key: "curvature", label: "Curvature", min: 0, max: 1, step: 0.01 },
  { key: "depth", label: "Depth", min: 4, max: 60, step: 1 },
  { key: "splay", label: "Splay", min: 0, max: 1, step: 0.01 },
  { key: "blur", label: "Blur", min: 0, max: 3, step: 0.25 },
  { key: "glow", label: "Glow", min: 0, max: 1, step: 0.01 },
  { key: "edgeHighlight", label: "Edge Highlight", min: 0, max: 1, step: 0.01 },
  { key: "specularAngle", label: "Specular Angle", min: 0, max: 180, step: 1 },
];

function Playground({
  glass,
  setGlass,
  follow,
  setFollow,
}: {
  glass: CircleParams;
  setGlass: React.Dispatch<React.SetStateAction<CircleParams>>;
  follow: boolean;
  setFollow: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const randomize = () => {
    setGlass((p) => {
      const next = { ...p };
      for (const cfg of SLIDERS) {
        if (cfg.key === "size") continue;
        const raw = cfg.min + Math.random() * (cfg.max - cfg.min);
        const stepped = Math.round(raw / cfg.step) * cfg.step;
        const decimals = Math.max(0, Math.ceil(-Math.log10(cfg.step)));
        next[cfg.key] = Number(stepped.toFixed(decimals));
      }
      return next;
    });
  };

  return (
    <section>
      <div className="playHeader">
        <h2>Playground</h2>
        <div className="playActions">
          {!IS_MOBILE && (
            <button
              type="button"
              className={`pillBtn${follow ? " on" : ""}`}
              aria-pressed={follow}
              onClick={() => setFollow((f) => !f)}
            >
              {follow ? "◉ Following mouse" : "○ Follow mouse"}
            </button>
          )}
          <button type="button" className="pillBtn" onClick={randomize}>
            ⚄ Randomize
          </button>
        </div>
      </div>
      <p>
        These sliders tune the floating circle, live. Shape changes regenerate its
        displacement map; strength, chroma and blur are pure filter updates.
      </p>
      <div className="controls">
        {SLIDERS.map((cfg) => {
          const value = glass[cfg.key];
          const decimals = Math.max(0, Math.ceil(-Math.log10(cfg.step)));
          return (
            <div className="control" key={cfg.key}>
              <label htmlFor={`s-${cfg.key}`}>{cfg.label}</label>
              <input
                id={`s-${cfg.key}`}
                type="range"
                min={cfg.min}
                max={cfg.max}
                step={cfg.step}
                value={value}
                style={
                  {
                    "--fill": `${((value - cfg.min) / (cfg.max - cfg.min)) * 100}%`,
                  } as React.CSSProperties
                }
                onChange={(e) => setGlass((p) => ({ ...p, [cfg.key]: Number(e.target.value) }))}
              />
              <output>{value.toFixed(decimals)}</output>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Code + shell
 * ------------------------------------------------------------------ */

function CodeSample() {
  return (
    <section>
      <h2>Usage</h2>
      <p>One component, sensible defaults, everything tweakable.</p>
      <pre>
        {`import { LiquidGlass } from "liquid-glass-web-react";\n\n`}
        <span className="tag">{`<LiquidGlass`}</span>
        <span className="attr">{` draggable width`}</span>={`{`}
        <span className="val">200</span>
        {`} `}
        <span className="attr">height</span>={`{`}
        <span className="val">140</span>
        {`}>\n  `}
        <span className="tag">{`<YourContent />`}</span>
        {`\n`}
        <span className="tag">{`</LiquidGlass>`}</span>
      </pre>
    </section>
  );
}

export function App() {
  const [glass, setGlass] = useState(CIRCLE_INITIAL);
  const [follow, setFollow] = useState(false);

  const content = (
    <div className="page">
      <main>
        {IS_IOS ? (
          <FloatingLens
            params={glass}
            initial={{ x: 0.72, y: 0.2 }}
            bleed={{ x: 24, y: 88 }}
            idleWander
          >
            <Hero />
          </FloatingLens>
        ) : (
          <Hero />
        )}
        {!IS_MOBILE && <VideoDemo />}
        <Playground glass={glass} setGlass={setGlass} follow={follow} setFollow={setFollow} />
        <ToggleDemo />
        <CodeSample />
        <footer>
          Technique inspired by{" "}
          <a href="https://aave.com/design/building-glass-for-the-web">
            Aave's “Building Glass for the Web”
          </a>
          . MIT licensed ·{" "}
          <a href="https://github.com/PallavAg/liquid-glass-web-react">GitHub</a> ·{" "}
          <a href="https://www.npmjs.com/package/liquid-glass-web-react">npm</a>
        </footer>
      </main>
    </div>
  );

  // iOS pays a full filter rebuild per frame (Safari ID workaround), so the
  // circle is scoped to the hero there instead of the whole page.
  return IS_IOS ? (
    content
  ) : (
    <FloatingLens
      params={glass}
      initialSelector=".video"
      followMouse={follow}
      idleWander={IS_MOBILE}
    >
      {content}
    </FloatingLens>
  );
}
