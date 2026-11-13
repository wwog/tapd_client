import { useEffect, useState } from "react";

import { api, asApiError } from "../lib/api";
import { t } from "../lib/i18n";
import { setSession } from "../lib/session";

/** Short device label for the desktop's paired-device list. */
const deviceName = (): string => {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh/i.test(ua)) return "Mac";
  return t("mobile.pair.deviceFallback");
};

/**
 * The only entry into the companion: consumes the one-time code from the QR
 * (`#/pair?t=<code>`) and stores the session token. No login UI by design.
 *
 * Without a code in the URL the pair endpoint is probed directly: when the
 * desktop has pairing codes switched off this pairs straight away, otherwise
 * it asks the user to scan.
 */
export function PairPage() {
  // Read the code from the live URL, not the cached route: Safari can apply
  // the fragment a moment after the SPA mounts, and an effect elsewhere may
  // rewrite the hash. A `hashchange` listener picks the code up either way.
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const queryStart = hash.indexOf("?");
  const code =
    queryStart >= 0
      ? (new URLSearchParams(hash.slice(queryStart + 1)).get("t") ?? "")
      : "";

  const [pairing, setPairing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPairing(true);
    setError(null);
    void (async () => {
      try {
        const data = await api.pair(code, deviceName());
        if (cancelled) return;
        setSession(data.sessionToken);
        window.location.hash = "#/bugs";
      } catch (err) {
        if (!cancelled) {
          setPairing(false);
          setError(
            code
              ? asApiError(err).message
              : t("mobile.pair.needCode"),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, attempt]);

  return (
    <div className="grid min-h-full place-items-center p-6">
      {pairing ? (
        <p className="text-ui-base text-slate-500">{t("mobile.pair.pairing")}</p>
      ) : (
        <div className="w-full max-w-sm text-center">
          <h1 className="text-ui-lg text-slate-900">{t("mobile.pair.title")}</h1>
          <p className="mt-3 text-ui-caption text-rose-600">{error}</p>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
              className="mt-5 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
            >
              {t("mobile.pair.retry")}
            </button>
        </div>
      )}
    </div>
  );
}
