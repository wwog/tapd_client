import clsx from "clsx";

type Props = {
  /** 运行时 id（claude / codex / opencode / omp…）。 */
  runtimeId?: string | null;
  /** 运行时展示名；未知 id 时取首字母。 */
  name?: string | null;
  size?: number;
  className?: string;
};

type Brand = {
  /** 品牌色；用于单色图标和浅色底。 */
  color: string;
  background: string;
  /** 用 SVG 路径表达的品牌记号。 */
  glyph: "claude" | "codex" | "opencode" | "pi";
};

const BRANDS: Record<string, Brand> = {
  claude: { color: "#d97757", background: "#fdf2ed", glyph: "claude" },
  openclaude: { color: "#d97757", background: "#fdf2ed", glyph: "claude" },
  codex: { color: "#10a37f", background: "#e8f7f2", glyph: "codex" },
  grok: { color: "#111827", background: "#eef0f3", glyph: "codex" },
  opencode: { color: "#0ea5e9", background: "#e8f5fd", glyph: "opencode" },
  opencode2: { color: "#0ea5e9", background: "#e8f5fd", glyph: "opencode" },
  zcode: { color: "#0ea5e9", background: "#e8f5fd", glyph: "opencode" },
  omp: { color: "#7c3aed", background: "#f2ecfe", glyph: "pi" },
  pi: { color: "#7c3aed", background: "#f2ecfe", glyph: "pi" },
};

/** 运行时图标：已知品牌用内联 SVG，其余回退首字母。 */
export function AgentIcon({ runtimeId, name, size = 16, className }: Props) {
  const key = (runtimeId ?? "").trim().toLowerCase();
  const brand = BRANDS[key];
  const label = (name ?? runtimeId ?? "?").trim().charAt(0).toUpperCase() || "?";

  return (
    <span
      className={clsx(
        "grid shrink-0 place-items-center overflow-hidden rounded-[4px]",
        className,
      )}
      style={{
        width: size,
        height: size,
        background: brand?.background ?? "#f1f5f9",
        color: brand?.color ?? "#64748b",
      }}
      aria-hidden="true"
      title={name ?? runtimeId ?? undefined}
    >
      {brand ? (
        <BrandGlyph glyph={brand.glyph} size={size} color={brand.color} />
      ) : (
        <span style={{ fontSize: Math.max(8, size * 0.56), lineHeight: 1 }}>{label}</span>
      )}
    </span>
  );
}

function BrandGlyph({
  glyph,
  size,
  color,
}: {
  glyph: Brand["glyph"];
  size: number;
  color: string;
}) {
  const dimension = size * 0.72;
  if (glyph === "claude") {
    // 放射状记号，接近 Anthropic 的品牌笔画。
    return (
      <svg width={dimension} height={dimension} viewBox="0 0 16 16" fill="none">
        {Array.from({ length: 8 }).map((_, index) => {
          const angle = (index * Math.PI) / 4;
          const x1 = 8 + Math.cos(angle) * 2.1;
          const y1 = 8 + Math.sin(angle) * 2.1;
          const x2 = 8 + Math.cos(angle) * 6.2;
          const y2 = 8 + Math.sin(angle) * 6.2;
          return (
            <line
              key={index}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={color}
              strokeWidth="1.9"
              strokeLinecap="round"
            />
          );
        })}
      </svg>
    );
  }
  if (glyph === "codex") {
    // 六边形节点，代表 OpenAI 的编织记号。
    return (
      <svg width={dimension} height={dimension} viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8L8 1.6Z"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M8 4.6 11.1 6.4v3.4L8 11.6 4.9 9.8V6.4L8 4.6Z"
          stroke={color}
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (glyph === "opencode") {
    return (
      <svg width={dimension} height={dimension} viewBox="0 0 16 16" fill="none">
        <path
          d="M4.4 5.1 7.7 8l-3.3 2.9M8.6 11h3.2"
          stroke={color}
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  // pi / OMP：数学符号 π。
  return (
    <svg width={dimension} height={dimension} viewBox="0 0 16 16" fill="none">
      <path
        d="M3.4 4.9h9.2M5.7 4.9v5.4c0 .9-.4 1.4-1.2 1.4M10.3 4.9v5.7c0 .6.2.9.7.9"
        stroke={color}
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
