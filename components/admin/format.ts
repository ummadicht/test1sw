/**
 * Pure display helpers for the programme admin console. No "use client" and no
 * server imports, so both server pages and client components can call them
 * (functions exported from a "use client" module cannot be CALLED on the server).
 */

export const STORE_KINDS = ["service_center", "experience_center", "retail"] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

export const STORE_KIND_LABEL: Record<string, string> = {
  service_center: "Service centre",
  experience_center: "Experience centre",
  retail: "Retail store",
};

/** Galaxy series letters a campaign rule or a new phone can name. */
export const SERIES = ["S", "Z", "A", "M", "F"] as const;
export const SERIES_LABEL: Record<string, string> = { S: "Galaxy S", Z: "Galaxy Z", A: "Galaxy A", M: "Galaxy M", F: "Galaxy F" };

export const TIER_LABEL: Record<string, string> = { Z: "Galaxy Z", S: "Galaxy S", other: "Other" };

const TZ = "Asia/Kolkata";

/** "15 Oct 2026" — fixed time zone so server and browser render the same text. */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00+05:30` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: TZ });
}

/** "Oct 2026" from "2026-10". */
export function fmtMonth(ym: string): string {
  const d = new Date(`${ym}-01T00:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return ym;
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: TZ });
}

/** Today's date in India, YYYY-MM-DD. */
export function todayIst(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function monthIst(): string {
  return todayIst().slice(0, 7);
}

export function shiftMonth(ym: string, by: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

export function isMonth(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** 0.42 → "42%". Fractions (not basis points). */
export function fracPct(f: number | null | undefined, digits = 0): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return "—";
  const v = f * 100;
  return `${digits ? v.toFixed(digits).replace(/\.?0+$/, "") : Math.round(v)}%`;
}

/** Same rule the credit domain uses for a store's line, applied to programme totals. */
export function lineState(limit: number, exposure: number, warnAt: number): "ok" | "warn" | "full" | "over" {
  const available = limit - exposure;
  const utilisation = limit > 0 ? exposure / limit : exposure > 0 ? Infinity : 0;
  return exposure > limit ? "over" : available === 0 && exposure > 0 ? "full" : utilisation >= warnAt ? "warn" : "ok";
}

/** Parse a rupee input ("1,20,000", "₹ 5000") to a whole number, or null if it is not one. */
export function parseRupees(s: string): number | null {
  const t = s.replace(/[₹,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
}

/** Parse a percentage input ("3.5", "3.5%") to a number, or null. */
export function parsePct(s: string): number | null {
  const t = s.replace(/[%\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Append ?orgId= for platform users so every internal admin link stays on the same client. */
export function withOrg(path: string, orgId: string | null | undefined, isPlatform: boolean, extra: Record<string, string | null | undefined> = {}): string {
  const params = new URLSearchParams();
  if (isPlatform && orgId) params.set("orgId", orgId);
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export const ADMIN_SECTIONS: { href: string; label: string }[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/stores", label: "Stores" },
  { href: "/admin/campaigns", label: "Upgrade bonus" },
  { href: "/admin/catalogue", label: "Catalogue" },
  { href: "/admin/claims", label: "Bonus claims" },
  { href: "/admin/settings", label: "Settings" },
];
