/**
 * THE IMEI FIRST, ON THE DESK (SUP-35; owner, 2026-10-19: "Big step missing! Scan IMEI first").
 * The desk's rules for the IMEI — the first field of New trade-in (NewCaseForm) and the top of the
 * case's Phone step (StepPhone) — kept pure so they are tested without a browser (imeiFirst.test.ts).
 * The same contract as SwapUp Store's IMEI card (docs/MOBILE-API.md §2d):
 *
 *   - typed, with the check-digit warning; 14 digits are completed (a box label may leave the last
 *     one off). One that fails its check digit is saved only when the advisor says "Record it
 *     anyway": the server keeps it as typed (imeiCheck "invalid") but never looks it up — a misread
 *     is never paid for — and the lock asks for the re-read.
 *   - "Read the screen": a photo of the customer's *#06# screen → POST /api/imei/read (GradeIQ's
 *     reader, server to server). Shown as "Read: … — check it against the screen", never trusted
 *     by itself: nothing is saved until the advisor confirms.
 *   - Start: POST /api/cases {customerName, customerPhone} → PATCH /api/cases/<id> {imei, imei2},
 *     the same PATCH the store app sends. The server looks a new IMEI up once per case
 *     (lib/server/imeiResolve.ts) before it answers, and the case shows what it found before any
 *     test: the model from the IMEI, the GSMA blacklist, an IMEI already on another trade-in.
 *
 * Runtime imports are relative with ".ts" so `node --test` can load this file; everything from
 * lib/server is a type only.
 */
import { digits, kymEarlyStop, luhnValid, readImei } from "../../lib/domain/imei.ts";
import type { CaseView } from "../../lib/server/cases.ts";

/* ─────────────────────────── typed ─────────────────────────── */

/** The warning under a typed IMEI that fails its check digit (the store app's words). */
export const BAD_CHECK_DIGIT = "Fails its check digit — re-read *#06#.";
/** What "Record it anyway" means, said beside it. */
export const RECORD_ANYWAY = "Record it anyway — it won't be looked up";
/** Start refused for an IMEI that fails its check digit and isn't recorded anyway. */
export const BAD_CHECK_START = "The IMEI fails its check digit — re-read *#06#, or tick “Record it anyway”.";

export type ImeiEntry = {
  /** What Start saves: 15 digits (a 14-digit entry completed), or null = none typed, or not an IMEI. */
  imei: string | null;
  /** Said under the field as soon as it applies: the check-digit warning. */
  warn: string | null;
  /** Why Start can't go yet (too short or long; a failed check digit not recorded anyway). */
  problem: string | null;
};

/** The IMEI field as typed. Empty is no IMEI (it can wait for the hand-over); anything else must be one. */
export function imeiEntry(text: string, recordAnyway = false): ImeiEntry {
  if (!digits(text)) return { imei: null, warn: null, problem: null };
  const r = readImei(text);
  if (!r.ok) return { imei: null, warn: null, problem: r.reason };
  if (r.checkDigit === "invalid") return { imei: r.imei, warn: BAD_CHECK_DIGIT, problem: recordAnyway ? null : BAD_CHECK_START };
  return { imei: r.imei, warn: null, problem: null };
}

/* ─────────────────────────── "Read the screen" (POST /api/imei/read) ─────────────────────────── */

/** What the reader saw. `valid`: IMEI 1 passes its check digit. IMEI 2 only when it does too. */
export type ImeiRead = { imei: string; imei2: string | null; valid: boolean };

/** Said when the server answers 200 with no IMEI (its 422 says the same in its own words). */
export const NOTHING_READ = "No IMEI found in that photo — try again or type it.";
/** A read whose IMEI fails its check digit: into the field, for the advisor to put right. */
export const READ_FAILS_CHECK = "That read fails its check digit — correct it in the IMEI field.";

/** The server's 200 answer {imei, imei2, valid}, or null (no IMEI in it). The check digit is checked here again. */
export function readImeiRead(x: unknown): ImeiRead | null {
  const o = x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
  const imei = typeof o?.imei === "string" ? digits(o.imei).slice(0, 15) : "";
  if (!imei) return null;
  const two = typeof o?.imei2 === "string" ? digits(o.imei2).slice(0, 15) : "";
  return { imei, imei2: two && two !== imei && luhnValid(two) ? two : null, valid: luhnValid(imei) };
}

/** "Read: 35… · IMEI 2 35… — check it against the screen." */
export function readLine(r: Pick<ImeiRead, "imei" | "imei2">): string {
  return `Read: ${r.imei}${r.imei2 ? ` · IMEI 2 ${r.imei2}` : ""} — check it against the screen.`;
}

/* ─────────────────────────── the save ─────────────────────────── */

/**
 * The PATCH /api/cases/<id> body for an IMEI (the store app's imeiPatch, word for word). `caseImei`:
 * the IMEI 1 the case holds now. IMEI 2 goes with it when there is one; with none, a new IMEI 1 sends
 * imei2 null (the old IMEI 2 was another phone's) and the case's own IMEI 1 again leaves it alone.
 */
export function imeiPatch(v: { imei: string; imei2: string | null }, caseImei: string | null): { imei: string; imei2?: string | null } {
  if (v.imei2) return { imei: v.imei, imei2: v.imei2 };
  return v.imei === caseImei ? { imei: v.imei } : { imei: v.imei, imei2: null };
}

/** The desk's fetch (lib/client/api.ts): JSON in, JSON out, the server's sentence as Error.message. */
export type Call = <T = unknown>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

export type StartInput = {
  customerName: string;
  /** 10 digits, or null when not given. */
  customerPhone: string | null;
  /** null = no IMEI yet: it is taken on the case, or at hand-over. */
  imei: { imei: string; imei2: string | null } | null;
  /** The case a failed Start already opened: never a second one for the same customer. */
  caseId: string | null;
};

export type StartResult = { caseId: string; error: null } | { caseId: string | null; error: string };

/**
 * Start a trade-in at the desk: open the case, then save the IMEI with the store app's PATCH — the
 * server looks it up before it answers, so the case opens on what it found. A failed save keeps the
 * case it opened: Start again saves the name, mobile and IMEI on that case in one PATCH.
 */
export async function startCase(call: Call, i: StartInput): Promise<StartResult> {
  let caseId = i.caseId;
  try {
    if (!caseId) {
      const body: { customerName?: string; customerPhone?: string } = {};
      if (i.customerName.trim()) body.customerName = i.customerName.trim();
      if (i.customerPhone) body.customerPhone = i.customerPhone;
      const c = await call<{ id?: unknown }>("/api/cases", { body });
      if (typeof c?.id !== "string") throw new Error("No case came back. Try again.");
      caseId = c.id;
      if (i.imei) await call(`/api/cases/${encodeURIComponent(caseId)}`, { method: "PATCH", body: imeiPatch(i.imei, null) });
    } else {
      const name = i.customerName.trim();
      const customer = name || i.customerPhone ? { name, phone: i.customerPhone ?? "" } : null;
      await call(`/api/cases/${encodeURIComponent(caseId)}`, { method: "PATCH", body: { customer, ...(i.imei ? imeiPatch(i.imei, null) : {}) } });
    }
    return { caseId, error: null };
  } catch (e) {
    return { caseId, error: (e as Error).message || "Something went wrong. Try again." };
  }
}

/* ─────────────────────────── what the server found ─────────────────────────── */

type Lookup = NonNullable<CaseView["imeiLookup"]>;

/** GSMA's word on the IMEI (the store app's). "unknown" is never said as clean. */
export const BLACKLIST_TEXT: Record<Lookup["blacklist"], string> = {
  clean: "not blacklisted (GSMA)",
  unknown: "Blacklist not checked",
  blacklisted: "reported lost or stolen (GSMA)",
};

/**
 * The owner's sentence when GSMA's register stops the trade-in before the tests. The government
 * check (an early KYM answer that isn't clear) says the register's own words instead — never
 * "lost or stolen" for a duplicate or in-use IMEI (domain/imei.ts kymEarlyStop, the server's too).
 */
export const STOP_GSMA = "This phone is reported lost or stolen (GSMA). It can't be traded in.";
/** An IMEI on the case that fails its check digit: kept, never looked up. */
export const NOT_LOOKED_UP = "Not looked up — the IMEI fails its check digit. Re-read *#06#.";

export type ImeiFound = {
  /** "Galaxy S23 Ultra · not blacklisted (GSMA)", NOT_LOOKED_UP, or null (no IMEI, or no answer kept). */
  line: string | null;
  tone: "up" | "warn" | "bad";
  /** The model the IMEI names is the one on the case ("From the IMEI"). */
  modelFromImei: boolean;
  /** The server's warnings (an IMEI already on another trade-in, another model, a blacklisted IMEI 2). */
  warnings: string[];
  /** Why the trade-in stops here, or null: GSMA says blacklisted, or the early KYM answer isn't clear. */
  stop: string | null;
};

/** What the case shows under its IMEI, from the server's view of it — before any test. */
export function imeiFound(v: Pick<CaseView, "imei" | "imeiCheck" | "imeiLookup" | "imeiWarnings" | "kymEarly" | "modelSource">): ImeiFound {
  const l = v.imeiLookup;
  const stop = l?.blacklist === "blacklisted" ? STOP_GSMA : v.kymEarly && v.kymEarly.status !== "clear" ? kymEarlyStop(v.kymEarly.status) : null;
  let line: string | null = null;
  let tone: ImeiFound["tone"] = "warn";
  if (l) {
    const name = l.model ?? l.brand;
    const said = BLACKLIST_TEXT[l.blacklist];
    line = name ? `${name} · ${said}` : said.charAt(0).toUpperCase() + said.slice(1);
    tone = l.blacklist === "clean" ? "up" : l.blacklist === "blacklisted" ? "bad" : "warn";
  } else if (v.imei && v.imeiCheck === "invalid") line = NOT_LOOKED_UP;
  return { line, tone, modelFromImei: v.modelSource === "imei", warnings: v.imeiWarnings ?? [], stop };
}
