import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLine, storageOf, suggestUpgrade, UPGRADE_RULE_VERSION, type CatalogueRow } from "./upgrade.ts";

/* ─────────────────────────── the seed, as newDevices() returns it ─────────────────────────── */

type SeedDevice = Omit<CatalogueRow, "id"> & { sort: number };
type SeedModel = { id: string; brand: string; model: string; series: string | null; variants: string[] };
const SEED = JSON.parse(readFileSync(new URL("../server/seed-data.json", import.meta.url), "utf8")) as { newDevices: SeedDevice[]; tradeModels: SeedModel[] };

/** Active rows in newDevices() order (sort, series, price DESC), each with an id. */
const CATALOGUE: CatalogueRow[] = [...SEED.newDevices]
  .sort((a, b) => a.sort - b.sort || a.series.localeCompare(b.series) || b.price - a.price)
  .map((d) => ({ id: `${d.model} ${d.variant}`, brand: d.brand, model: d.model, series: d.series, variant: d.variant, price: d.price, supportEndYear: d.supportEndYear }));

function tradeModel(model: string): SeedModel {
  const tm = SEED.tradeModels.find((t) => t.model === model);
  assert.ok(tm, `${model} is in the seed`);
  return tm;
}

function suggest(model: string, variant: string | null, catalogue = CATALOGUE) {
  const tm = tradeModel(model);
  return suggestUpgrade({ brand: tm.brand, model: tm.model, series: tm.series, variant }, catalogue);
}

/* ─────────────────────────── the line ─────────────────────────── */

test("line: every way Samsung names a phone", () => {
  assert.deepEqual(parseLine("Galaxy S23 Ultra", "S"), { series: "S", family: "", tier: "", gen: 23, suffix: "Ultra" });
  assert.deepEqual(parseLine("Galaxy S23+", "S"), { series: "S", family: "", tier: "", gen: 23, suffix: "+" });
  assert.deepEqual(parseLine("Galaxy S23 FE", "S"), { series: "S", family: "", tier: "", gen: 23, suffix: "FE" });
  assert.deepEqual(parseLine("Galaxy S25 Edge", "S"), { series: "S", family: "", tier: "", gen: 25, suffix: "Edge" });
  assert.deepEqual(parseLine("Galaxy Z Flip5", "Z"), { series: "Z", family: "Flip", tier: "", gen: 5, suffix: "" });
  assert.deepEqual(parseLine("Galaxy Z Flip7 FE", "Z"), { series: "Z", family: "Flip", tier: "", gen: 7, suffix: "FE" });
  assert.deepEqual(parseLine("Galaxy Z Fold8 Ultra", "Z"), { series: "Z", family: "Fold", tier: "", gen: 8, suffix: "Ultra" });
  assert.deepEqual(parseLine("Galaxy A54 5G", "A"), { series: "A", family: "", tier: "5", gen: 4, suffix: "" });
  assert.deepEqual(parseLine("Galaxy A07", "A"), { series: "A", family: "", tier: "0", gen: 7, suffix: "" });
  assert.deepEqual(parseLine("Galaxy M17e 5G", "M"), { series: "M", family: "", tier: "1", gen: 7, suffix: "e" });
  assert.deepEqual(parseLine("Galaxy M55s 5G", "M"), { series: "M", family: "", tier: "5", gen: 5, suffix: "s" });
  assert.deepEqual(parseLine("Galaxy F70 Pro 5G", "F"), { series: "F", family: "", tier: "7", gen: 0, suffix: "Pro" });
  assert.deepEqual(parseLine("Galaxy M21 2021 Edition", "M"), { series: "M", family: "", tier: "2", gen: 1, suffix: "" });
  assert.deepEqual(parseLine("Galaxy A08 LTE", "A"), { series: "A", family: "", tier: "0", gen: 8, suffix: "" });
  assert.equal(parseLine("iPhone 13", null), null, "not a Samsung line");
  assert.equal(parseLine("iPhone 13", "S"), null);
  assert.equal(parseLine("Galaxy S23", "A"), null, "the letter must be the series it is filed under");
  assert.equal(parseLine("Galaxy Z Flip5", "S"), null);
});

test("line: all the seed's Samsung trade models and catalogue rows can be placed", () => {
  const samsung = SEED.tradeModels.filter((t) => t.brand === "Samsung");
  assert.equal(samsung.length, 115);
  assert.deepEqual(samsung.filter((t) => !parseLine(t.model, t.series)).map((t) => t.model), []);
  assert.deepEqual(CATALOGUE.filter((r) => !parseLine(r.model, r.series)).map((r) => r.model), []);
  assert.deepEqual(SEED.tradeModels.filter((t) => t.brand !== "Samsung" && parseLine(t.model, t.series)).map((t) => t.model), [], "no other brand is placed");
});

test("storage: the size after the RAM, nothing guessed", () => {
  assert.equal(storageOf("8GB+256GB"), "256GB");
  assert.equal(storageOf("256GB"), "256GB");
  assert.equal(storageOf("1TB"), "1TB");
  assert.equal(storageOf("junk"), null);
  assert.equal(storageOf("8/128"), null);
});

/* ─────────────────────────── the suggestion, on the seed ─────────────────────────── */

const TABLE: [model: string, variant: string | null, deviceId: string, price: number, level: string][] = [
  ["Galaxy S23 Ultra", "256GB", "Galaxy S26 Ultra 256GB", 154999, "line"],
  ["Galaxy S23 Ultra", "512GB", "Galaxy S26 Ultra 512GB", 174999, "line"],
  ["Galaxy S23 Ultra", "1TB", "Galaxy S26 Ultra 512GB", 174999, "line"],
  ["Galaxy S23 Ultra", null, "Galaxy S26 Ultra 256GB", 154999, "line"],
  ["Galaxy S23", "128GB", "Galaxy S26 256GB", 102999, "line"],
  ["Galaxy S23+", "256GB", "Galaxy S26+ 256GB", 134999, "line"],
  ["Galaxy S23 FE", "128GB", "Galaxy S26 FE 256GB", 79999, "line"],
  ["Galaxy S21 FE", "128GB", "Galaxy S26 FE 256GB", 79999, "line"],
  ["Galaxy S25 Edge", "256GB", "Galaxy S26 256GB", 102999, "family"],
  ["Galaxy Z Flip5", "256GB", "Galaxy Z Flip8 256GB", 124999, "line"],
  ["Galaxy Z Fold5", "512GB", "Galaxy Z Fold8 512GB", 199999, "line"],
  ["Galaxy Z Flip7 FE", "256GB", "Galaxy Z Flip7 FE 256GB", 95999, "line"],
  ["Galaxy A54 5G", "128GB", "Galaxy A57 5G 8GB+256GB", 62999, "line"],
  ["Galaxy A14 5G", "64GB", "Galaxy A17 5G 6GB+128GB", 27999, "line"],
  ["Galaxy M14 5G", "128GB", "Galaxy M17 5G 4GB+128GB", 19999, "line"],
  ["Galaxy M55s 5G", "128GB", "Galaxy M47 5G 6GB+128GB", 37999, "nearby"],
  ["Galaxy M21 2021 Edition", "64GB", "Galaxy M17e 5G 4GB+128GB", 18499, "nearby"],
  ["Galaxy F54 5G", "128GB", "Galaxy F70e 5G 4GB+128GB", 18499, "nearby"],
  ["Galaxy F02s", "64GB", "Galaxy F08 LTE 4GB+64GB", 16999, "family"],
];

test("suggestion: every row of the spec's table, on the seeded catalogue", () => {
  for (const [model, variant, deviceId, price, level] of TABLE) {
    const s = suggest(model, variant);
    const label = `${model} ${variant ?? "storage unknown"}`;
    assert.ok(s, label);
    assert.equal(s.deviceId, deviceId, label);
    assert.equal(s.level, level, label);
    assert.equal(CATALOGUE.find((r) => r.id === s.deviceId)?.price, price, label);
    assert.match(s.why, /^[A-Z].*\.$/, `${label}: one plain sentence`);
  }
});

test("suggestion: the Fold5 gets the Fold8, not the Fold8 Ultra", () => {
  assert.notEqual(suggest("Galaxy Z Fold5", "512GB")?.deviceId, "Galaxy Z Fold8 Ultra 512GB");
});

test("suggestion: never across brands, never from an empty catalogue", () => {
  assert.equal(suggest("iPhone 13", "128GB"), null, "an iPhone at a Samsung centre: the advisor chooses");
  assert.equal(suggestUpgrade({ brand: "Apple", model: "iPhone 13", series: null, variant: null }, CATALOGUE), null);
  for (const [model, variant] of TABLE) assert.equal(suggest(model, variant, []), null, `${model}: empty catalogue`);
  // A Samsung line in another brand's catalogue is not a match.
  const other = CATALOGUE.map((r) => ({ ...r, brand: "Acme" }));
  assert.equal(suggest("Galaxy S23 Ultra", "256GB", other), null);
  // Brand matches regardless of case.
  assert.equal(suggest("Galaxy S23 Ultra", "256GB", CATALOGUE.map((r) => ({ ...r, brand: "SAMSUNG" })))?.deviceId, "Galaxy S26 Ultra 256GB");
});

test("suggestion: it never reads the bonus or the margin — only the catalogue's own columns", () => {
  // Same answer however the rows are decorated: the rule has nothing else to read.
  const decorated = CATALOGUE.map((r) => ({ ...r, bonusBp: 500, margin: 99999, campaign: "x" }));
  for (const [model, variant] of TABLE) assert.deepEqual(suggest(model, variant, decorated), suggest(model, variant), model);
});

/* ─────────────────────────── tie-breaks ─────────────────────────── */

const row = (id: string, model: string, variant: string, price: number, supportEndYear: number | null = 2033): CatalogueRow => ({
  id,
  brand: "Samsung",
  model,
  series: model.replace(/^Galaxy\s+/, "")[0],
  variant,
  price,
  supportEndYear,
});
const S23U = { brand: "Samsung", model: "Galaxy S23 Ultra", series: "S", variant: "256GB" };

test("tie-break: the same phone at two prices — the cheaper wins", () => {
  const cat = [row("dear", "Galaxy S26 Ultra", "256GB", 159999), row("cheap", "Galaxy S26 Ultra", "256GB", 154999)];
  assert.equal(suggestUpgrade(S23U, cat)?.deviceId, "cheap");
});

test("tie-break: the same price — catalogue order wins", () => {
  const cat = [row("first", "Galaxy S26 Ultra", "256GB", 154999), row("second", "Galaxy S26 Ultra", "256GB", 154999)];
  assert.equal(suggestUpgrade(S23U, cat)?.deviceId, "first");
  assert.equal(suggestUpgrade(S23U, [...cat].reverse())?.deviceId, "second");
});

test("ranking: newest first (support end, then generation), unknown support last", () => {
  const cat = [row("s25u", "Galaxy S25 Ultra", "256GB", 114999, 2032), row("s26u", "Galaxy S26 Ultra", "256GB", 154999, 2033), row("s27u", "Galaxy S27 Ultra", "256GB", 99999, null)];
  assert.equal(suggestUpgrade(S23U, cat)?.deviceId, "s26u");
  const sameYear = [row("s25u", "Galaxy S25 Ultra", "256GB", 114999, 2033), row("s26u", "Galaxy S26 Ultra", "256GB", 154999, 2033)];
  assert.equal(suggestUpgrade(S23U, sameYear)?.deviceId, "s26u", "the same support year → the later generation");
});

test("ranking: storage — the same size, else the next up, else the largest down; unknown → cheapest", () => {
  const cat = [row("128", "Galaxy S26 Ultra", "128GB", 140000), row("512", "Galaxy S26 Ultra", "512GB", 174999), row("1t", "Galaxy S26 Ultra", "1TB", 199999)];
  assert.equal(suggestUpgrade({ ...S23U, variant: "256GB" }, cat)?.deviceId, "512", "no 256GB → the smallest larger size");
  assert.equal(suggestUpgrade({ ...S23U, variant: "128GB" }, cat)?.deviceId, "128");
  assert.equal(suggestUpgrade({ ...S23U, variant: "2TB" }, cat)?.deviceId, "1t", "nothing larger → the largest smaller size");
  assert.equal(suggestUpgrade({ ...S23U, variant: null }, cat)?.deviceId, "128", "storage unknown → the cheapest");
});

test("ranking: within a family, a plain model before an FE, Ultra or +", () => {
  const edge = { brand: "Samsung", model: "Galaxy S25 Edge", series: "S", variant: "256GB" };
  const cat = [row("ultra", "Galaxy S26 Ultra", "256GB", 154999), row("fe", "Galaxy S26 FE", "256GB", 79999), row("plain", "Galaxy S26", "256GB", 102999)];
  assert.deepEqual(
    (({ deviceId, level }) => ({ deviceId, level }))(suggestUpgrade(edge, cat)!),
    { deviceId: "plain", level: "family" }
  );
});

test("nearby: A/M/F only, the nearest tier, a tie goes to the higher tier", () => {
  const a44 = { brand: "Samsung", model: "Galaxy A44", series: "A", variant: "128GB" };
  const cat = [row("a26", "Galaxy A26 5G", "8GB+128GB", 25000, 2032), row("a66", "Galaxy A66 5G", "8GB+128GB", 45000, 2032), row("a07", "Galaxy A07", "4GB+128GB", 13499, 2032)];
  const s = suggestUpgrade(a44, cat);
  assert.equal(s?.deviceId, "a66");
  assert.equal(s?.level, "nearby");
  // S and Z never go "nearby": with no S Ultra and no S at all, nothing in the series → null.
  assert.equal(suggestUpgrade(S23U, [row("flip", "Galaxy Z Flip8", "256GB", 124999)]), null);
});

test("series: the last resort, same series", () => {
  const fold = { brand: "Samsung", model: "Galaxy Z Fold5", series: "Z", variant: "512GB" };
  const s = suggestUpgrade(fold, [row("flip", "Galaxy Z Flip8", "512GB", 144999), row("s26", "Galaxy S26", "512GB", 122999)]);
  assert.equal(s?.deviceId, "flip");
  assert.equal(s?.level, "series");
});

test("the rule has a version for the audit", () => {
  assert.match(UPGRADE_RULE_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});
