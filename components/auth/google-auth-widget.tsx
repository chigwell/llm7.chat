"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const GA_CLIENT_ID =
  "264062651955-8qamru5vjtu9kc1tk2trsgte5e10hm0m.apps.googleusercontent.com";
const BASE_API_URL = "https://llm7-api.chigwel137.workers.dev";
const ID_TOKEN_KEY = "id_token";

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

  const persistToken = useCallback((token: string) => {
    const maxAge = jwtMaxAgeSeconds(token);
    try {
      localStorage.setItem(ID_TOKEN_KEY, token);
    } catch {
      // Ignore storage failures (e.g., in private mode).
    }
    setCookie(ID_TOKEN_KEY, token, maxAge);
  }, []);

  const clearAuth = useCallback(() => {
    try {
      localStorage.removeItem(ID_TOKEN_KEY);
    } catch {
      // Ignore storage failures.
    }
    deleteCookie(ID_TOKEN_KEY);
    setUserEmail(null);
    buttonRenderedRef.current = false;
    if (buttonRef.current) {
      buttonRef.current.innerHTML = "";
    }
  }, []);

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
      persistToken(token);
    } catch (err) {
      clearAuth();
      setError("Could not verify Google sign-in. Please try again.");
      // eslint-disable-next-line no-console
      console.error("Auth verify failed", err);
    } finally {
      verifyingRef.current = false;
      setIsLoading(false);
    }
  }, [clearAuth, persistToken]);

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

  // Auto-verify any stored token on load.
  useEffect(() => {
    const token =
      (typeof localStorage !== "undefined" &&
        localStorage.getItem(ID_TOKEN_KEY)) ||
      (typeof document !== "undefined" && getCookie(ID_TOKEN_KEY));
    if (token) {
      verifyToken(token);
    }
  }, [verifyToken]);

  const logout = useCallback(() => {
    clearAuth();
  }, [clearAuth]);

  return (
    <div className="rounded-lg px-3 py-3 text-sm" style={{ paddingLeft: "0px" }}>
      {userEmail ? (
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="font-semibold leading-tight">{userEmail}</div>
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
        <div className="flex flex-col items-start gap-2">
          <div
            ref={buttonRef}
            className="flex w-full justify-start"
            aria-live="polite"
          />
          {isLoading && (
            <div className="text-xs text-muted-foreground">Checking login…</div>
          )}
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
      )}
    </div>
  );
}
