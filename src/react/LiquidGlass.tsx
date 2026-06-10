import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { LiquidGlassEngine } from "../core/engine";
import { DEFAULT_OPTIONS, type LiquidGlassOptions } from "../core/types";

const DEFAULT_SHADOW = "0 0 0 1px rgba(255,255,255,0.25), 0 8px 24px rgba(0,0,0,0.35)";

export interface LiquidGlassProps
  extends Partial<LiquidGlassOptions>,
    Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Content the lens refracts. Stays live: selectable, clickable, scrollable. */
  children: ReactNode;
  /** Lens center as a fraction of the container width, 0–1. Default 0.5. */
  x?: number;
  /** Lens center as a fraction of the container height, 0–1. Default 0.5. */
  y?: number;
  /** Let the user drag the lens around. */
  draggable?: boolean;
  /**
   * Drop shadow / rim around the lens. `true` for the default, a string for
   * a custom `box-shadow`, `false` for none. Default `true`.
   */
  shadow?: boolean | string;
  /** Fires while the lens moves (dragging or `x`/`y` changes). */
  onMove?: (x: number, y: number) => void;
  /** Fires with a PNG data URL whenever the displacement map regenerates. */
  onMapGenerated?: (url: string) => void;
}

export interface LiquidGlassHandle {
  /** Root container element. */
  element: HTMLDivElement | null;
  /** Imperative engine, for advanced control (animation loops etc.). */
  engine: LiquidGlassEngine | null;
  /** Move the lens without re-rendering React (cheap, per-frame safe). */
  setPosition: (x: number, y: number) => void;
}

const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS) as (keyof LiquidGlassOptions)[];

function pickOptions(props: Partial<LiquidGlassOptions>): Partial<LiquidGlassOptions> {
  const out: Partial<LiquidGlassOptions> = {};
  for (const key of OPTION_KEYS) {
    if (props[key] !== undefined) (out as Record<string, unknown>)[key] = props[key];
  }
  return out;
}

/**
 * A liquid glass lens over live DOM content.
 *
 * ```tsx
 * <LiquidGlass draggable>
 *   <img src="/photo.jpg" alt="" />
 * </LiquidGlass>
 * ```
 */
export const LiquidGlass = forwardRef<LiquidGlassHandle, LiquidGlassProps>(
  function LiquidGlass(props, ref) {
    const {
      children,
      x = 0.5,
      y = 0.5,
      draggable = false,
      shadow = true,
      onMove,
      onMapGenerated,
      // engine options
      width,
      height,
      radius,
      strength,
      chromaticAberration,
      blur,
      depth,
      curvature,
      splay,
      glow,
      glowSpread,
      glowExponent,
      edgeHighlight,
      edgeWidth,
      edgeExponent,
      specular,
      specularAngle,
      quality,
      // div props
      style,
      ...rest
    } = props;

    const options = pickOptions({
      width,
      height,
      radius,
      strength,
      chromaticAberration,
      blur,
      depth,
      curvature,
      splay,
      glow,
      glowSpread,
      glowExponent,
      edgeHighlight,
      edgeWidth,
      edgeExponent,
      specular,
      specularAngle,
      quality,
    });

    const containerRef = useRef<HTMLDivElement>(null);
    const filteredRef = useRef<HTMLDivElement>(null);
    const defsRef = useRef<HTMLDivElement>(null);
    const shadowRef = useRef<HTMLDivElement>(null);
    const engineRef = useRef<LiquidGlassEngine | null>(null);
    const draggingRef = useRef(false);
    const dragOffsetRef = useRef({ x: 0, y: 0 });

    const onMoveRef = useRef(onMove);
    onMoveRef.current = onMove;
    const onMapRef = useRef(onMapGenerated);
    onMapRef.current = onMapGenerated;

    // The engine is created once; renders only push option/position diffs.
    const initialRef = useRef({ options, x, y });
    initialRef.current.options = options;

    useLayoutEffect(() => {
      const container = containerRef.current;
      const filtered = filteredRef.current;
      const defsHost = defsRef.current;
      if (!container || !filtered || !defsHost) return;

      const engine = new LiquidGlassEngine(
        { container, filtered, defsHost, shadow: shadowRef.current },
        initialRef.current.options,
      );
      engine.onMap = (url) => onMapRef.current?.(url);
      engine.setPosition(initialRef.current.x, initialRef.current.y);
      engineRef.current = engine;
      return () => {
        engine.destroy();
        engineRef.current = null;
      };
    }, []);

    // Push option changes (engine decides: cheap update vs map regeneration).
    useEffect(() => {
      engineRef.current?.setOptions(options);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...OPTION_KEYS.map((key) => options[key])]);

    // Controlled position. Only reacts to actual prop *changes*: the initial
    // value is applied at engine creation, and re-applying it on mount would
    // stomp positions set imperatively (setPosition) before this effect runs.
    // Also ignored mid-drag so dragging stays smooth.
    const prevPosRef = useRef<{ x: number; y: number } | null>(null);
    useEffect(() => {
      initialRef.current.x = x;
      initialRef.current.y = y;
      const prev = prevPosRef.current;
      prevPosRef.current = { x, y };
      if (prev === null || (prev.x === x && prev.y === y)) return;
      if (!draggingRef.current) engineRef.current?.setPosition(x, y);
    }, [x, y]);

    useImperativeHandle(ref, () => ({
      get element() {
        return containerRef.current;
      },
      get engine() {
        return engineRef.current;
      },
      setPosition: (px: number, py: number) => engineRef.current?.setPosition(px, py),
    }));

    const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggable || !engineRef.current) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const pos = engineRef.current.getPosition();
      draggingRef.current = true;
      dragOffsetRef.current = {
        x: (e.clientX - rect.left) / rect.width - pos.x,
        y: (e.clientY - rect.top) / rect.height - pos.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    };

    const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current || !engineRef.current) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width - dragOffsetRef.current.x;
      const ny = (e.clientY - rect.top) / rect.height - dragOffsetRef.current.y;
      engineRef.current.setPosition(nx, ny);
      const pos = engineRef.current.getPosition();
      onMoveRef.current?.(pos.x, pos.y);
      e.preventDefault();
    };

    const handlePointerEnd = () => {
      draggingRef.current = false;
    };

    const containerStyle: CSSProperties = {
      position: "relative",
      ...(draggable
        ? { cursor: "grab", touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }
        : null),
      ...style,
    };

    return (
      <div
        ref={containerRef}
        data-liquid-glass=""
        style={containerStyle}
        onPointerDown={draggable ? handlePointerDown : undefined}
        onPointerMove={draggable ? handlePointerMove : undefined}
        onPointerUp={draggable ? handlePointerEnd : undefined}
        onPointerCancel={draggable ? handlePointerEnd : undefined}
        {...rest}
      >
        <div ref={filteredRef} style={{ willChange: "filter" }}>
          {children}
        </div>
        <div ref={defsRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} aria-hidden />
        {shadow !== false && (
          <div
            ref={shadowRef}
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              pointerEvents: "none",
              willChange: "transform",
              boxShadow: shadow === true ? DEFAULT_SHADOW : shadow,
            }}
          />
        )}
      </div>
    );
  },
);
