import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./auth";
import { db, parseJson } from "./db";
import { GradeiqError, gradeiqConfig, lookupImei, readImeiScreen, type ImeiLookup } from "./gradeiq";
import { tacModel, type TacDb } from "../domain/tac";
import { luhnValid } from "../domain/imei";
import { matchModel, type DeviceReport, type TradeModelRef } from "../domain/diagnostics";

/**
 * THE IMEI FIRST (owner, 2026-10-19: "Scan IMEI first"; GSMA blacklist "Yes, once per trade-in").
 * When an IMEI is saved on a case (updateCase), it is resolved ONCE for that case:
 *
 *   1. the model, free: its TAC on the offline list (lib/domain/tac.ts) → a trade model;
 *   2. GradeIQ's IMEI lookup, paid, once (call A, lib/server/gradeiq.ts lookupImei): make,
 *      model, model number and the GSMA blacklist. A Samsung model number is matched like the
 *      phone's own code (matchModel: exact, then family) and wins over the TAC.
 *
 * The answer is kept per IMEI in cases.imei_lookup (a short list), so saving the same IMEI again
 * never asks GradeIQ again — whatever it answered, a timeout included (no background retry).
 * GradeIQ switched off (GRADEIQ_ENABLED=0), no GRADEIQ_SERVER_KEY, or an IMEI that fails its
 * check digit (a misread is never paid for) → no call: the TAC's answer alone, blacklist "unknown".
 * "unknown" is shown as "Blacklist not checked", never as clean, and GSMA never replaces the
 * government's KYM check (India's CEIR), which the lock still requires.
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
  /** The trade model the IMEI says — model number first, then the TAC; null = none without a guess. */
  modelId: string | null;
  modelWhy: string;
};

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

/** The list with this IMEI's answer in it (replacing an older one for the same IMEI), newest last. */
export function withLookup(raw: string | null | undefined, rec: StoredImeiLookup): string {
  return JSON.stringify([...storedLookups(raw).filter((l) => l.imei !== rec.imei), rec].slice(-KEEP));
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
  const modelId = byCode?.modelId ?? tac.modelId;
  const modelWhy = byCode
    ? `Model number ${found!.modelNumber}${tac.modelId && tac.modelId !== byCode.modelId ? ` (the type code says ${tac.model ?? "another model"})` : ""}: ${byCode.label}.`
    : tac.why;
  return {
    imei,
    brand: found?.brand ?? tac.brand,
    model: found?.model ?? tac.model,
    modelNumber: found?.modelNumber ?? null,
    blacklist: found?.blacklist ?? "unknown",
    source: found?.source ?? (tac.name ? "tac" : "none"),
    at,
    modelId,
    modelWhy,
  };
}

/* ─────────────────────────── blacklisted: the trade-in stops ─────────────────────────── */

/** The sentence the 409 and the lock refusal carry, word for word (contract I3). */
export const BLACKLISTED = "This phone is reported lost or stolen. It can't be traded in.";

export type KymEarly = { status: "clear" | "blacklisted" | "duplicate" | "in_use"; reference: string | null; by: string; at: string };

/** GSMA says blacklisted for the case's IMEI, or the early KYM answer is anything but clear. */
export function isBlacklisted(c: { imei: string | null; imei_lookup?: string | null; kym_early?: string | null }): boolean {
  if (lookupFor(c.imei_lookup, c.imei)?.blacklist === "blacklisted") return true;
  const k = parseJson<KymEarly | null>(c.kym_early ?? null, null);
  return !!k && k.status !== "clear";
}

/** 409 when the case's phone is blacklisted — test sessions and the lock both refuse with it. */
export function assertNotBlacklisted(caseId: string): void {
  const c = db().prepare(`SELECT imei, imei_lookup, kym_early FROM cases WHERE id = ?`).get(caseId) as
    | { imei: string | null; imei_lookup: string | null; kym_early: string | null }
    | undefined;
  if (c && isBlacklisted(c)) throw new HttpError(409, BLACKLISTED, { reason: "blacklisted" });
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
