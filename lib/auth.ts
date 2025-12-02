export const ID_TOKEN_KEY = "id_token";
export const API_TOKEN_KEY = "llm7_api_token";

export const getStoredToken = (key: string): string | null => {
  try {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(key);
      if (stored) return stored;
    }
  } catch {
    // Ignore storage errors (e.g., private mode).
  }

  if (typeof document !== "undefined") {
    const target = `${encodeURIComponent(key)}=`;
    const found = document.cookie
      .split("; ")
      .find((part) => part.startsWith(target));
    if (found) return decodeURIComponent(found.slice(target.length));
  }

  return null;
};
