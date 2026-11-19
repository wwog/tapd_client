import { useEffect, useRef } from "react";

/**
 * Telegram-web style "code rain" used as the QR placeholder while the
 * hidden webview is still loading (or refreshing) the login page.
 */
const GLYPHS =
  "01アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン" +
  "ABCDEF#$%&*+-<>[]{}=/\\";

const HEAD_COLOR = "#e6fbff";
const MID_COLOR = "rgba(56, 189, 248, 0.78)";
const TAIL_COLOR = "rgba(14, 165, 233, 0.3)";
const BACKGROUND = "#06111c";

type Props = {
  className?: string;
  active?: boolean;
};

export function CodeRain({ className, active = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;

    const context = canvas.getContext("2d");
    const host = canvas.parentElement;
    if (!context || !host) return;

    const ctx = context;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let fontSize = 13;
    let columns = 1;
    let drops: number[] = [];
    let frame = 0;
    let lastPaint = 0;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      fontSize = Math.max(10, Math.round(width / 17));
      columns = Math.ceil(width / fontSize) + 1;
      drops = Array.from(
        { length: columns },
        () => Math.random() * (-height / fontSize) * 0.7,
      );

      ctx.fillStyle = BACKGROUND;
      ctx.fillRect(0, 0, width, height);
    };

    const drawColumn = (index: number) => {
      const x = index * fontSize;
      const y = drops[index] * fontSize;
      const glyph = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      const roll = Math.random();

      ctx.fillStyle = roll > 0.975 ? HEAD_COLOR : roll > 0.55 ? MID_COLOR : TAIL_COLOR;
      ctx.fillText(glyph, x, y);

      if (y > height && Math.random() > 0.976) {
        drops[index] = Math.random() * -6;
      }
      drops[index] += 1;
    };

    const paint = () => {
      ctx.fillStyle = BACKGROUND;
      ctx.fillRect(0, 0, width, height);
      ctx.font = `${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textBaseline = "top";

      // A static drizzle for reduced-motion users.
      for (let index = 0; index < columns; index += 1) {
        for (let row = 0; row < 3; row += 1) {
          const x = index * fontSize;
          const y = Math.random() * height;
          const glyph = GLYPHS[(Math.random() * GLYPHS.length) | 0];
          ctx.fillStyle = row === 0 ? MID_COLOR : TAIL_COLOR;
          ctx.fillText(glyph, x, y);
        }
      }
    };

    const step = (time: number) => {
      frame = window.requestAnimationFrame(step);
      if (time - lastPaint < 60) return;
      lastPaint = time;

      ctx.fillStyle = "rgba(6, 17, 28, 0.11)";
      ctx.fillRect(0, 0, width, height);
      ctx.font = `${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textBaseline = "top";

      for (let index = 0; index < columns; index += 1) {
        drawColumn(index);
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    if (reduceMotion) {
      paint();
    } else {
      frame = window.requestAnimationFrame(step);
    }

    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [active]);

  return <canvas data-component="CodeRain" ref={canvasRef} className={className} aria-hidden="true" />;
}
