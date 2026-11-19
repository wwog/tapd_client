/**
 * Pairing session token, kept in `localStorage`: the same device reopening
 * the same link (or the same tab after Safari evicts it from memory) must
 * come straight back in — the desktop only accepts re-pairing, and a
 * consumed link used to strand the device on the invalid-code page.
 *
 * The device keeps the session until the desktop unpairs it or a re-pairing
 * rotates the token.
 */
const KEY = "companion.session";
const MEDIA_KEY = "companion.mediaToken";

export const getSession = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export const setSession = (token: string): void => {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    // Storage blocked (private browsing): pairing will not survive a reload.
  }
};

export const clearSession = (): void => {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(MEDIA_KEY);
  } catch {
    // Ignore.
  }
};

/**
 * True when shared storage already holds a different token than the one the
 * request used: another tab re-paired while this request was in flight (a
 * re-pair rotates the desktop's stored hash). The 401 must not then clear
 * the fresh token or bounce this tab to `#/pair` — the next read adopts the
 * rotated token and the poll recovers on its own.
 */
export const sessionRotated = (sent: string | null): boolean => {
  if (!sent) return false;
  try {
    const stored = localStorage.getItem(KEY);
    return stored !== null && stored !== sent;
  } catch {
    return false;
  }
};

/**
 * Media-only credential for `<img>`/`<video>`/`file/raw` URLs.
 *
 * Handed out by the heartbeat; the desktop derives it from a per-run secret, so
 * a URL that leaks cannot be replayed as the session token. Falls back to the
 * session token until the first heartbeat arrives.
 */
export const getMediaToken = (): string | null => {
  try {
    return localStorage.getItem(MEDIA_KEY) ?? getSession();
  } catch {
    return getSession();
  }
};

export const setMediaToken = (token: string): void => {
  try {
    localStorage.setItem(MEDIA_KEY, token);
  } catch {
    // Ignore.
  }
};

/**
 * Stable per-browser id, kept across pairings.
 *
 * Two phones with the same display name are otherwise indistinguishable; the
 * desktop keys re-pairing on this id so the second phone gets its own slot
 * instead of taking over the first one's. It carries no authority on its own.
 */
const DEVICE_KEY = "companion.deviceId";

export const getDeviceId = (): string => {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const generated =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().replace(/-/g, "")
        : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem(DEVICE_KEY, generated);
    return generated;
  } catch {
    // Storage blocked: pairing still works, it just falls back to name matching.
    return "";
  }
};
