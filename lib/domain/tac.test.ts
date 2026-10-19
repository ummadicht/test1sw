/**
 * The model from the IMEI (lib/domain/tac.ts) against the REAL offline TAC list (tacdb.json, the
 * copy of GradeIQ's) and SwapUp's real catalogue (lib/server/seed-data.json): every alias is a name
 * on the list and a model on file, 4G/5G siblings never collide, nothing is matched loosely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TAC_ALIASES, catalogueKey, modelForTacName, splitTacName, tacKey, tacLookup, tacModel, tacOf, type TacDb, type TacModelRef } from "./tac.ts";
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
  assert.equal(modelOf("Apple Iphone 13 Pro Max"), null, "not the 13 Pro");
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

test("coverage: 113 of the 139 models on file are reached by a TAC name (the rest are newer than the list, or ambiguous)", () => {
  const reached = new Set(NAMES.map(modelOf).filter(Boolean));
  assert.equal(reached.size, 113);
  for (const id of ["galaxy-z-fold8", "galaxy-s26-fe", "galaxy-m14-5g", "galaxy-m14", "galaxy-a22"]) assert.ok(!reached.has(id), id);
});

test("tacModel: IMEI → the list's name → the model, with the catalogue's own spelling; never a storage", () => {
  const m = tacModel(imeiFor("Samsung Galaxy S25 Fe"), DB, MODELS);
  assert.deepEqual(m, { tac: m.tac, name: "Samsung Galaxy S25 Fe", brand: "Samsung", model: "Galaxy S25 FE", modelId: "galaxy-s25-fe", why: "IMEI type code: Samsung Galaxy S25 Fe." });
  assert.ok(!("variant" in m));
  const pro = tacModel(imeiFor("Apple Iphone 13 Pro Max"), DB, MODELS);
  assert.deepEqual([pro.brand, pro.model, pro.modelId], ["Apple", "iPhone 13 Pro Max", null], "named, not on file");
  const unknown = tacModel("352099001761481", DB, MODELS);
  assert.deepEqual([unknown.tac, unknown.name, unknown.modelId], ["35209900", null, null]);
  assert.equal(tacModel("12", DB, MODELS).tac, null);
  assert.equal(tacLookup("12", DB), null);
});

test("catalogueKey: brand + model, without doubling a brand already in the name", () => {
  assert.equal(catalogueKey({ brand: "Samsung", model: "Galaxy S23" }), "samsung galaxy s23");
  assert.equal(catalogueKey({ brand: "OnePlus", model: "OnePlus 9" }), "oneplus 9");
  assert.equal(catalogueKey({ brand: "Google", model: "Pixel 7" }), "google pixel 7");
});
