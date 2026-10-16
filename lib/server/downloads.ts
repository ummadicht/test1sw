import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AppId = "store" | "check";

export type ApkInfo = { app: AppId; version: string; bytes: number; sha256: string; builtAt: string };

/** The manifest written next to each APK by swapup-mobile/scripts/build-apk.sh. null = not published yet. */
export function apkInfo(app: AppId): ApkInfo | null {
  const dir = process.env.SWAPUP_DOWNLOADS_DIR || join(process.cwd(), "public", "downloads");
  try {
    return JSON.parse(readFileSync(join(dir, `swapup-${app}.json`), "utf8")) as ApkInfo;
  } catch {
    return null;
  }
}

export function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/* ─────────────────────────── the browser versions ─────────────────────────── */

/** Where it is served on this origin — same origin as the API, so no CORS. */
export const WEB_APP_PATH: Record<AppId, string> = { store: "/app/store/", check: "/app/check/" };

/** The browser link for a customer's code. Relative: the page that links it is on the same origin. */
export function webCheckUrl(code: string): string {
  return `${WEB_APP_PATH.check}?code=${encodeURIComponent(code)}`;
}

export type WebAppInfo = { app: AppId; path: string; version: string | null; builtAt: string | null };

/**
 * The Expo web export of each app (swapup-mobile dist-web/<app>/), as deployed:
 * production → /var/www/swapup-web/<app>/ (SWAPUP_WEB_DIR, served by Caddy at
 * /app/<app>/); dev → <cwd>/public/app/<app>/.
 *
 * Published = its index.html is there. version.json is optional — whatever
 * the web builder writes; only string `version` / `builtAt` are read, and a
 * missing or unreadable one is not an error. null = not published, so the
 * pages never offer a link that would 404.
 */
export function webAppInfo(app: AppId): WebAppInfo | null {
  const root = process.env.SWAPUP_WEB_DIR || join(process.cwd(), "public", "app");
  const dir = join(root, app);
  if (!existsSync(join(dir, "index.html"))) return null;
  const meta = readVersion(join(dir, "version.json")) ?? readVersion(join(root, "version.json"), app);
  return { app, path: WEB_APP_PATH[app], version: meta?.version ?? null, builtAt: meta?.builtAt ?? null };
}

function readVersion(file: string, app?: AppId): { version: string | null; builtAt: string | null } | null {
  try {
    let o = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    // A shared file may be keyed by app: { store: {…}, check: {…} }.
    if (app && o && typeof o[app] === "object" && o[app] !== null) o = o[app] as Record<string, unknown>;
    if (!o || typeof o !== "object") return null;
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : null);
    const version = s(o.version) ?? s(o.appVersion);
    const builtAt = s(o.builtAt) ?? s(o.exportedAt);
    return version || builtAt ? { version, builtAt } : null;
  } catch {
    return null;
  }
}
