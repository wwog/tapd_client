import { useEffect, useState } from "react";
import clsx from "clsx";

import { t } from "../lib/i18n";

type Props = {
  src?: string | null;
  name?: string | null;
  className?: string;
  /** Tailwind radius class; defaults to a circle. */
  rounded?: string;
};

/** TAPD/WeCom avatar with a deterministic initial fallback. */
export function Avatar({ src, name, className, rounded = "rounded-full" }: Props) {
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
  }, [src]);

  const initial =
    Array.from((name ?? "").trim())[0]?.toUpperCase() ?? "T";

  if (src && !broken) {
    return (
      <img
        src={src}
        alt={name ? t("app.avatar.namedAlt", { name }) : t("app.avatar.alt")}
        draggable={false}
        onError={() => setBroken(true)}
        className={clsx("shrink-0 select-none object-cover", rounded, className)}
      />
    );
  }

  return (
    <span
      className={clsx(
        "grid shrink-0 place-items-center bg-gradient-to-br from-sky-400 to-emerald-400 font-normal text-white",
        rounded,
        className,
      )}
    >
      {initial}
    </span>
  );
}
