"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { ErrorText } from "@/components/ui";

export function LoginForm({
  next,
  keycloakEnabled = false,
  keycloakRealm = "swapup",
  initialError = null,
}: {
  next: string | null;
  keycloakEnabled?: boolean;
  keycloakRealm?: string;
  initialError?: string | null;
}) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [ssoBusy, setSsoBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith(".run.app") && !origin.includes("localhost") && origin !== window.location.origin) {
        return;
      }
      if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
        setSsoBusy(false);
        const dest = next ?? event.data?.home ?? "/";
        router.replace(dest);
        router.refresh();
      } else if (event.data?.type === "OAUTH_AUTH_ERROR") {
        setSsoBusy(false);
        setError(event.data?.error || "Keycloak authentication failed.");
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [next, router]);

  const handleKeycloakSso = async () => {
    setSsoBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        origin: window.location.origin,
      });
      if (next) params.set("next", next);

      const res = await fetch(`/api/auth/keycloak/url?${params.toString()}`);
      if (!res.ok) {
        throw new Error("Could not fetch Keycloak authorization URL.");
      }
      const data = (await res.json()) as { enabled: boolean; url: string | null; redirectUri: string };
      if (!data.enabled || !data.url) {
        setSsoBusy(false);
        setError(
          `Keycloak URL is not configured yet. Set KEYCLOAK_URL in your environment variables and add ${data.redirectUri} to your Keycloak '${keycloakRealm}' realm redirect URIs.`
        );
        return;
      }

      const authWindow = window.open(data.url, "keycloak_oauth_popup", "width=540,height=680");
      if (!authWindow) {
        setSsoBusy(false);
        setError("Popup was blocked by your browser. Please allow popups for this site to sign in with Keycloak.");
      }
    } catch (err) {
      setSsoBusy(false);
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <button
          type="button"
          onClick={handleKeycloakSso}
          disabled={ssoBusy || busy}
          className="btn w-full justify-center font-semibold border border-[color:var(--line-strong)] bg-[color:var(--surface-2)] hover:bg-[color:var(--surface-3)]"
        >
          {ssoBusy ? "Connecting to Keycloak…" : `Sign in with Keycloak (${keycloakRealm})`}
        </button>
        <div className="flex items-center justify-between text-[12.5px] text-muted px-0.5">
          <span>{keycloakEnabled ? `Keycloak realm '${keycloakRealm}' connected` : `Keycloak realm: ${keycloakRealm}`}</span>
          <a
            href="/api/auth/keycloak/realm-export"
            download="swapup-realm-export.json"
            className="underline font-medium hover:text-[color:var(--ink)]"
          >
            Download {keycloakRealm} realm JSON
          </a>
        </div>
      </div>

      <div className="relative flex items-center py-1">
        <div className="flex-grow border-t border-[color:var(--line)]" />
        <span className="flex-shrink mx-3 text-xs uppercase tracking-wider text-muted font-semibold">or direct login</span>
        <div className="flex-grow border-t border-[color:var(--line)]" />
      </div>

      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api<{ home: string }>("/api/auth/login", { body: { username, password } });
            router.replace(next ?? r.home);
            router.refresh();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <label className="block">
          <span className="label">Username</span>
          <input className="input" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="block">
          <span className="label">Password</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="btn btn-primary w-full" disabled={busy || ssoBusy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <ErrorText error={error} />
      </form>
    </div>
  );
}
