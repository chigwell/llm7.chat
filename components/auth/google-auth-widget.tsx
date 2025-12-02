"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { API_TOKEN_KEY, ID_TOKEN_KEY } from "@/lib/auth";

const GA_CLIENT_ID =
  "264062651955-8qamru5vjtu9kc1tk2trsgte5e10hm0m.apps.googleusercontent.com";
const BASE_API_URL = "https://llm7-api.chigwel137.workers.dev";
const API_TOKEN_FALLBACK_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

type VerifyResponse = { email?: string; sub?: string };
type GsiCredentialResponse = { credential?: string };

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (
            config: Record<string, unknown> & { client_id: string }
          ) => void;
          renderButton: (
            container: HTMLElement,
            options: Record<string, unknown>
          ) => void;
        };
      };
    };
  }
}

function getCookieDomain() {
  if (typeof window === "undefined") return undefined;
  const host = window.location.hostname;

  // Avoid invalid domains when developing locally.
  if (host === "localhost" || host.endsWith(".localhost")) return undefined;

  // Use the apex when we're on the production domain.
  if (host === "llm7.chat" || host.endsWith(".llm7.chat")) return "llm7.chat";

  // Fallback to the current host to avoid cross-site issues.
  return host;
}

function buildCookieAttrs(maxAgeSeconds?: number) {
  const attrs = ["Path=/", "SameSite=Lax", "Secure"];
  const domain = getCookieDomain();
  if (domain) attrs.push(`Domain=${domain}`);
  if (typeof maxAgeSeconds === "number") {
    attrs.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }
  return attrs.join("; ");
}

function setCookie(name: string, value: string, maxAgeSeconds?: number) {
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(
    value
  )}; ${buildCookieAttrs(maxAgeSeconds)}`;
}

function deleteCookie(name: string) {
  document.cookie = `${encodeURIComponent(name)}=; ${buildCookieAttrs(
    0
  )}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function getCookie(name: string) {
  const target = `${encodeURIComponent(name)}=`;
  const found = document.cookie.split("; ").find((p) => p.startsWith(target));
  return found ? decodeURIComponent(found.slice(target.length)) : null;
}

function jwtMaxAgeSeconds(jwt: string): number {
  try {
    const [, payloadB64] = jwt.split(".");
    const json = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    const { exp } = JSON.parse(json);
    const ms = Math.max(0, exp * 1000 - Date.now());
    return Math.floor(ms / 1000);
  } catch {
    // Default to 1 hour if parsing fails.
    return 3600;
  }
}

export function GoogleAuthWidget() {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buttonRef = useRef<HTMLDivElement | null>(null);
  const buttonRenderedRef = useRef(false);
  const verifyingRef = useRef(false);

  const persistIdToken = useCallback((token: string) => {
    const maxAge = jwtMaxAgeSeconds(token);
    try {
      localStorage.setItem(ID_TOKEN_KEY, token);
    } catch {
      // Ignore storage failures (e.g., in private mode).
    }
    setCookie(ID_TOKEN_KEY, token, maxAge);
  }, []);

  const persistApiToken = useCallback(
    (token: string, expiresAt?: string | null) => {
      const maxAge =
        expiresAt != null
          ? Math.max(
              0,
              Math.floor(
                (new Date(expiresAt).getTime() - Date.now()) / 1000,
              ),
            )
          : API_TOKEN_FALLBACK_MAX_AGE_SECONDS;
      try {
        localStorage.setItem(API_TOKEN_KEY, token);
      } catch {
        // Ignore storage failures.
      }
      setCookie(API_TOKEN_KEY, token, maxAge);
    },
    [],
  );

  const clearAuth = useCallback(() => {
    try {
      localStorage.removeItem(ID_TOKEN_KEY);
    } catch {
      // Ignore storage failures.
    }
    try {
      localStorage.removeItem(API_TOKEN_KEY);
    } catch {
      // Ignore storage failures.
    }
    deleteCookie(ID_TOKEN_KEY);
    deleteCookie(API_TOKEN_KEY);
    setUserEmail(null);
    buttonRenderedRef.current = false;
    if (buttonRef.current) {
      buttonRef.current.innerHTML = "";
    }
  }, []);

  const fetchApiToken = useCallback(
    async (idToken: string) => {
      const res = await fetch(`${BASE_API_URL}/tokens/most-capable`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        throw new Error(
          `Failed to fetch API token (${res.status})`,
        );
      }
      const data = (await res.json()) as {
        token?: string;
        sub?: number;
        expires_at?: string | null;
      };
      if (!data?.token) {
        throw new Error("No API token returned");
      }
      persistApiToken(data.token, data.expires_at);
    },
    [persistApiToken],
  );

  const verifyToken = useCallback(async (token: string) => {
    if (verifyingRef.current) return;
    verifyingRef.current = true;
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`${BASE_API_URL}/verify`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(`Verify failed (${res.status})`);
      }
      const data = (await res.json()) as VerifyResponse;
      if (!data?.email) {
        throw new Error("Email missing from verify response");
      }
      setUserEmail(data.email);
      persistIdToken(token);
      await fetchApiToken(token);
    } catch (err) {
      clearAuth();
      setError("Could not verify Google sign-in. Please try again.");
      // eslint-disable-next-line no-console
      console.error("Auth verify failed", err);
    } finally {
      verifyingRef.current = false;
      setIsLoading(false);
    }
  }, [clearAuth, persistIdToken]);

  const handleCredentialResponse = useCallback(
    async (response: GsiCredentialResponse) => {
      if (!response?.credential) return;
      await verifyToken(response.credential);
    },
    [verifyToken]
  );

  // Load Google GSI script once.
  useEffect(() => {
    if (scriptReady) return;
    if (document.getElementById("gsi-client")) {
      setScriptReady(true);
      return;
    }
    const script = document.createElement("script");
    script.id = "gsi-client";
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => setScriptReady(true);
    document.body.appendChild(script);
  }, [scriptReady]);

  // Render the Google button when the script is ready and user is logged out.
  useEffect(() => {
    if (!scriptReady || userEmail || !buttonRef.current || buttonRenderedRef.current)
      return;
    const google = window.google;
    const gsi = google?.accounts?.id;
    if (!gsi) return;
    gsi.initialize({
      client_id: GA_CLIENT_ID,
      callback: handleCredentialResponse,
    });
    gsi.renderButton(buttonRef.current, {
      theme: "outline",
      size: "medium",
      width: 220,
      text: "continue_with",
      shape: "pill",
    });
    buttonRenderedRef.current = true;
  }, [handleCredentialResponse, scriptReady, userEmail]);

  // Clear any rendered Google button once we are authenticated so it doesn't linger.
  useEffect(() => {
    if (userEmail && buttonRef.current) {
      buttonRef.current.innerHTML = "";
      buttonRenderedRef.current = false;
    }
  }, [userEmail]);

  // Auto-verify any stored token on load.
  useEffect(() => {
    const idToken =
      (typeof localStorage !== "undefined" &&
        localStorage.getItem(ID_TOKEN_KEY)) ||
      (typeof document !== "undefined" && getCookie(ID_TOKEN_KEY));
    if (idToken) {
      verifyToken(idToken);
    }
  }, [verifyToken]);

  const logout = useCallback(() => {
    clearAuth();
  }, [clearAuth]);

  const displayEmail = userEmail
    ? userEmail.length > 17
      ? `${userEmail.slice(0, 15)}...`
      : userEmail
    : null;

  return (
    <div className="rounded-lg px-3 py-3 text-sm" style={{ paddingLeft: "0px" }}>
      {userEmail ? (
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="font-semibold leading-tight" title={userEmail}>
              {displayEmail}
            </div>
            <div className="text-xs text-muted-foreground">Signed in</div>
          </div>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition hover:bg-muted"
            onClick={logout}
          >
            Logout
          </button>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">Sign in with Google to use LLM7.chat</div>
      )}

      <div
        ref={buttonRef}
        className={`mt-2 flex w-full justify-start ${userEmail ? "hidden" : ""}`}
        aria-live="polite"
      />
      {!userEmail && isLoading && (
        <div className="text-xs text-muted-foreground">Checking login…</div>
      )}
      {!userEmail && error && (
        <div className="text-xs text-destructive">{error}</div>
      )}
    </div>
  );
}
