/**
 * Pure date helpers for the credit / pickup / case-list pages.
 *
 * Why not `fmtDate` from components/ui.tsx: that module is "use client", so a
 * server component cannot CALL its functions (only render its components). These
 * are safe on both sides, and pin the time zone to IST so the server render and
 * the browser agree.
 */

const TZ = "Asia/Kolkata";
const IST_OFFSET_MS = 330 * 60_000;

export function fmtWhen(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(
    "en-IN",
    withTime
      ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ }
      : { day: "numeric", month: "short", year: "numeric", timeZone: TZ }
  );
}

/** Whole days between two instants (never negative). */
export function wholeDays(fromIso: string, toIso: string): number {
  return Math.max(0, Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000));
}

/** "just now", "40 min", "5 h", "3 days" — how long something has been waiting. */
export function ageLabel(fromIso: string | null | undefined, nowIso: string): string {
  if (!fromIso) return "—";
  const ms = Date.parse(nowIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms)) return "—";
  if (ms < 60_000) return "just now";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.floor(ms / 60_000)} min`;
  if (h < 48) return `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} days`;
}

/** First instant of the current calendar month in IST, as an ISO string. */
export function istMonthStart(nowIso: string): { iso: string; label: string } {
  const ist = new Date(Date.parse(nowIso) + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const iso = new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS).toISOString();
  const label = new Date(Date.UTC(y, m, 15)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  return { iso, label };
}

/** A datetime-local default: tomorrow at `hhmm` (IST wall clock), e.g. "2026-10-16T11:00". */
export function tomorrowAt(nowIso: string, hhmm = "11:00"): string {
  const t = new Date(Date.parse(nowIso) + IST_OFFSET_MS + 86_400_000);
  return `${t.toISOString().slice(0, 10)}T${hhmm}`;
}
