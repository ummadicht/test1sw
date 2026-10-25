import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./auth";
import { db, parseJson } from "./db";
import { GradeiqError, gradeiqConfig, lookupImei, readImeiScreen, type ImeiLookup } from "./gradeiq";
import { gsmaModelName, imeiModelNow, modelForTacName, tacModel, type ImeiModelNow, type TacDb } from "../domain/tac";
import { kymEarlyStop, luhnValid, type KymStatus } from "../domain/imei";
import { matchModel, type DeviceReport, type TradeModelRef } from "../domain/diagnostics";

/**
 * THE IMEI FIRST (owner, 2026-10-19: "Scan IMEI first"; GSMA blacklist "Yes, once per trade-in").
 * When an IMEI is saved on a case (updateCase), it is resolved ONCE for that case:
 *
 *   1. the model, free: its TAC on the offline list (lib/domain/tac.ts) → a trade model;
 *   2. GradeIQ's IMEI lookup, paid, once (call A, lib/server/gradeiq.ts lookupImei): make,
 *      model, model number and the GSMA blacklist. A Samsung model number is matched like the
 *      phone's own code (matchModel: exact, then family) and wins over the TAC; with neither, GSMA's
 *      own name (Apple's carries no model number: "Apple iPhone 17 Pro Max (A3257)") is mapped by
 *      the TAC list's explicit rules (tac.ts gsmaModelName, modelForTacName).
 *
 * What staff read is the catalogue's brand and model when one mapped — never GSMA's codename
 * ("DM3") or Apple's "(A####)". The record keeps `modelKind` (listed / unlisted / ambiguous / none)
 * and the TAC list's own name, so an answer kept from before a model joined the list is re-mapped
 * against today's list for free (tac.ts imeiModelNow, caseImeiModel) — never looked up again.
 *
 * The answer is kept per IMEI in cases.imei_lookup (a short list), so saving the same IMEI again
 * never asks GradeIQ again — whatever it answered, a timeout included (no background retry).
 * GradeIQ switched off (GRADEIQ_ENABLED=0), no GRADEIQ_SERVER_KEY, or an IMEI that fails its
 * check digit (a misread is never paid for) → no call: the TAC's answer alone, blacklist "unknown".
 * "unknown" is shown as "Blacklist not checked", never as clean, and GSMA never replaces the
 * government's KYM check (India's CEIR), which the lock still requires.
 *
 * A "blacklisted" answer stops the CASE, for good: whichever slot that number is in now, or none
 * (blacklistedLookup) — a re-scan that reads the phone's IMEI 2 first must not get it through.
 */

/** SwapUp's trade models, for matching (each server module that matches keeps its own read). */
export function tradeModelRefs(): TradeModelRef[] {
  return (db().prepare(`SELECT id, brand, model, variants, model_codes FROM trade_models`).all() as {
    id: string;
    brand: string;
    model: string;
    variants: string;
    model_codes: string;
  }[]).map((r) => ({ id: r.id, brand: r.brand, model: r.model, variants: parseJson<string[]>(r.variants, []), modelCodes: parseJson<string[]>(r.model_codes, []) }));
}

let TACDB: TacDb | null = null;

/** GradeIQ's offline TAC list (lib/domain/tacdb.json, ~2.7 MB), read once. Missing → empty: no model from the IMEI. */
export function tacDb(): TacDb {
  if (TACDB) return TACDB;
  try {
    TACDB = JSON.parse(readFileSync(join(process.cwd(), "lib", "domain", "tacdb.json"), "utf8")) as TacDb;
  } catch (e) {
    console.error("[swapup] the TAC list (lib/domain/tacdb.json) could not be read — no model from the IMEI", (e as Error).message);
    TACDB = {};
  }
  return TACDB;
}

/** One IMEI's answer, as cases.imei_lookup keeps it (the view shows only the ImeiLookup part). */
export type StoredImeiLookup = ImeiLookup & {
  imei: string;
  /** The trade model the IMEI says — model number first, then the TAC, then GSMA's name; null = none without a guess. */
  modelId: string | null;
  modelWhy: string;
  /** What it named against the list when it was resolved (imeiModelNow's kinds). Absent on answers kept before 0.9.4. */
  modelKind?: ImeiModelNow["kind"];
  /** The offline TAC list's name for it ("Apple Iphone 17 Pro Max"), for re-mapping. Absent before 0.9.4. */
  tacName?: string | null;
};

/** What the advisor is told — and staff read in place of a price — for an IMEI naming a phone SwapUp doesn't list. */
export const imeiUnlistedSentence = (label: string) => `The IMEI says ${label} — not on SwapUp's list, so it can't be priced here yet.`;
/** An IMEI looked up that names no model (an unknown type code, or one either of two phones could have). */
export const IMEI_NAMES_NO_MODEL = "The IMEI doesn't name a model — choose it on the case.";

/**
 * The model the case's IMEI names NOW: IMEI 1's kept answer read against today's list (imeiModelNow) —
 * only IMEI 1 is ever looked up. none = no IMEI, no answer kept (a misread is never looked up), or an
 * answer that names nothing.
 */
export function caseImeiModel(c: { imei: string | null; imei_lookup?: string | null }, refs: TradeModelRef[] = tradeModelRefs()): ImeiModelNow {
  return imeiModelNow(lookupFor(c.imei_lookup, c.imei), refs);
}

/** "Apple iPhone 17 Pro Max" → "iPhone 17 Pro Max" beside brand "Apple", as the catalogue writes models; "OnePlus 12" stays whole. */
function modelPart(full: string, brand: string | null): string {
  if (!brand || !full.toLowerCase().startsWith(`${brand.toLowerCase()} `)) return full;
  const rest = full.slice(brand.length + 1).trim();
  return rest && !/^\d/.test(rest) ? rest : full;
}

const KEEP = 5;

export function storedLookups(raw: string | null | undefined): StoredImeiLookup[] {
  const list = parseJson<unknown>(raw, []);
  return Array.isArray(list) ? (list.filter((x) => x && typeof x === "object" && typeof (x as { imei?: unknown }).imei === "string") as StoredImeiLookup[]) : [];
}

/** The stored answer for this IMEI, if the case ever had it looked up. */
export function lookupFor(raw: string | null | undefined, imei: string | null | undefined): StoredImeiLookup | null {
  if (!imei) return null;
  return storedLookups(raw).find((l) => l.imei === imei) ?? null;
}

/**
 * The list with this IMEI's answer in it (replacing an older one for the same IMEI), newest last:
 * the last KEEP answers — and every "blacklisted" one, however old. That stop is the case's.
 */
export function withLookup(raw: string | null | undefined, rec: StoredImeiLookup): string {
  const list = [...storedLookups(raw).filter((l) => l.imei !== rec.imei), rec];
  const recent = new Set(list.filter((l) => l.blacklist !== "blacklisted").slice(-KEEP));
  return JSON.stringify(list.filter((l) => l.blacklist === "blacklisted" || recent.has(l)));
}

type CaseImeis = { imei: string | null; imei2?: string | null; imei_lookup?: string | null };

/**
 * GSMA's "blacklisted" for the case — for ANY IMEI ever saved on it, not only the one in the IMEI 1
 * slot (a re-scan can put a phone's two numbers in either order, and a blacklisted number moved to
 * IMEI 2, or replaced, is still that answer). Sticky: no later IMEI clears it. Free: the answers are
 * already on the case — IMEI 2 is never looked up on its own. The current IMEI 1's answer first,
 * then IMEI 2's, then the newest other.
 */
export function blacklistedLookup(c: CaseImeis): StoredImeiLookup | null {
  const bad = storedLookups(c.imei_lookup).filter((l) => l.blacklist === "blacklisted");
  return bad.find((l) => l.imei === c.imei) ?? bad.find((l) => !!c.imei2 && l.imei === c.imei2) ?? bad.at(-1) ?? null;
}

/**
 * What the case view shows (`imeiLookup`): the current IMEI 1's answer — "blacklisted" whenever the
 * case is (blacklistedLookup), so every screen that stops on it stops. No answer for IMEI 1 (none,
 * or a misread) with the case blacklisted → the blacklisted number's own answer.
 */
export function caseLookupView(c: CaseImeis): ImeiLookup | null {
  const own = lookupFor(c.imei_lookup, c.imei);
  const bad = blacklistedLookup(c);
  if (!bad) return imeiLookupView(own);
  return imeiLookupView(own ? { ...own, blacklist: "blacklisted" } : bad);
}

/** The warning naming a blacklisted number that isn't the one in the IMEI 1 slot; null when there is none. */
export function blacklistWarning(c: CaseImeis): string | null {
  const bad = blacklistedLookup(c);
  if (!bad || bad.imei === c.imei) return null;
  if (c.imei2 && bad.imei === c.imei2) return `IMEI 2 (${bad.imei}) is reported lost or stolen (GSMA).`;
  return `IMEI ${bad.imei}, saved on this case before, is reported lost or stolen (GSMA).`;
}

/** What the case view shows of it (docs/MOBILE-API.md, "IMEI first"). */
export function imeiLookupView(l: StoredImeiLookup | null): ImeiLookup | null {
  return l ? { brand: l.brand, model: l.model, modelNumber: l.modelNumber, blacklist: l.blacklist, source: l.source, at: l.at } : null;
}

/**
 * Resolve an IMEI: the TAC model, then GradeIQ's lookup (only when it may be called — see above).
 * Never throws for GradeIQ: a failure is "unknown", in the record.
 */
export async function resolveImei(imei: string, refs: TradeModelRef[], at: string): Promise<StoredImeiLookup> {
  const tac = tacModel(imei, tacDb(), refs);
  const cfg = gradeiqConfig();
  let found: ImeiLookup | null = null;
  if (cfg.enabled && cfg.serverKey && luhnValid(imei)) {
    try {
      found = await lookupImei(imei, at);
    } catch (e) {
      // Recorded as not checked, and not asked again for this IMEI on this case.
      console.error("[swapup] GradeIQ IMEI lookup", e instanceof GradeiqError ? e.kind : "error", (e as Error).message);
    }
  }
  // A Samsung model number is the maker's own code: the same match the phone's code gets.
  const code = found?.modelNumber ? matchModel({ modelCode: found.modelNumber, modelName: null } as unknown as DeviceReport, refs) : null;
  const byCode = code?.modelId ? code : null;
  // GSMA's own name, "(A####)" dropped — mapped like a TAC name, only when neither the model number
  // nor the TAC named a model (an Apple answer carries no model number).
  const gsmaName = gsmaModelName(found?.brand, found?.model);
  const byName = !byCode && !tac.modelId && gsmaName ? modelForTacName(gsmaName, refs) : null;
  const modelId = byCode?.modelId ?? tac.modelId ?? (byName?.kind === "mapped" ? byName.modelId : null);
  const modelWhy = byCode
    ? `Model number ${found!.modelNumber}${tac.modelId && tac.modelId !== byCode.modelId ? ` (the type code says ${tac.model ?? "another model"})` : ""}: ${byCode.label}.`
    : tac.modelId
      ? tac.why
      : byName?.kind === "mapped"
        ? `GSMA: ${gsmaName}.`
        : (byName?.why ?? tac.why);
  // Staff read the catalogue's brand and model when one mapped — never a codename ("DM3") or "(A3257)".
  const onFile = modelId ? refs.find((m) => m.id === modelId) : undefined;
  const brand = onFile?.brand ?? found?.brand ?? tac.brand;
  const model = onFile?.model ?? (gsmaName ? modelPart(gsmaName, brand) : tac.model);
  return {
    imei,
    brand,
    model,
    modelNumber: found?.modelNumber ?? null,
    blacklist: found?.blacklist ?? "unknown",
    source: found?.source ?? (tac.name ? "tac" : "none"),
    at,
    modelId,
    modelWhy,
    modelKind: imeiModelNow({ modelId, brand, model, tacName: tac.name }, refs).kind,
    tacName: tac.name,
  };
}

/* ─────────────────────────── blacklisted: the trade-in stops ─────────────────────────── */

/** The sentence the 409 and the lock refusal carry, word for word (contract I3). */
export const BLACKLISTED = "This phone is reported lost or stolen. It can't be traded in.";

export type KymEarly = { status: KymStatus; reference: string | null; by: string; at: string };

/**
 * GSMA says blacklisted for any IMEI ever saved on the case (blacklistedLookup), or the early KYM
 * answer is anything but clear — no test starts. The lock asks only GSMA's half (gsmaBlacklisted):
 * there the advisor's own KYM answer, which must be clear, supersedes the early one.
 */
export function isBlacklisted(c: CaseImeis & { kym_early?: string | null }): boolean {
  if (gsmaBlacklisted(c)) return true;
  const k = parseJson<KymEarly | null>(c.kym_early ?? null, null);
  return !!k && k.status !== "clear";
}

/** GSMA's half of isBlacklisted: a stop nothing the advisor says can lift. */
export function gsmaBlacklisted(c: CaseImeis): boolean {
  return !!blacklistedLookup(c);
}

/**
 * 409 when the case's phone is blacklisted — test sessions refuse with it (the lock: lockTradeIn).
 * GSMA's "blacklisted" says BLACKLISTED; an early KYM answer that isn't clear says the register's
 * own words (domain/imei.ts kymEarlyStop: "IMEI register says "Duplicate IMEI" — check it before
 * testing."), never "lost or stolen" for a duplicate or in-use IMEI (SUP-17). Both carry reason
 * "blacklisted": the apps stop the trade-in on it and print the sentence.
 */
export function assertNotBlacklisted(caseId: string): void {
  const c = db().prepare(`SELECT imei, imei2, imei_lookup, kym_early FROM cases WHERE id = ?`).get(caseId) as
    | { imei: string | null; imei2: string | null; imei_lookup: string | null; kym_early: string | null }
    | undefined;
  if (!c || !isBlacklisted(c)) return;
  if (gsmaBlacklisted(c)) throw new HttpError(409, BLACKLISTED, { reason: "blacklisted" });
  const k = parseJson<KymEarly | null>(c.kym_early, null);
  throw new HttpError(409, kymEarlyStop(k?.status ?? ""), { reason: "blacklisted" });
}

/* ─────────────────────────── call 0: read the *#06# screen ─────────────────────────── */

export const READER_OFF = "The screen reader is off — scan or type the IMEI.";
export const NO_IMEI_IN_PHOTO = "No IMEI found in that photo — try again or type it.";
/** Photos larger than this are refused before anything is sent (a phone camera's JPEG is ~1–4 MB as base64). */
export const MAX_PHOTO_CHARS = 8_000_000;

/**
 * POST /api/imei/read — the advisor photographed the customer's *#06# screen; GradeIQ's AI reads
 * it (call 0, stateless: no session, no lookup). The answer is "Read: 35… — confirm" in the apps,
 * never trusted by itself: nothing is saved here. → {imei, imei2, valid} (valid = Luhn of imei);
 * 503 reader_off when GradeIQ's reader can't be used (off, no key, its AI refused, slow, down);
 * 422 not_found when it read the photo and found no IMEI.
 */
export async function readImeiPhoto(photo: unknown): Promise<{ imei: string; imei2: string | null; valid: boolean }> {
  if (typeof photo !== "string" || !/^data:image\/[a-z0-9.+-]+;base64,./i.test(photo)) throw new HttpError(400, "Send the photo as a data:image/jpeg;base64 URL.");
  if (photo.length > MAX_PHOTO_CHARS) throw new HttpError(413, "That photo is too large — take it again.");
  const off = () => new HttpError(503, READER_OFF, { reason: "reader_off" });
  const cfg = gradeiqConfig();
  if (!cfg.enabled || !cfg.serverKey) throw off();
  let r: Awaited<ReturnType<typeof readImeiScreen>>;
  try {
    r = await readImeiScreen(photo);
  } catch (e) {
    console.error("[swapup] GradeIQ IMEI reader", e instanceof GradeiqError ? e.kind : "error", (e as Error).message);
    throw off();
  }
  if (r.imei) return { imei: r.imei, imei2: r.imei2, valid: luhnValid(r.imei) };
  // GradeIQ looked and found nothing (or couldn't decode the image) — the photo; anything else is the reader.
  if (!r.error || r.error === "not_found" || r.error === "bad_image") throw new HttpError(422, NO_IMEI_IN_PHOTO, { reason: "not_found" });
  throw off();
}
