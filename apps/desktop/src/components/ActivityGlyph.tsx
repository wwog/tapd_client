import { useMemo, type CSSProperties } from "react";
import clsx from "clsx";

/**
 * Small 16px activity glyph shown before the elapsed time. Six variants are
 * picked deterministically from the bug id so a row keeps the same animation
 * across renders (no flicker on every poll).
 */
export function ActivityGlyph(props: { seed: string; className?: string }) {
  const variant = useMemo(() => seedIndex(props.seed, 6), [props.seed]);

  return (
    <span
      className={clsx("glyph shrink-0 text-sky-600", props.className)}
      aria-hidden="true"
    >
      {variant === 0 ? (
        <DotRing />
      ) : variant === 1 ? (
        <DotT />
      ) : variant === 2 ? (
        <DotCarousel />
      ) : variant === 3 ? (
        <Bars />
      ) : variant === 4 ? (
        <Comet />
      ) : (
        <Orbit />
      )}
    </span>
  );
}

function seedIndex(seed: string, buckets: number): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % buckets;
}

/** Video effect 1: eight dots orbiting a ring, opacity staggered. */
function DotRing() {
  return (
    <span className="glyph-ring">
      {Array.from({ length: 8 }, (_, index) => (
        <i
          key={index}
          style={{
            transform: `rotate(${index * 45}deg) translateY(-6px)`,
            animationDelay: `${index * 0.11}s`,
          }}
        />
      ))}
    </span>
  );
}

/** Video effect 2: scattered dots assemble into a T. */
const T_CELLS: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [2, 0],
  [3, 0],
  [4, 0],
  [2, 1],
  [2, 2],
  [2, 3],
  [2, 4],
];

function DotT() {
  return (
    <span className="glyph-t">
      {T_CELLS.map(([x, y], index) => {
        const dx = ((index * 5) % 7) - 3;
        const dy = ((index * 3) % 7) - 3;
        return (
          <i
            key={index}
            style={
              {
                left: x * 3 + 1,
                top: y * 3 + 1,
                "--dx": `${dx}px`,
                "--dy": `${dy}px`,
                animationDelay: `${(index % 5) * 0.05}s`,
              } as CSSProperties
            }
          />
        );
      })}
    </span>
  );
}

/** Three dots lighting up in sequence. */
function DotCarousel() {
  return (
    <span className="glyph-dots">
      {[0, 1, 2].map((index) => (
        <i key={index} style={{ animationDelay: `${index * 0.16}s` }} />
      ))}
    </span>
  );
}

/** Four bars breathing like an equalizer. */
function Bars() {
  return (
    <span className="glyph-bars">
      {[0, 1, 2, 3].map((index) => (
        <i key={index} style={{ animationDelay: `${index * 0.12}s` }} />
      ))}
    </span>
  );
}

/** Comet: a dashed arc with a fading tail. */
function Comet() {
  return (
    <svg className="glyph-comet" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** Two dots orbiting a steady core. */
function Orbit() {
  return (
    <span className="glyph-orbit">
      <i className="glyph-orbit-outer" />
      <i className="glyph-orbit-inner" />
      <i className="glyph-orbit-core" />
    </span>
  );
}
