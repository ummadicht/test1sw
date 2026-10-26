/**
 * The model from the IMEI (lib/domain/tac.ts) against the REAL offline TAC list (tacdb.json, the
 * copy of GradeIQ's) and SwapUp's real catalogue (lib/server/seed-data.json): every alias is a name
 * on the list and a model on file, 4G/5G siblings never collide, nothing is matched loosely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TAC_ALIASES,
  TAC_SERIES,
  catalogueKey,
  gsmaLookupName,
  gsmaModelName,
  imeiModelNow,
  imeiSourcesDisagree,
  modelForTacName,
  namesNoModel,
  splitTacName,
  tacKey,
  tacLookup,
  tacModel,
  tacOf,
  type TacDb,
  type TacModelRef,
} from "./tac.ts";
import { luhnCheckDigit } from "./imei.ts";

const DB = JSON.parse(readFileSync(new URL("./tacdb.json", import.meta.url), "utf8")) as TacDb;
const SEED = JSON.parse(readFileSync(new URL("../server/seed-data.json", import.meta.url), "utf8")) as { tradeModels: TacModelRef[] };
const MODELS: TacModelRef[] = SEED.tradeModels.map((m) => ({ id: m.id, brand: m.brand, model: m.model }));
const NAMES = [...new Set(Object.values(DB))];
const KEYS = new Set(NAMES.map(tacKey));
/** A Luhn-valid IMEI on the first TAC the list has for `name`. */
function imeiFor(name: string): string {
  const tac = Object.keys(DB).find((t) => DB[t] === name);
  assert.ok(tac, `no TAC for ${name}`);
  const body = `${tac}123456`;
  return body + String(luhnCheckDigit(body));
}
const modelOf = (name: string) => modelForTacName(name, MODELS).modelId;

test("the TAC list is GradeIQ's copy: ~97k TACs, 8 digits each", () => {
  assert.ok(Object.keys(DB).length > 90_000, String(Object.keys(DB).length));
  assert.ok(Object.keys(DB).every((t) => /^\d{8}$/.test(t)));
});

test("tacOf: the first 8 digits of a 14- or 15-digit IMEI; anything else is not an IMEI", () => {
  assert.equal(tacOf("356938035643809"), "35693803");
  assert.equal(tacOf("35 693803 564380 9"), "35693803", "spaces as printed");
  assert.equal(tacOf("35693803564380"), "35693803", "14 digits (no check digit)");
  assert.equal(tacOf("3569380356438"), null);
  assert.equal(tacOf(""), null);
  assert.equal(tacOf(null), null);
});

test("splitTacName fixes GradeIQ's casing of Apple names, as GradeIQ does", () => {
  assert.deepEqual(splitTacName("Apple Iphone 13 Pro"), { brand: "Apple", model: "iPhone 13 Pro" });
  assert.deepEqual(splitTacName("Samsung Galaxy S23 Ultra"), { brand: "Samsung", model: "Galaxy S23 Ultra" });
});

test("every alias is a name on the TAC list and every target is a model on SwapUp's list", () => {
  const ids = new Set(MODELS.map((m) => m.id));
  for (const [k, id] of Object.entries(TAC_ALIASES)) {
    assert.equal(k, tacKey(k), `alias key "${k}" is in tacKey form`);
    assert.ok(KEYS.has(k), `alias "${k}" isn't a name on the TAC list`);
    if (id !== null) assert.ok(ids.has(id), `alias "${k}" → unknown model ${id}`);
  }
});

test("exact names map, compared without case — the list writes Iphone, Fe, M55S, 6A", () => {
  assert.equal(modelOf("Samsung Galaxy S23 Ultra"), "galaxy-s23-ultra");
  assert.equal(modelOf("Samsung Galaxy S25 Fe"), "galaxy-s25-fe");
  assert.equal(modelOf("Samsung Galaxy M55S 5G"), "galaxy-m55s-5g");
  assert.equal(modelOf("Apple Iphone 13"), "iphone-13");
  assert.equal(modelOf("Google Pixel 6A"), "pixel-6a");
  assert.equal(modelOf("Oneplus 12"), "oneplus-12", "a model whose name starts with its brand");
  assert.equal(modelOf("Vivo V27"), "vivo-v27");
});

test("nothing loose: a longer or shorter name is another phone", () => {
  assert.equal(modelOf("Apple Iphone 13 Pro Max"), "iphone-13-pro-max", "the 13 Pro Max itself — never the 13 Pro");
  assert.equal(modelOf("Apple Iphone 13 Mini"), null, "not the 13");
  assert.equal(modelOf("Samsung Galaxy S26 Pro"), null);
  assert.equal(modelOf("Oneplus Nord Ce 3 Lite 5G"), null, "the CE 3 Lite is not the CE 3");
  assert.equal(modelOf("Samsung Galaxy A23 Ae"), null);
  assert.equal(modelOf("Samsung Galaxy S21 5G Olympoc"), null);
  assert.equal(modelOf("Samsung Galaxy A15"), null, "the A15 (LTE) is not the A15 5G on file");
  assert.equal(modelOf("Samsung Galaxy A17 4G"), null, "the A17 4G is not the A17 5G on file");
});

test("4G/5G siblings never collide: A14, A22, A23, F14, M13, M14, M32", () => {
  for (const x of ["A14", "A22", "A23", "F14", "M13", "M14", "M32"]) {
    const four = `galaxy-${x.toLowerCase()}`;
    const five = `galaxy-${x.toLowerCase()}-5g`;
    assert.ok(MODELS.some((m) => m.id === four) && MODELS.some((m) => m.id === five), `${x}: both siblings are on file`);
    assert.equal(modelOf(`Samsung Galaxy ${x}`), null, `bare "Galaxy ${x}" could be either — never guessed`);
    const fiveName = NAMES.find((n) => tacKey(n) === tacKey(`Samsung Galaxy ${x} 5G`));
    if (fiveName) assert.equal(modelOf(fiveName), five, `"${fiveName}" is the 5G phone`);
    // And no name on the whole list lands the 4G phone's TACs on the 5G model or back.
    for (const n of NAMES) {
      const id = modelOf(n);
      if (id === five) assert.match(tacKey(n), /5g$/, `"${n}" reached ${five} without saying 5G`);
      if (id === four) assert.doesNotMatch(tacKey(n), /5g$/, `"${n}" reached ${four} although it says 5G`);
    }
  }
  assert.equal(modelOf("Samsung Galaxy A14 4G"), "galaxy-a14", "the name that says 4G is the 4G phone");
  assert.ok(!NAMES.some((n) => modelOf(n) === "galaxy-m14-5g"), "nothing on the list says M14 5G, so nothing reaches it — not even the bare M14");
});

test("rule 3 holds for any catalogue: a bare name with a 5G sibling on file never maps, alias or not", () => {
  const models: TacModelRef[] = [
    { id: "x", brand: "Samsung", model: "Galaxy Q9" },
    { id: "x5", brand: "Samsung", model: "Galaxy Q9 5G" },
  ];
  assert.equal(modelForTacName("Samsung Galaxy Q9", models).modelId, null);
  assert.equal(modelForTacName("Samsung Galaxy Q9 5G", models).modelId, "x5");
  assert.equal(modelForTacName("Samsung Galaxy Q9", [models[0]]).modelId, "x", "alone on file, the name is that phone");
});

test("the documented forms: ' 5G' dropped only where the phone was only ever 5G; the other phone of an A32/A52 5G never maps", () => {
  assert.equal(modelOf("Samsung Galaxy S21 Ultra 5G"), "galaxy-s21-ultra");
  assert.equal(modelOf("Samsung Galaxy S22 5G"), "galaxy-s22");
  assert.equal(modelOf("Samsung Galaxy Z Flip4 5G"), "galaxy-z-flip4");
  assert.equal(modelOf("Samsung Galaxy Z Flip4 Bespoke"), "galaxy-z-flip4");
  assert.equal(modelOf("Samsung Galaxy A34"), "galaxy-a34-5g");
  assert.equal(modelOf("Samsung Galaxy A32"), "galaxy-a32", "the 4G A32 on file (SM-A325F)");
  assert.equal(modelOf("Samsung Galaxy A32 5G"), null, "the A32 5G (SM-A326B) is another phone");
  assert.equal(modelOf("Samsung Galaxy A52 4G"), "galaxy-a52");
  assert.equal(modelOf("Samsung Galaxy A52 5G"), null);
});

test("an alias to a model the catalogue doesn't have maps to nothing", () => {
  assert.equal(modelForTacName("Samsung Galaxy S23 Ultra 5G", [{ id: "galaxy-s23", brand: "Samsung", model: "Galaxy S23" }]).modelId, null);
});

test("coverage: 126 of the 152 models on file are reached by a TAC name (the rest are newer than the list, or ambiguous)", () => {
  const reached = new Set(NAMES.map(modelOf).filter(Boolean));
  assert.equal(reached.size, 126);
  for (const id of ["galaxy-z-fold8", "galaxy-s26-fe", "galaxy-m14-5g", "galaxy-m14", "galaxy-a22"]) assert.ok(!reached.has(id), id);
});

test("tacModel: IMEI → the list's name → the model, with the catalogue's own spelling; never a storage", () => {
  const m = tacModel(imeiFor("Samsung Galaxy S25 Fe"), DB, MODELS);
  assert.deepEqual(m, { tac: m.tac, name: "Samsung Galaxy S25 Fe", brand: "Samsung", model: "Galaxy S25 FE", modelId: "galaxy-s25-fe", kind: "mapped", why: "IMEI type code: Samsung Galaxy S25 Fe." });
  assert.ok(!("variant" in m));
  const mini = tacModel(imeiFor("Apple Iphone 13 Mini"), DB, MODELS);
  assert.deepEqual([mini.brand, mini.model, mini.modelId, mini.kind], ["Apple", "iPhone 13 Mini", null, "unlisted"], "named, not on file");
  const unknown = tacModel("352099001761481", DB, MODELS);
  assert.deepEqual([unknown.tac, unknown.name, unknown.modelId, unknown.kind], ["35209900", null, null, "none"]);
  assert.equal(tacModel("12", DB, MODELS).tac, null);
  assert.equal(tacLookup("12", DB), null);
});

test("catalogueKey: brand + model, without doubling a brand already in the name", () => {
  assert.equal(catalogueKey({ brand: "Samsung", model: "Galaxy S23" }), "samsung galaxy s23");
  assert.equal(catalogueKey({ brand: "OnePlus", model: "OnePlus 9" }), "oneplus 9");
  assert.equal(catalogueKey({ brand: "Google", model: "Pixel 7" }), "google pixel 7");
});

/* ─────────────────────────── SUP-259: the iPhones an IMEI names, and two Samsung spellings ─────────────────────────── */

test("SUP-259: the 13 iPhones added to the list are each named by the TAC list, with their own storage sizes", () => {
  const ADDED: [string, string, string[]][] = [
    ["Apple Iphone 13 Pro Max", "iphone-13-pro-max", ["128GB", "256GB", "512GB", "1TB"]],
    ["Apple Iphone 14 Plus", "iphone-14-plus", ["128GB", "256GB", "512GB"]],
    ["Apple Iphone 14 Pro Max", "iphone-14-pro-max", ["128GB", "256GB", "512GB", "1TB"]],
    ["Apple Iphone 15 Plus", "iphone-15-plus", ["128GB", "256GB", "512GB"]],
    ["Apple Iphone 15 Pro Max", "iphone-15-pro-max", ["256GB", "512GB", "1TB"]],
    ["Apple Iphone 16 Plus", "iphone-16-plus", ["128GB", "256GB", "512GB"]],
    ["Apple Iphone 16 Pro", "iphone-16-pro", ["128GB", "256GB", "512GB", "1TB"]],
    ["Apple Iphone 16 Pro Max", "iphone-16-pro-max", ["256GB", "512GB", "1TB"]],
    ["Apple Iphone 16E", "iphone-16e", ["128GB", "256GB", "512GB"]],
    ["Apple Iphone 17", "iphone-17", ["256GB", "512GB"]],
    ["Apple Iphone Air", "iphone-air", ["256GB", "512GB", "1TB"]],
    ["Apple Iphone 17 Pro", "iphone-17-pro", ["256GB", "512GB", "1TB"]],
    ["Apple Iphone 17 Pro Max", "iphone-17-pro-max", ["256GB", "512GB", "1TB", "2TB"]],
  ];
  const full = SEED.tradeModels as (TacModelRef & { variants: string[]; serviceTier: string })[];
  for (const [name, id, sizes] of ADDED) {
    assert.ok(NAMES.includes(name), `"${name}" is on the TAC list`);
    assert.equal(modelOf(name), id, name);
    const m = full.find((x) => x.id === id)!;
    assert.deepEqual([m.brand, m.variants, m.serviceTier], ["Apple", sizes, "other"], id);
    assert.equal(tacModel(imeiFor(name), DB, MODELS).modelId, id, `an IMEI on a ${name} TAC names ${id}`);
  }
  assert.equal(full.filter((m) => m.brand === "Apple").length, 22, "9 iPhones before, 13 added");
});

test("SUP-259: 'Galaxy Z Flip 5' and 'Galaxy Z Fold4-5G' are the Flip5 and Fold4 on file; the 2020 'Z Flip 5G' is another phone", () => {
  assert.equal(modelOf("Samsung Galaxy Z Flip 5"), "galaxy-z-flip5");
  assert.equal(modelOf("Samsung Galaxy Z Fold4-5G"), "galaxy-z-fold4");
  assert.equal(modelOf("Samsung Galaxy Z Flip5"), "galaxy-z-flip5", "the list's other spelling still maps");
  assert.equal(modelOf("Samsung Galaxy Z Flip 5G"), null, "the 2020 Z Flip 5G is not the Flip5");
  assert.equal(modelOf("Samsung Galaxy S26 Pro"), null, "against the S26+ on file: the owner decides");
});

/* ─────────────────────────── SUP-258: what kind of answer, GSMA's name, the model NOW ─────────────────────────── */

test("SUP-258: modelForTacName says what kind of answer it is — mapped, unlisted (a phone, not on SwapUp's list), ambiguous (never guessed)", () => {
  assert.deepEqual(modelForTacName("Apple Iphone 17 Pro Max", MODELS), { modelId: "iphone-17-pro-max", kind: "mapped", why: "IMEI type code: Apple Iphone 17 Pro Max." });
  assert.deepEqual(modelForTacName("Apple Iphone 13 Mini", MODELS), { modelId: null, kind: "unlisted", why: '"Apple Iphone 13 Mini" isn\'t on SwapUp\'s list.' });
  assert.equal(modelForTacName("Samsung Galaxy A14", MODELS).kind, "ambiguous", "the reviewed table's never");
  const q9: TacModelRef[] = [
    { id: "x", brand: "Samsung", model: "Galaxy Q9" },
    { id: "x5", brand: "Samsung", model: "Galaxy Q9 5G" },
  ];
  assert.equal(modelForTacName("Samsung Galaxy Q9", q9).kind, "ambiguous", "a 4G/5G sibling on file");
  assert.equal(modelForTacName("Samsung Galaxy Q9", [q9[0], { ...q9[0], id: "y" }]).kind, "ambiguous", "two phones of that name");
  assert.equal(modelForTacName("Samsung Galaxy S23 Ultra 5G", [{ id: "galaxy-s23", brand: "Samsung", model: "Galaxy S23" }]).kind, "unlisted", "an alias to a model not on this list");
});

test("SUP-258: gsmaModelName — Apple's '(A####)' dropped, the brand never doubled, the TAC list's casing", () => {
  assert.equal(gsmaModelName("Apple", "Apple iPhone 17 Pro Max (A3257)"), "Apple iPhone 17 Pro Max", "SU-AND-00048's answer");
  assert.equal(gsmaModelName("Apple", "iPhone 17 Pro Max (A3257)"), "Apple iPhone 17 Pro Max");
  assert.equal(gsmaModelName("Apple", "Apple Iphone 13"), "Apple iPhone 13");
  assert.equal(gsmaModelName("Samsung", "Galaxy Z Flip5"), "Samsung Galaxy Z Flip5");
  assert.equal(gsmaModelName("OnePlus", "OnePlus 12"), "OnePlus 12");
  assert.equal(gsmaModelName(null, "Apple Iphone Air"), "Apple iPhone Air");
  assert.equal(gsmaModelName("Apple", "  iPhone   16e  "), "Apple iPhone 16e");
  assert.equal(gsmaModelName("Apple", "iPhone 16 (A3081) extra"), "Apple iPhone 16 (A3081) extra", "only a TRAILING code is Apple's");
  for (const m of [null, undefined, "", "   ", " (A3257)"]) assert.equal(gsmaModelName("Apple", m), null, String(m));
  // Mapped by the same explicit rules as a TAC name.
  assert.equal(modelOf(gsmaModelName("Apple", "Apple iPhone 17 Pro Max (A3257)")!), "iphone-17-pro-max");
  assert.equal(modelOf(gsmaModelName("Apple", "iPhone 16e (A3212)")!), "iphone-16e");
});

test("SUP-258: imeiModelNow — a kept answer read against TODAY's list: listed, unlisted, ambiguous or none; a cached row re-maps for free", () => {
  assert.deepEqual(imeiModelNow({ modelId: "galaxy-s23-ultra", brand: "Samsung", model: "Galaxy S23 Ultra" }, MODELS), { kind: "listed", modelId: "galaxy-s23-ultra", label: "Samsung Galaxy S23 Ultra" });
  // SU-AND-00048's row, kept before the 17 Pro Max joined the list: no model id, GSMA's name with Apple's code.
  const kept = { modelId: null, brand: "Apple", model: "Apple iPhone 17 Pro Max (A3257)", source: "gsma", tacName: "Apple Iphone 17 Pro Max" };
  assert.deepEqual(imeiModelNow(kept, MODELS), { kind: "listed", modelId: "iphone-17-pro-max", label: "Apple iPhone 17 Pro Max" }, "re-mapped against today's list");
  const before = MODELS.filter((m) => m.id !== "iphone-17-pro-max");
  assert.deepEqual(imeiModelNow(kept, before), { kind: "unlisted", modelId: null, label: "Apple iPhone 17 Pro Max", from: "lookup" }, "the list without it: a phone SwapUp doesn't list");
  assert.deepEqual(imeiModelNow({ modelId: null, brand: "Apple", model: "iPhone 13 Mini", source: "tac", tacName: "Apple Iphone 13 Mini" }, MODELS), { kind: "unlisted", modelId: null, label: "Apple iPhone 13 Mini", from: "tac" });
  // GSMA's codename beside a TAC name that maps: the TAC name names it (a codename names no phone).
  assert.equal(imeiModelNow({ modelId: null, brand: "Samsung", model: "DM3", source: "gsma", tacName: "Samsung Galaxy S23 Ultra" }, MODELS).modelId, "galaxy-s23-ultra");
  // A model id no longer on the list falls back to the name.
  assert.equal(imeiModelNow({ modelId: "gone-model", brand: "Apple", model: "iPhone 13", source: "gsma" }, MODELS).modelId, "iphone-13");
  assert.deepEqual(imeiModelNow({ modelId: null, brand: "Samsung", model: "Galaxy A14", tacName: "Samsung Galaxy A14" }, MODELS), { kind: "ambiguous", modelId: null, label: "Samsung Galaxy A14" });
  assert.deepEqual(imeiModelNow({ modelId: null, brand: null, model: null, tacName: null }, MODELS), { kind: "none", modelId: null, label: null });
  assert.deepEqual(imeiModelNow(null, MODELS), { kind: "none", modelId: null, label: null });
});

/* ─────────────────────────── review 0.9.4: names that name no phone, and which source decides ─────────────────────────── */

test("review 0.9.4: a brand alone or a series names NO model — never 'not on SwapUp's list' (21k TACs say only \"Samsung\", \"Apple\"…)", () => {
  for (const name of ["Samsung", "Apple", "Nokia", "Huawei", "Lg", "Motorola", "Oppo", "Vivo", "Google", "Xiaomi", "Pm-1414-Bv", "Samsung Galaxy", "Oppo Reno", "Xiaomi Redmi", "Xiaomi Redmi Note", "Oneplus Nord"]) {
    assert.ok(NAMES.includes(name), `"${name}" is on the TAC list`);
    assert.equal(modelForTacName(name, MODELS).kind, "none", name);
    assert.ok(namesNoModel(name), name);
  }
  assert.ok(!namesNoModel("Apple Iphone 13 Mini") && !namesNoModel("Samsung Galaxy S23") && !namesNoModel("Apple Iphone Air"));
  // An IMEI on a bare "Samsung" TAC (5,703 of them sit in the S23–S26, Z and A-series blocks): no model, kind none.
  const bare = tacModel(imeiFor("Samsung"), DB, MODELS);
  assert.deepEqual([bare.name, bare.modelId, bare.kind], ["Samsung", null, "none"]);
  assert.deepEqual(imeiModelNow({ modelId: null, brand: "Samsung", model: "Samsung", source: "tac", tacName: "Samsung" }, MODELS), { kind: "none", modelId: null, label: null });
  // GradeIQ's own TAC fallback answers the same name with source "tac": not a lookup, still nothing.
  assert.deepEqual(imeiModelNow({ modelId: null, brand: "Apple", model: "Apple", source: "tac", tacName: "Apple" }, MODELS), { kind: "none", modelId: null, label: null });
});

test("review 0.9.4: every series name on the TAC list (no digit, the start of a model's name on file) is in the reviewed TAC_SERIES table", () => {
  const keys = MODELS.map(catalogueKey);
  const series = NAMES.filter((n) => n.includes(" ") && !/\d/.test(n) && keys.some((k) => k.startsWith(`${tacKey(n)} `)));
  assert.deepEqual(series.map(tacKey).sort(), [...TAC_SERIES].sort());
});

test("review 0.9.4: a plain name whose 5G phone is on the list (A15, A16, A17) and 'Galaxy S26 Pro' are AMBIGUOUS — never 'unlisted'", () => {
  for (const name of ["Samsung Galaxy A15", "Samsung Galaxy A16", "Samsung Galaxy A17", "Samsung Galaxy S26 Pro"]) {
    assert.ok(NAMES.includes(name), name);
    const r = modelForTacName(name, MODELS);
    assert.deepEqual([r.modelId, r.kind], [null, "ambiguous"], name);
    assert.equal(imeiModelNow({ modelId: null, source: "tac", tacName: name }, MODELS).kind, "ambiguous", name);
  }
  // The reviewed table's 5G-only phones still map; a name with no 5G/4G phone on file is still unlisted.
  assert.equal(modelOf("Samsung Galaxy A34"), "galaxy-a34-5g");
  assert.equal(modelForTacName("Apple Iphone 13 Mini", MODELS).kind, "unlisted");
});

test("review 0.9.4: GSMA's own name (a REAL lookup) wins over the type code; GSMA naming an unlisted phone against a listed type code is ambiguous; a stub's or GradeIQ's TAC answer is never read as GSMA's", () => {
  // Finding: TAC 35976028 is "Apple Iphone 15 Pro" on the offline list; GSMA (Phonecheck) says the 15 Pro Max.
  const proMax = { modelId: null, brand: "Apple", model: "Apple iPhone 15 Pro Max (A3106)", source: "gsma", tacName: "Apple Iphone 15 Pro" };
  assert.deepEqual(imeiModelNow(proMax, MODELS), { kind: "listed", modelId: "iphone-15-pro-max", label: "Apple iPhone 15 Pro Max" });
  assert.deepEqual(imeiSourcesDisagree(proMax, MODELS), { gsma: "Apple iPhone 15 Pro Max", tac: "Apple iPhone 15 Pro" });
  assert.equal(imeiModelNow({ ...proMax, gsmaName: "Apple iPhone 15 Pro Max" }, MODELS).modelId, "iphone-15-pro-max", "the record's own gsmaName");
  // GSMA names a phone not on the list, the type code one that is: both are said, neither is used.
  const mini = { modelId: null, gsmaName: "Apple iPhone 13 Mini", tacName: "Apple Iphone 13" };
  assert.deepEqual(imeiModelNow(mini, MODELS), { kind: "ambiguous", modelId: null, label: "Apple iPhone 13 Mini" });
  assert.deepEqual(imeiSourcesDisagree(mini, MODELS), { gsma: "Apple iPhone 13 Mini", tac: "Apple iPhone 13" });
  // GSMA and the type code agree: nothing to say.
  assert.equal(imeiSourcesDisagree({ gsmaName: "Apple iPhone 13", tacName: "Apple Iphone 13" }, MODELS), null);
  // GradeIQ's illustrative seed (source "stub") and its offline list (source "tac") are not GSMA: their names are never mapped as one.
  assert.deepEqual(imeiModelNow({ modelId: null, brand: "Samsung", model: "Galaxy S21 5G", source: "stub", tacName: null }, MODELS), { kind: "none", modelId: null, label: null });
  assert.equal(imeiModelNow({ modelId: null, brand: "OnePlus", model: "11 5G", source: "stub", tacName: null }, MODELS).modelId, null);
  assert.equal(gsmaLookupName("Samsung", "Galaxy S21 5G", "stub"), null);
  assert.equal(gsmaLookupName("Samsung", "Galaxy S21 5G", "tac"), null);
  assert.equal(gsmaLookupName("Samsung", "Galaxy S21 5G", "gsma"), "Samsung Galaxy S21 5G");
  assert.equal(gsmaLookupName("Apple", "Apple iPhone 17 Pro Max (A3257)", "station"), "Apple iPhone 17 Pro Max");
  // A codename names no phone: the type code decides.
  assert.equal(gsmaLookupName("Samsung", "DM3", "gsma"), null);
  assert.equal(gsmaLookupName("Samsung", "B5Q", "gsma"), null);
  assert.equal(gsmaLookupName("Nokia", "3310", "gsma"), "Nokia 3310", "digits alone are a model, not a codename");
});
