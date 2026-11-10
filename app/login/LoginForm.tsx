"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { ErrorText } from "@/components/ui";

export function LoginForm({
  next,
  keycloakEnabled = false,
  keycloakRealm = "swapup1",
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

  const [copiedJson, setCopiedJson] = useState(false);

  const handleDownloadRealmJson = async () => {
    setError(null);
    try {
      const res = await fetch(`/api/auth/keycloak/realm-export?origin=${encodeURIComponent(window.location.origin)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Failed to generate Keycloak realm JSON.");
      const text = await res.text();
      // Validate it is well-formed JSON before saving
      JSON.parse(text);
      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${keycloakRealm}-realm-export.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCopyRealmJson = async () => {
    setError(null);
    try {
      const res = await fetch(`/api/auth/keycloak/realm-export?origin=${encodeURIComponent(window.location.origin)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Failed to generate Keycloak realm JSON.");
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2500);
    } catch (err) {
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
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted px-0.5">
          <span>{keycloakEnabled ? `Keycloak realm '${keycloakRealm}' connected` : `Keycloak realm: ${keycloakRealm}`}</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleDownloadRealmJson}
              className="underline font-medium hover:text-[color:var(--ink)] cursor-pointer bg-transparent border-0 p-0"
            >
              Download {keycloakRealm} JSON
            </button>
            <button
              type="button"
              onClick={handleCopyRealmJson}
              className="underline font-medium hover:text-[color:var(--ink)] cursor-pointer bg-transparent border-0 p-0"
            >
              {copiedJson ? "Copied JSON!" : "Copy JSON"}
            </button>
          </div>
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
