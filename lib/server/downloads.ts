import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ApkInfo = { app: "store" | "check"; version: string; bytes: number; sha256: string; builtAt: string };

/** The manifest written next to each APK by swapup-mobile/scripts/build-apk.sh. null = not published yet. */
export function apkInfo(app: "store" | "check"): ApkInfo | null {
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
