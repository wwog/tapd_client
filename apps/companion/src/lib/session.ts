/** Pairing session token, kept for this tab's lifetime only: the page stays
 * open and the session stays usable; closing it forgets the token on purpose,
 * so a borrowed device cannot hold a live session. */
const KEY = "companion.session";

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
  } catch {
    // Ignore.
  }
};
