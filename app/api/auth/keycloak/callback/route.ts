import { NextResponse } from "next/server";
import { exchangeKeycloakCode } from "@/lib/server/keycloak";
import { homeFor, sessionFor, setSession, setKeycloakIdTokenCookie } from "@/lib/server/auth";
import { ensureSeeded } from "@/lib/server/seed";

function renderPopupResult(opts: { ok: boolean; home?: string; error?: string }) {
  const payload = JSON.stringify(
    opts.ok
      ? { type: "OAUTH_AUTH_SUCCESS", home: opts.home || "/" }
      : { type: "OAUTH_AUTH_ERROR", error: opts.error || "Authentication failed." }
  );
  const fallbackHref = opts.ok ? opts.home || "/" : `/login?error=${encodeURIComponent(opts.error || "Authentication failed.")}`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${opts.ok ? "Signed in · SwapUp" : "Sign-in Error · SwapUp"}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1729; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
    .box { max-width: 380px; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; text-align: center; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { font-size: 14px; color: #cbd5e1; margin: 0 0 16px; line-height: 1.5; }
    a { display: inline-block; background: #3b82f6; color: #fff; text-decoration: none; padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${opts.ok ? "Authentication successful" : "Keycloak Sign-in Failed"}</h1>
    <p>${opts.ok ? "Completing sign-in to SwapUp…" : (opts.error || "Could not complete Keycloak authentication.").replace(/[<>&"]/g, "")}</p>
    <a href="${fallbackHref}">Continue to SwapUp</a>
  </div>
  <script>
    (function() {
      var data = ${payload};
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage(data, "*");
          setTimeout(function() { window.close(); }, 150);
          return;
        } catch (e) {}
      }
      if (data.type === "OAUTH_AUTH_SUCCESS") {
        window.location.replace(${JSON.stringify(fallbackHref)});
      }
    })();
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    status: opts.ok ? 200 : 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(req: Request) {
  try {
    await ensureSeeded();
    const url = new URL(req.url);
    const errorParam = url.searchParams.get("error_description") || url.searchParams.get("error");
    if (errorParam) {
      return renderPopupResult({ ok: false, error: errorParam });
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return renderPopupResult({ ok: false, error: "Missing authorization code or state parameter from Keycloak." });
    }

    const { user, idToken, next } = await exchangeKeycloakCode(code, state);
    const session = sessionFor(user);
    await setSession(session);
    if (idToken) {
      await setKeycloakIdTokenCookie(idToken);
    }

    const safeNext =
      next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login")
        ? next
        : homeFor(session.role);

    return renderPopupResult({ ok: true, home: safeNext });
  } catch (err) {
    return renderPopupResult({
      ok: false,
      error: (err as Error).message || "Keycloak authentication failed.",
    });
  }
}
