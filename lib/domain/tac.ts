/**
 * THE MODEL FROM THE IMEI — free and offline (owner, 2026-10-19: "Scan IMEI first").
 *
 * The first 8 digits of an IMEI are its TAC (Type Allocation Code): GSMA gives one
 * to every model a maker registers, so a TAC names a MODEL — never its storage, its
 * colour or its condition. `tacdb.json` beside this file is a copy of GradeIQ's
 * offline TAC list (gradeiq-live lib/tacdb.json, ~97k TACs → a marketing name such
 * as "Samsung Galaxy S23 Ultra"); `tacLookup` is the copy of GradeIQ's lookup
 * (gradeiq-live lib/imei.ts:26-72). It costs nothing and calls nobody.
 *
 * Mapping a TAC name to one of SwapUp's trade models is EXPLICIT, never fuzzy:
 *   1. TAC_ALIASES — a reviewed table, name → model id (or null: "never map this
 *      name", for a name that could be either of two phones on the list).
 *   2. Otherwise the name must equal the model's own name ("Samsung Galaxy S23 Ultra"
 *      = Samsung + "Galaxy S23 Ultra"), compared without case or repeated spaces —
 *      the TAC list writes "Iphone", "Fe" and "M55S". Nothing else is normalised here;
 *      a trailing " 5G" / " 4G" / " Bespoke" is only ever dropped through the table.
 *   3. A bare name ("Samsung Galaxy M14") never maps while the list ALSO has its
 *      " 5G" / " 4G" sibling ("Galaxy M14 5G"): the TAC list does not say which of
 *      the two it is, so 4G/5G siblings never collide (A14, A22, A23, F14, M13, M14,
 *      M32 today).
 * A model found this way is a CLAIM: the phone's own model code confirms it, and
 * Apply flags a code that disagrees (lib/server/testSessions.ts).
 *
 * Pure functions only — the server loads the list (lib/server/imeiResolve.ts).
 */
import { digits } from "./imei.ts";

/** TAC (8 digits) → marketing name, exactly as GradeIQ's list has it. */
export type TacDb = Readonly<Record<string, string>>;
export type TacModelRef = { id: string; brand: string; model: string };

export type TacMatch = {
  tac: string | null;
  /** The name on the TAC list, as written there; null = the TAC isn't on it. */
  name: string | null;
  /** The catalogue's brand when it mapped, else the name's first word ("Samsung", "Apple"). */
  brand: string | null;
  /** The catalogue's own name when it mapped ("Galaxy S25 FE"), else the rest of the TAC name. */
  model: string | null;
  /** The trade model it names; null = none, or not without a guess. */
  modelId: string | null;
  why: string;
};

/** The TAC of a 14- or 15-digit IMEI; null for anything else. */
export function tacOf(imei: string | null | undefined): string | null {
  const d = digits(imei ?? "");
  return d.length === 14 || d.length === 15 ? d.slice(0, 8) : null;
}

/** "Apple Iphone Air" → { brand: "Apple", model: "iPhone Air" } (GradeIQ's splitName). */
export function splitTacName(name: string): { brand: string; model: string } {
  const fixed = name.replace(/\bIphone\b/g, "iPhone").replace(/\bIpad\b/g, "iPad").replace(/\bIpod\b/g, "iPod");
  const parts = fixed.split(" ");
  return { brand: parts[0] || "", model: parts.slice(1).join(" ") || fixed };
}

/** How names are compared: no case, single spaces. */
export function tacKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** A trade model's full name as the TAC list writes names: "Samsung Galaxy S23 Ultra", "OnePlus 9" (not "OnePlus OnePlus 9"). */
export function catalogueKey(m: Pick<TacModelRef, "brand" | "model">): string {
  const model = tacKey(m.model);
  const brand = tacKey(m.brand);
  return model.startsWith(`${brand} `) ? model : `${brand} ${model}`;
}

/**
 * The reviewed table: TAC name (tacKey form) → trade model id, or null = never map.
 * Every key is a name on the TAC list and every id is on SwapUp's list (lib/domain/tac.test.ts).
 */
export const TAC_ALIASES: Readonly<Record<string, string | null>> = {
  // " 5G" dropped: these phones were only ever made as 5G, and the list has them without it.
  "samsung galaxy s21 5g": "galaxy-s21",
  "samsung galaxy s21+ 5g": "galaxy-s21-plus",
  "samsung galaxy s21 ultra 5g": "galaxy-s21-ultra",
  "samsung galaxy s21 fe 5g": "galaxy-s21-fe",
  "samsung galaxy s22 5g": "galaxy-s22",
  "samsung galaxy s22+ 5g": "galaxy-s22-plus",
  "samsung galaxy s22 ultra 5g": "galaxy-s22-ultra",
  "samsung galaxy s23 5g": "galaxy-s23",
  "samsung galaxy s23 ultra 5g": "galaxy-s23-ultra",
  "samsung galaxy z flip4 5g": "galaxy-z-flip4",
  "samsung galaxy a25 5g": "galaxy-a25", // on file as "Galaxy A25" (SM-A256E, the 5G phone)
  "samsung galaxy a33 5g": "galaxy-a33",
  "samsung galaxy a53 5g": "galaxy-a53",
  "samsung galaxy a52s 5g": "galaxy-a52s",
  "oneplus 9 5g": "oneplus-9",
  "oneplus 10r 5g": "oneplus-10r",
  "oneplus 11 5g": "oneplus-11",
  "vivo v29 5g": "vivo-v29",
  // " 5G" added: on file with it, on the TAC list without it — there is no 4G phone of that name.
  "samsung galaxy a34": "galaxy-a34-5g",
  "samsung galaxy a54": "galaxy-a54-5g",
  "samsung galaxy m16": "galaxy-m16-5g",
  "samsung galaxy m33": "galaxy-m33-5g",
  "samsung galaxy m42": "galaxy-m42-5g",
  "samsung galaxy m53": "galaxy-m53-5g",
  "samsung galaxy m55": "galaxy-m55-5g",
  "samsung galaxy f15": "galaxy-f15-5g",
  // Other spellings of the same phone.
  "samsung galaxy s23 plus": "galaxy-s23-plus",
  "samsung galaxy z flip4 bespoke": "galaxy-z-flip4",
  // " 4G" dropped: on file without it, and the list's 5G sibling is another phone.
  "samsung galaxy a14 4g": "galaxy-a14", // SM-A145F
  "samsung galaxy a52 4g": "galaxy-a52", // SM-A525F
  // Never: the 5G sibling of a 4G phone on file is another phone (A32 5G is SM-A326B, A52 5G SM-A526B).
  "samsung galaxy a32 5g": null,
  "samsung galaxy a52 5g": null,
  // Never: the bare name could be either sibling on file (rule 3 says so too; listed so it is reviewed).
  "samsung galaxy a14": null,
  "samsung galaxy a22": null,
  "samsung galaxy a23": null,
  "samsung galaxy f14": null,
  "samsung galaxy m13": null,
  "samsung galaxy m14": null,
  "samsung galaxy m32": null,
};

/** The name on the TAC list for this IMEI — GradeIQ's tacLookup, without its status fields. */
export function tacLookup(imei: string, db: TacDb): { tac: string; name: string; brand: string; model: string } | null {
  const tac = tacOf(imei);
  if (!tac) return null;
  const name = db[tac];
  if (typeof name !== "string" || !name.trim()) return null;
  return { tac, name, ...splitTacName(name) };
}

/** The trade model a TAC name is, by the three rules above; why = the sentence staff read. */
export function modelForTacName(name: string, models: readonly TacModelRef[]): { modelId: string | null; why: string } {
  const key = tacKey(name);
  if (Object.prototype.hasOwnProperty.call(TAC_ALIASES, key)) {
    const id = TAC_ALIASES[key];
    if (id === null) return { modelId: null, why: `"${name}" could be either of two phones on the list — choose by hand.` };
    return models.some((m) => m.id === id) ? { modelId: id, why: `IMEI type code: ${name}.` } : { modelId: null, why: `"${name}" isn't on SwapUp's list.` };
  }
  const hits = models.filter((m) => catalogueKey(m) === key);
  if (hits.length !== 1) return { modelId: null, why: hits.length ? `"${name}" matches ${hits.length} phones — choose by hand.` : `"${name}" isn't on SwapUp's list.` };
  const sibling = models.some((m) => m.id !== hits[0].id && (catalogueKey(m) === `${key} 5g` || catalogueKey(m) === `${key} 4g`));
  if (sibling) return { modelId: null, why: `"${name}" could be either of two phones on the list — choose by hand.` };
  return { modelId: hits[0].id, why: `IMEI type code: ${name}.` };
}

/** IMEI → the TAC list's name → SwapUp's trade model. Never the storage. */
export function tacModel(imei: string, db: TacDb, models: readonly TacModelRef[]): TacMatch {
  const tac = tacOf(imei);
  const hit = tac ? tacLookup(imei, db) : null;
  if (!hit) return { tac, name: null, brand: null, model: null, modelId: null, why: tac ? `Type code ${tac} isn't on the offline list.` : "Not an IMEI." };
  const m = modelForTacName(hit.name, models);
  const onFile = m.modelId ? models.find((x) => x.id === m.modelId) : undefined;
  return { tac, name: hit.name, brand: onFile ? onFile.brand : hit.brand || null, model: onFile ? onFile.model : hit.model || null, modelId: m.modelId, why: m.why };
}
