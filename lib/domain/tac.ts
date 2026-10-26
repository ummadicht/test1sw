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
 *      M32 today). With ONLY the sibling on file ("Samsung Galaxy A16" beside the A16
 *      5G; A15, A17) it is ambiguous too — never "not on SwapUp's list".
 *   4. A name that names no phone — a brand alone ("Samsung", 9,559 TACs) or a series
 *      (TAC_SERIES) — is kind "none": no model, and never "not on the list".
 * A model found this way is a CLAIM: the phone's own model code confirms it, and
 * Apply flags a code that disagrees (lib/server/testSessions.ts); a type-code name of
 * a phone SwapUp doesn't list never overrules the phone's EXACT code there.
 *
 * Pure functions only — the server loads the list (lib/server/imeiResolve.ts).
 */
import { digits } from "./imei.ts";

/** TAC (8 digits) → marketing name, exactly as GradeIQ's list has it. */
export type TacDb = Readonly<Record<string, string>>;
export type TacModelRef = { id: string; brand: string; model: string };

/**
 * What a name says against SwapUp's list (modelForTacName):
 *   mapped     one model on the list
 *   unlisted   a phone, but not one on SwapUp's list (it can't be priced here)
 *   ambiguous  it could be more than one phone — one on the list, or one that isn't — never guessed
 *   none       it names no phone at all: a brand alone ("Samsung" — 9,559 TACs; "Apple" 1,125; 21k in
 *              all) or a series (TAC_SERIES: "Samsung Galaxy", "Oppo Reno"). Never "unlisted": a phone
 *              that IS on the list hides behind those names (review 0.9.4)
 * TacMatch's `none` also covers a TAC that isn't on the offline list, and a number that isn't an IMEI.
 */
export type TacNameKind = "mapped" | "unlisted" | "ambiguous" | "none";

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
  kind: TacNameKind;
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
  // SUP-259: the same phones written with a space or a "-5G" (16 and 34 TACs). "Samsung Galaxy Z Flip 5G"
  // is the 2020 Z Flip 5G — another phone — and stays unmapped.
  "samsung galaxy z flip 5": "galaxy-z-flip5",
  "samsung galaxy z fold4-5g": "galaxy-z-fold4",
  // Never, until the owner decides: "Galaxy S26 Pro" (40 TACs) is the TAC list's name for the phone on
  // file as the S26+. Not "unlisted" either — that would tell a real S26+ it can't be priced.
  "samsung galaxy s26 pro": null,
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

/**
 * Reviewed: TAC names (tacKey form) that name a SERIES, not a phone — they name no model (kind none).
 * Every name on the TAC list with no digit that is the start of a model's name on file is here
 * (lib/domain/tac.test.ts), so a new one is reviewed before it is read as a phone.
 */
export const TAC_SERIES: ReadonlySet<string> = new Set(["samsung galaxy", "oppo reno", "oneplus nord", "xiaomi redmi", "xiaomi redmi note"]);

/** A name that names no phone: empty, a brand alone ("Samsung", "Apple", "Pm-1414-Bv"), or a series (TAC_SERIES). */
export function namesNoModel(name: string): boolean {
  const key = tacKey(name);
  if (!key || !key.includes(" ")) return true;
  const { brand, model } = splitTacName(name.trim().replace(/\s+/g, " "));
  return tacKey(model) === tacKey(brand) || TAC_SERIES.has(key);
}

/** The name on the TAC list for this IMEI — GradeIQ's tacLookup, without its status fields. */
export function tacLookup(imei: string, db: TacDb): { tac: string; name: string; brand: string; model: string } | null {
  const tac = tacOf(imei);
  if (!tac) return null;
  const name = db[tac];
  if (typeof name !== "string" || !name.trim()) return null;
  return { tac, name, ...splitTacName(name) };
}

/** The trade model a TAC name is, by the three rules above; why = the sentence staff read. */
export function modelForTacName(name: string, models: readonly TacModelRef[]): { modelId: string | null; kind: TacNameKind; why: string } {
  const key = tacKey(name);
  const either = { modelId: null, kind: "ambiguous" as const, why: `"${name}" could be more than one phone — choose by hand.` };
  const notOnList = { modelId: null, kind: "unlisted" as const, why: `"${name}" isn't on SwapUp's list.` };
  if (Object.prototype.hasOwnProperty.call(TAC_ALIASES, key)) {
    const id = TAC_ALIASES[key];
    if (id === null) return either;
    return models.some((m) => m.id === id) ? { modelId: id, kind: "mapped", why: `IMEI type code: ${name}.` } : notOnList;
  }
  // A brand alone, or a series: no phone is named — never "not on the list" (a listed phone may be it).
  if (namesNoModel(name)) return { modelId: null, kind: "none", why: `"${name}" doesn't name a model — choose by hand.` };
  const hits = models.filter((m) => catalogueKey(m) === key);
  if (hits.length > 1) return { modelId: null, kind: "ambiguous", why: `"${name}" matches ${hits.length} phones — choose by hand.` };
  // A plain name whose " 5G" / " 4G" phone is on the list ("Samsung Galaxy A16" beside the A16 5G; A15
  // and A17 too): the TAC list doesn't say which it is, and the other one may not be on the list.
  if (!hits.length) return models.some((m) => catalogueKey(m) === `${key} 5g` || catalogueKey(m) === `${key} 4g`) ? either : notOnList;
  const sibling = models.some((m) => m.id !== hits[0].id && (catalogueKey(m) === `${key} 5g` || catalogueKey(m) === `${key} 4g`));
  if (sibling) return either;
  return { modelId: hits[0].id, kind: "mapped", why: `IMEI type code: ${name}.` };
}

/** IMEI → the TAC list's name → SwapUp's trade model. Never the storage. */
export function tacModel(imei: string, db: TacDb, models: readonly TacModelRef[]): TacMatch {
  const tac = tacOf(imei);
  const hit = tac ? tacLookup(imei, db) : null;
  if (!hit) return { tac, name: null, brand: null, model: null, modelId: null, kind: "none", why: tac ? `Type code ${tac} isn't on the offline list.` : "Not an IMEI." };
  const m = modelForTacName(hit.name, models);
  const onFile = m.modelId ? models.find((x) => x.id === m.modelId) : undefined;
  return { tac, name: hit.name, brand: onFile ? onFile.brand : hit.brand || null, model: onFile ? onFile.model : hit.model || null, modelId: m.modelId, kind: m.kind, why: m.why };
}

/* ─────────────────────────── GSMA's name (GradeIQ's IMEI lookup) ─────────────────────────── */

/**
 * GSMA's make and model, as GradeIQ's IMEI lookup returns them, as ONE marketing name in the TAC
 * list's form — so it is mapped by the same explicit rules (modelForTacName), never fuzzily. Apple's
 * answer carries no model number and repeats the brand with Apple's own code on the end
 * ("Apple" + "Apple iPhone 17 Pro Max (A3257)"): the trailing "(A####)" is dropped and the brand is
 * never doubled → "Apple iPhone 17 Pro Max". Casing as GradeIQ's splitName ("Iphone" → "iPhone").
 * null when there is no model to name.
 */
export function gsmaModelName(brand: string | null | undefined, model: string | null | undefined): string | null {
  const clean = (x: string | null | undefined) =>
    (x ?? "")
      .replace(/\s*\(A\d{4}\)\s*$/i, "")
      .replace(/\bIphone\b/g, "iPhone")
      .replace(/\s+/g, " ")
      .trim();
  const m = clean(model);
  if (!m) return null;
  const b = clean(brand);
  if (!b || tacKey(m) === tacKey(b) || tacKey(m).startsWith(`${tacKey(b)} `)) return m;
  return `${b} ${m}`;
}

/**
 * The sources of GradeIQ's IMEI answer that are a real lookup — Phonecheck's GSMA registry ("gsma"), its
 * ESN check ("esn"), a station record ("station"; older GradeIQ "api"), a provider ("provider"). Not its
 * offline TAC list ("tac" — the same list as tacdb.json) and never its illustrative seed ("stub": a
 * handful of demo TACs, made up). Only a real lookup's own name is read as a phone.
 */
export const REAL_LOOKUP_SOURCES: ReadonlySet<string> = new Set(["gsma", "esn", "station", "provider", "api"]);
export const isRealLookup = (source: string | null | undefined): boolean => !!source && REAL_LOOKUP_SOURCES.has(source);

/** What a stored IMEI answer says about the model, read against TODAY's list (imeiModelNow). */
export type ImeiModelNow =
  | { kind: "listed"; modelId: string; label: string }
  /** from: "lookup" = a real lookup (GSMA) named it; "tac" = the offline type-code list alone did. */
  | { kind: "unlisted"; modelId: null; label: string; from: "lookup" | "tac" }
  | { kind: "ambiguous"; modelId: null; label: string }
  | { kind: "none"; modelId: null; label: null };

/** A kept IMEI answer, as much of it as the model is read from (lib/server/imeiResolve.ts StoredImeiLookup). */
export type ImeiAnswerRef = {
  modelId?: string | null;
  brand?: string | null;
  model?: string | null;
  source?: string | null;
  /** A real lookup's own name, in the TAC list's form (gsmaModelName). Absent on answers kept before 0.9.4: brand + model, when the source is a real lookup. */
  gsmaName?: string | null;
  /** The offline TAC list's name. */
  tacName?: string | null;
};

/**
 * A real lookup's own name for the phone, in the TAC list's form — null for no name, a name from
 * GradeIQ's offline list or its made-up stub, or a codename (Samsung's "DM3" for the S23 Ultra: one
 * short token of capitals and digits), which names no phone a person would recognise.
 */
export function gsmaLookupName(brand: string | null | undefined, model: string | null | undefined, source: string | null | undefined): string | null {
  if (!isRealLookup(source)) return null;
  const name = gsmaModelName(brand, model);
  if (!name) return null;
  const rest = splitTacName(name).model;
  return /^(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,4}$/.test(rest) ? null : name;
}

/** The real lookup's own name for the phone (gsmaLookupName); an answer kept before 0.9.4 is read from its brand + model. */
export function lookupNameOf(l: ImeiAnswerRef): string | null {
  if (l.gsmaName !== undefined) return l.gsmaName ?? null;
  return gsmaLookupName(l.brand, l.model, l.source);
}

/**
 * The model an IMEI's stored answer names NOW (owner, 2026-10-25: "model derived from Phonecheck"):
 *   listed     a model on SwapUp's list — the one its model number named (modelId), else the one GSMA's
 *              own name names (a real lookup: Phonecheck's — it wins over the type code), else the one
 *              the offline type-code list names. An answer kept from before a model joined the list is
 *              mapped against today's list
 *   unlisted   a phone that isn't on SwapUp's list (`from` says who named it): it can't be priced here
 *   ambiguous  more than one phone could be it — the two sources disagree (GSMA names a phone not on the
 *              list where the type code names one that is: GSMA's name may be a codename), or a name
 *              either of two phones has — the phone's own code, or the advisor, decides
 *   none       the answer names no phone (an unknown TAC, a brand alone, GradeIQ's made-up stub)
 * `label` is the full name staff read ("Apple iPhone 17 Pro Max"): the catalogue's brand + model when listed.
 * Re-mapping a kept answer is free and offline: no lookup is ever repeated for it.
 */
export function imeiModelNow(l: ImeiAnswerRef | null | undefined, models: readonly TacModelRef[]): ImeiModelNow {
  const none: ImeiModelNow = { kind: "none", modelId: null, label: null };
  if (!l) return none;
  const listed = (id: string | null): ImeiModelNow | null => {
    const m = id ? models.find((x) => x.id === id) : undefined;
    return m ? { kind: "listed", modelId: m.id, label: `${m.brand} ${m.model}` } : null;
  };
  const byId = listed(l.modelId ?? null);
  if (byId) return byId;
  const gsma = lookupNameOf(l);
  const tac = l.tacName ? gsmaModelName(null, l.tacName) : null;
  const byGsma = gsma ? modelForTacName(gsma, models) : null;
  const byTac = tac ? modelForTacName(tac, models) : null;
  const fromGsma = byGsma?.kind === "mapped" ? listed(byGsma.modelId) : null;
  if (fromGsma) return fromGsma;
  const fromTac = byTac?.kind === "mapped" ? listed(byTac.modelId) : null;
  if (fromTac) return byGsma?.kind === "unlisted" ? { kind: "ambiguous", modelId: null, label: gsma! } : fromTac;
  if (byGsma?.kind === "unlisted") return { kind: "unlisted", modelId: null, label: gsma!, from: "lookup" };
  if (byGsma?.kind === "ambiguous") return { kind: "ambiguous", modelId: null, label: gsma! };
  if (byTac?.kind === "unlisted") return { kind: "unlisted", modelId: null, label: tac!, from: "tac" };
  if (byTac?.kind === "ambiguous") return { kind: "ambiguous", modelId: null, label: tac! };
  return none;
}

/**
 * The IMEI's two sources name different phones: GSMA's own name (a real lookup) and the offline type-code
 * list's — one names a model on the list and the other another model, or one that isn't on it. Both are
 * said to staff (cases.ts imeiWarnings); null when they agree, or only one of them names a phone.
 */
export function imeiSourcesDisagree(l: ImeiAnswerRef | null | undefined, models: readonly TacModelRef[]): { gsma: string; tac: string } | null {
  if (!l) return null;
  const gsma = lookupNameOf(l);
  const tac = l.tacName ? gsmaModelName(null, l.tacName) : null;
  if (!gsma || !tac) return null;
  const a = modelForTacName(gsma, models);
  const b = modelForTacName(tac, models);
  const definite = (r: typeof a) => r.kind === "mapped" || r.kind === "unlisted";
  if (!definite(a) || !definite(b) || (a.kind === "unlisted" && b.kind === "unlisted")) return null;
  if (a.kind === "mapped" && b.kind === "mapped" && a.modelId === b.modelId) return null;
  const label = (n: string, r: typeof a) => {
    const m = r.kind === "mapped" ? models.find((x) => x.id === r.modelId) : undefined;
    return m ? `${m.brand} ${m.model}` : n;
  };
  return { gsma: label(gsma, a), tac: label(tac, b) };
}
