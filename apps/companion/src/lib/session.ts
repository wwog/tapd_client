/** Pairing session token, stored only on the phone. */
const KEY = "companion.session";

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
    // Private browsing: pairing will not survive a reload.
  }
};

export const clearSession = (): void => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Ignore.
  }
};
