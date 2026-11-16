/** Pairing session token, kept for this tab's lifetime only: the page stays
 * open and the session stays usable; closing it forgets the token on purpose,
 * so a borrowed device cannot hold a live session. */
const KEY = "companion.session";
const MEDIA_KEY = "companion.mediaToken";

export const getSession = (): string | null => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export const setSession = (token: string): void => {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // Private browsing: pairing will not survive a reload.
  }
};

export const clearSession = (): void => {
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(MEDIA_KEY);
  } catch {
    // Ignore.
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
    return sessionStorage.getItem(MEDIA_KEY) ?? getSession();
  } catch {
    return getSession();
  }
};

export const setMediaToken = (token: string): void => {
  try {
    sessionStorage.setItem(MEDIA_KEY, token);
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
