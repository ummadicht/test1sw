/**
 * The PriceIQ client (lib/server/priceiq.ts) against a stand-in PriceIQ on 127.0.0.1
 * (testing/fakePriceiq.ts) — the dev server can't reach the VM's — and migration 15, which
 * turns market_listings into PriceIQ's cache and deletes the old snapshot rows.
 *
 * Contract v1 §2–3: bearer key from the server env, 6 s timeout, an answer fresh for an hour,
 * quotes wait for the refresh and page views don't, a 404 cached for an hour too, PriceIQ down →
 * the last good answer labelled, no key → no price, never a made-up one.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/*.test.ts
 */
import "./testing/register.mjs";
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync as Database } from "node:sqlite";
import { startFakePriceiq, S23U_256, type FakePriceiq } from "./testing/fakePriceiq.ts";

const dir = mkdtempSync(join(tmpdir(), "swapup-priceiq-"));
const DB_FILE = join(dir, "test.db");
process.env.SWAPUP_DB = DB_FILE;
process.env.GRADEIQ_ENABLED = "0";
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_")) delete process.env[k];

const { SQLITE_SCHEMA, MIGRATIONS } = await import("./db.ts");

/* ── a database as an older SwapUp left it: schema 14, the bundled snapshot imported, the sample card on file ── */
{
  const old = new Database(DB_FILE);
  old.exec(SQLITE_SCHEMA);
  old.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '14')`).run();
  old.prepare(`INSERT INTO meta (key, value) VALUES ('priceiq_vendor_sell', '{"file":"x.csv"}')`).run();
  old.prepare(`INSERT INTO meta (key, value) VALUES ('priceiq_keep_me', 'unrelated')`).run();
  const ins = old.prepare(`INSERT INTO market_listings (source, model_id, variant, grade, price, week, listed_as) VALUES (?,?,?,?,?,?,?)`);
  ins.run("priceiq:vendor_in_sell", "galaxy-s23-ultra", "256GB", "Superb", 57_099, "2026-W35", "Samsung Galaxy S23 Ultra 256GB");
  ins.run("priceiq:vendor_in_sell", "galaxy-s23-ultra", "256GB", "Good", 51_399, "2026-W35", "Samsung Galaxy S23 Ultra 256GB");
  old.prepare(`INSERT INTO orgs (id, name, kind, settings, created_at) VALUES ('ptn_x', 'Partner X', 'partner', '{}', '2026-10-01')`).run();
  const card = (id: string, kind: string) =>
    old.prepare(`INSERT INTO rate_cards (id, partner_id, data, active, created_at) VALUES (?, 'ptn_x', ?, 1, '2026-10-01')`).run(id, JSON.stringify({ source: { kind, label: id, effectiveFrom: "2026-10-01" } }));
  card("rc_illustrative", "sample");
  card("rc_partner", "partner_ratecard");
  const tm = old.prepare(`INSERT INTO trade_models (id, brand, model, variants, source) VALUES (?, ?, ?, '["128GB"]', ?)`);
  tm.run("pixel-7", "Google", "Pixel 7", JSON.stringify({ kind: "sample", label: "Release year approximate" }));
  tm.run("galaxy-s23", "Samsung", "Galaxy S23", JSON.stringify({ kind: "oem_public", label: "Samsung" }));
  old.close();
}

const origWarn = console.warn;
const warnings: string[] = [];
console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));

const { db } = await import("./db.ts");
const priceiq = await import("./priceiq.ts");
const { freshMarket, cachedMarket, priceiqConfig, readCache, resetPriceiqState, NOT_CONNECTED, PRICEIQ_FRESH_MS } = priceiq;
const { marketSell } = await import("../domain/marketSell.ts");

let fake: FakePriceiq;
before(async () => {
  fake = await startFakePriceiq({ "Galaxy S23 Ultra|256": S23U_256, "Galaxy S23 Ultra|512": { grades: [{ grade: "Good", low: 58_599 }], ageDays: 3 }, "Galaxy Z Fold6|256": { grades: [] } });
});
after(async () => {
  console.warn = origWarn;
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

const S23U = { modelId: "galaxy-s23-ultra", variant: "256GB", brand: "Samsung", model: "Galaxy S23 Ultra" };
const connect = () => Object.assign(process.env, { PRICEIQ_BASE_URL: fake.url, PRICEIQ_API_KEY: fake.key });
const disconnect = () => {
  delete process.env.PRICEIQ_BASE_URL;
  delete process.env.PRICEIQ_API_KEY;
};
const clear = () => {
  db().prepare(`DELETE FROM market_listings`).run();
  resetPriceiqState();
  fake.calls.length = 0;
  fake.mode = "ok";
  warnings.length = 0;
};
const ageCache = (ms: number) => db().prepare(`UPDATE market_listings SET fetched_at = ?`).run(new Date(Date.now() - ms).toISOString());

test("migration 15: market_listings becomes the cache — the old snapshot rows and their import record go; sample data goes; nothing else is touched", () => {
  const cols = (db().prepare(`PRAGMA table_info(market_listings)`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(["fetched_at", "observed_at", "points"].every((c) => cols.includes(c)), cols.join());
  assert.equal((db().prepare(`SELECT COUNT(*) n FROM market_listings`).get() as { n: number }).n, 0, "the snapshot's rows are deleted");
  assert.equal(db().prepare(`SELECT 1 FROM meta WHERE key = 'priceiq_vendor_sell'`).get(), undefined, "its import record too");
  assert.ok(db().prepare(`SELECT 1 FROM meta WHERE key = 'priceiq_keep_me'`).get(), "an unrelated meta row stays");
  assert.deepEqual((db().prepare(`SELECT id FROM rate_cards ORDER BY id`).all() as { id: string }[]).map((r) => r.id), ["rc_partner"], "only the partner's own card stays");
  const kinds = Object.fromEntries((db().prepare(`SELECT id, json_extract(source, '$.kind') k FROM trade_models`).all() as { id: string; k: string }[]).map((r) => [r.id, r.k]));
  assert.deepEqual(kinds, { "pixel-7": "approximate", "galaxy-s23": "oem_public" });
  assert.equal((db().prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value, String(MIGRATIONS.length));
});

test("the snapshot file is gone and nothing reads one", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  assert.equal(existsSync(join(root, "lib/server/priceiq")), false);
  const src = readFileSync(join(root, "lib/server/priceiq.ts"), "utf8") + readFileSync(join(root, "lib/server/marketPrices.ts"), "utf8");
  assert.doesNotMatch(src, /readFileSync|\.csv|_SELL_CSV/);
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  assert.deepEqual(walk(join(root, "lib")).filter((f) => f.endsWith(".csv")), []);
});

test("config: no key or no address → no price, never a guess; the key only to 127.0.0.1 or over https", () => {
  disconnect();
  assert.deepEqual(priceiqConfig(), { ok: false, why: NOT_CONNECTED });
  assert.equal(NOT_CONNECTED, "No refurbished market price yet — PriceIQ isn't connected.");
  assert.equal(priceiqConfig({ PRICEIQ_BASE_URL: "http://127.0.0.1:4301/apps/priceiq" }).ok, false, "no key");
  assert.equal(priceiqConfig({ PRICEIQ_BASE_URL: "http://127.0.0.1:4301/apps/priceiq/", PRICEIQ_API_KEY: "k" }).ok, true);
  assert.equal(priceiqConfig({ PRICEIQ_BASE_URL: "http://localhost:4301/apps/priceiq", PRICEIQ_API_KEY: "k" }).ok, true);
  assert.equal(priceiqConfig({ PRICEIQ_BASE_URL: "https://thesuperiq.com/apps/priceiq", PRICEIQ_API_KEY: "k" }).ok, true);
  assert.equal(priceiqConfig({ PRICEIQ_BASE_URL: "http://thesuperiq.com/apps/priceiq", PRICEIQ_API_KEY: "k" }).ok, false, "never a key in the clear");
  assert.equal(priceiqConfig({ PRICEIQ_BASE_URL: "not a url", PRICEIQ_API_KEY: "k" }).ok, false);
});

test("no key: no request is made and there is no price — even with an answer on file", async () => {
  clear();
  connect();
  await freshMarket(S23U);
  assert.equal(fake.calls.length, 1);
  disconnect();
  const r = await freshMarket(S23U);
  assert.deepEqual(r, { answer: null, why: NOT_CONNECTED });
  assert.deepEqual(cachedMarket(S23U), { answer: null, why: NOT_CONNECTED });
  assert.equal(fake.calls.length, 1);
});

test("a quote asks PriceIQ: the bearer key, the brand-less model, storage in GB, India — and keeps only the grades' lowest listings", async () => {
  clear();
  connect();
  const r = await freshMarket(S23U);
  assert.equal(fake.calls.length, 1);
  const c = fake.calls[0];
  assert.equal(c.path, "/apps/priceiq/api/market-grades");
  assert.deepEqual(c.query, { brand: "Samsung", model: "Galaxy S23 Ultra", storageGb: "256", market: "IN" });
  assert.equal(c.keyOk, true);
  assert.ok(r.answer);
  assert.deepEqual(
    r.answer!.rows.map((x) => [x.grade, x.price, x.points]),
    [
      ["Superb", 53_499, 2],
      ["Good", 51_399, 2],
      ["Fair", 49_399, 2],
      ["Best Value", 47_199, 1],
    ]
  );
  assert.equal(r.answer!.unreachable, false);
  assert.match(r.answer!.week ?? "", /^\d{4}-W\d{2}$/);
  // Kept across restarts, in market_listings — and nothing PriceIQ might add beside the prices.
  const rows = db().prepare(`SELECT * FROM market_listings`).all() as Record<string, unknown>[];
  assert.equal(rows.length, 4);
  assert.ok(rows.every((x) => x.source === "priceiq" && x.fetched_at && x.observed_at && x.listed_as === "Samsung Galaxy S23 Ultra 256GB"));
  assert.doesNotMatch(JSON.stringify(rows), /some_partner_feed|Some Partner/);
  assert.deepEqual(readCache("galaxy-s23-ultra", "256GB")?.rows.length, 4);
  // The contract's acceptance check: a flawless S23 Ultra 256GB is priced from ₹53,499 (Superb).
  const s = marketSell({ answer: r.answer, condition: { screen: "flawless", body: "flawless" }, label: "Galaxy S23 Ultra 256GB", asOf: new Date().toISOString() });
  assert.equal(s.why === null && s.listing, 53_499);
});

test("fresh for an hour: no second ask inside it; the next request after it asks again", async () => {
  clear();
  connect();
  await freshMarket(S23U);
  await freshMarket(S23U);
  cachedMarket(S23U);
  assert.equal(fake.calls.length, 1, "within the hour, the kept answer");
  ageCache(PRICEIQ_FRESH_MS + 60_000);
  await freshMarket(S23U);
  assert.equal(fake.calls.length, 2, "over an hour old: asked again, and waited for");
  const fetched = Date.parse(readCache("galaxy-s23-ultra", "256GB")!.fetchedAt);
  assert.ok(Date.now() - fetched < 60_000, "the new answer replaced the old");
});

test("a page view never waits: it reads what is kept and refreshes it in the background", async () => {
  clear();
  connect();
  const first = cachedMarket(S23U);
  assert.equal(first.answer, null, "nothing kept yet — no price on this view, never a guess");
  assert.equal(first.why, "No refurbished market price yet.");
  for (let i = 0; i < 50 && !readCache("galaxy-s23-ultra", "256GB"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.calls.length, 1);
  assert.equal(cachedMarket(S23U).answer?.rows.length, 4, "the next view has it");
});

test("concurrent asks for one phone share one request", async () => {
  clear();
  connect();
  await Promise.all([freshMarket(S23U), freshMarket(S23U), freshMarket(S23U)]);
  assert.equal(fake.calls.length, 1);
});

test("404 (no device / no price) is an answer: no price, kept for an hour like any other", async () => {
  clear();
  connect();
  for (const ask of [
    { modelId: "galaxy-z-fold6", variant: "256GB", brand: "Samsung", model: "Galaxy Z Fold6" }, // no-price
    { modelId: "galaxy-a14", variant: "128GB", brand: "Samsung", model: "Galaxy A14" }, // no-device
  ]) {
    const r = await freshMarket(ask);
    assert.ok(r.answer, "PriceIQ answered");
    assert.deepEqual(r.answer!.rows, []);
    const s = marketSell({ answer: r.answer, condition: { screen: "flawless", body: "flawless" }, label: `${ask.model} ${ask.variant}`, asOf: new Date().toISOString() });
    assert.equal(s.why, `PriceIQ has no refurbished market price for the ${ask.model} ${ask.variant}.`);
    await freshMarket(ask);
  }
  assert.equal(fake.calls.length, 2, "each 404 asked once in the hour");
});

test("PriceIQ down: the last good answer, labelled 'PriceIQ unreachable' — and the counter is not held while it stays down", async () => {
  clear();
  connect();
  await freshMarket(S23U);
  ageCache(PRICEIQ_FRESH_MS + 60_000);
  fake.mode = "down";
  const r = await freshMarket(S23U);
  assert.equal(fake.calls.length, 2);
  assert.equal(r.answer?.unreachable, true);
  assert.equal(r.answer?.rows.length, 4, "the last good answer");
  const s = marketSell({ answer: r.answer, condition: { screen: "flawless", body: "flawless" }, label: "Galaxy S23 Ultra 256GB", asOf: new Date().toISOString() });
  assert.ok(s.why === null && /PriceIQ unreachable, last answer \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.test(s.note ?? ""), JSON.stringify(s));
  // A minute's grace before the next ask: a page of storage chips doesn't wait once per size.
  await freshMarket(S23U);
  assert.equal(fake.calls.length, 2);
  assert.equal(cachedMarket(S23U).answer?.unreachable, true, "page views say it too");
  // Never answered at all and down: no price, with why.
  const fresh = await freshMarket({ modelId: "galaxy-s23-ultra", variant: "512GB", brand: "Samsung", model: "Galaxy S23 Ultra" });
  assert.equal(fresh.answer, null);
  assert.equal(fresh.why, "No refurbished market price yet — PriceIQ answered HTTP 503.");
});

test("a wrong key is refused, not cached; the server log gets its last 4 characters, nothing a screen shows gets any of it", async () => {
  clear();
  Object.assign(process.env, { PRICEIQ_BASE_URL: fake.url, PRICEIQ_API_KEY: "pk_live_wrong_key_SECRETPART_9z9z" });
  const r = await freshMarket(S23U);
  assert.equal(r.answer, null);
  assert.equal(fake.calls[0].keyOk, false);
  assert.equal((db().prepare(`SELECT COUNT(*) n FROM market_listings`).get() as { n: number }).n, 0, "nothing kept");
  assert.ok(warnings.some((w) => /refused SwapUp's key \(HTTP 401\) \(key …9z9z\)/.test(w)), warnings.join("\n"));
  assert.ok(!warnings.some((w) => w.includes("SECRETPART")), "the key itself is never logged");
  // `why` reaches cases.quote (priceiqWhy), the counter's trace and the customer's answer: plain words only.
  assert.equal(r.why, "No refurbished market price yet — PriceIQ refused SwapUp's key (HTTP 401).");
  assert.doesNotMatch(r.why ?? "", /9z9z|SECRETPART|pk_|…|key …/);
  assert.doesNotMatch(cachedMarket(S23U).why ?? "", /9z9z|SECRETPART|pk_|…/, "page views say the same");
  // …and with an answer on file, the unreachable label carries no key either.
  connect();
  resetPriceiqState();
  await freshMarket(S23U);
  ageCache(PRICEIQ_FRESH_MS + 60_000);
  Object.assign(process.env, { PRICEIQ_API_KEY: "pk_live_wrong_key_SECRETPART_9z9z" });
  const stale = await freshMarket(S23U);
  assert.equal(stale.answer?.unreachable, true);
  const s = marketSell({ answer: stale.answer, condition: { screen: "flawless", body: "flawless" }, label: "Galaxy S23 Ultra 256GB", asOf: new Date().toISOString() });
  assert.doesNotMatch(JSON.stringify(s), /9z9z|SECRETPART|pk_/);
});

test("a 404 that isn't PriceIQ's own (an HTML page: wrong base path, PriceIQ rolled back) is a failure — the last good answer stands, labelled, logged, backed off", async () => {
  clear();
  connect();
  await freshMarket(S23U);
  const kept = readCache("galaxy-s23-ultra", "256GB");
  assert.equal(kept?.rows.length, 4);
  ageCache(PRICEIQ_FRESH_MS + 60_000);
  fake.mode = "html404";
  const r = await freshMarket(S23U);
  assert.equal(fake.calls.length, 2, "asked");
  assert.equal(r.answer?.unreachable, true, "labelled unreachable");
  assert.equal(r.answer?.rows.length, 4, "the last good answer, not 'no price'");
  assert.equal(readCache("galaxy-s23-ultra", "256GB")?.rows.length, 4, "the cache is not overwritten");
  assert.equal((db().prepare(`SELECT COUNT(*) n FROM market_listings WHERE grade = ''`).get() as { n: number }).n, 0, "no 'none' marker written");
  const s = marketSell({ answer: r.answer, condition: { screen: "flawless", body: "flawless" }, label: "Galaxy S23 Ultra 256GB", asOf: new Date().toISOString() });
  assert.ok(s.why === null && s.listing === 53_499 && /PriceIQ unreachable, last answer/.test(s.note ?? ""), JSON.stringify(s));
  assert.ok(warnings.some((w) => /PriceIQ answered HTTP 404 without a price answer \(not PriceIQ's own 404 — check PRICEIQ_BASE_URL/.test(w)), warnings.join("\n"));
  await freshMarket(S23U);
  assert.equal(fake.calls.length, 2, "a minute's grace before asking again");
  // Never answered and only an HTML 404: no price, with why — never 'PriceIQ has no price for this phone'.
  const other = await freshMarket({ modelId: "galaxy-s23-ultra", variant: "512GB", brand: "Samsung", model: "Galaxy S23 Ultra" });
  assert.equal(other.answer, null);
  assert.equal(other.why, "No refurbished market price yet — PriceIQ answered HTTP 404 without a price answer.");
});

test("a wrong base path (PriceIQ's :4300 instance, JSON 404 with no reason) is a failure too, never 'no price'", async () => {
  clear();
  connect();
  await freshMarket(S23U);
  ageCache(PRICEIQ_FRESH_MS + 60_000);
  Object.assign(process.env, { PRICEIQ_BASE_URL: fake.url.replace(/\/apps\/priceiq$/, "/priceiq") });
  const r = await freshMarket(S23U);
  assert.equal(fake.calls.at(-1)?.path, "/priceiq/api/market-grades");
  assert.equal(r.answer?.unreachable, true);
  assert.equal(r.answer?.rows.length, 4);
  assert.equal(priceiq.isPriceiqNone(404, { error: "not found" }), false);
  assert.equal(priceiq.isPriceiqNone(404, null), false, "an HTML body");
  assert.equal(priceiq.isPriceiqNone(404, { error: "no refurbished market price", reason: "no-price" }), true);
  assert.equal(priceiq.isPriceiqNone(404, { error: "no refurbished market price", reason: "no-device" }), true);
  assert.equal(priceiq.isPriceiqNone(404, { reason: "something-else" }), false);
  assert.equal(priceiq.isPriceiqNone(409, { candidates: [] }), true);
  assert.equal(priceiq.isPriceiqNone(409, { error: "conflict" }), false);
  assert.equal(priceiq.isPriceiqNone(500, { reason: "no-price" }), false);
});

test("PriceIQ's own 409 (more than one model matched) is an answer: no price, cached like a 404", async () => {
  clear();
  connect();
  fake.candidates.set("Galaxy S24|256", ["Galaxy S24", "Galaxy S24 FE"]);
  try {
    const ask = { modelId: "galaxy-s24", variant: "256GB", brand: "Samsung", model: "Galaxy S24" };
    const r = await freshMarket(ask);
    assert.deepEqual(r.answer?.rows, []);
    assert.equal(r.answer?.unreachable, false);
    await freshMarket(ask);
    assert.equal(fake.calls.length, 1, "kept for the hour");
  } finally {
    fake.candidates.clear();
  }
});

test("an answer that isn't an India refurbished price is a failure, never a price", async () => {
  clear();
  connect();
  fake.mode = "garbage";
  const r = await freshMarket(S23U);
  assert.equal(r.answer, null);
  assert.equal((db().prepare(`SELECT COUNT(*) n FROM market_listings`).get() as { n: number }).n, 0);
  assert.equal(priceiq.readMarketGrades({ currency: "USD", week: "2026-W35", grades: [{ grade: "Good", lowMinor: 100_00 }] }), null);
  assert.equal(priceiq.readMarketGrades({ currency: "INR", week: "W35", grades: [{ grade: "Good", lowMinor: 100_00 }] }), null, "no readable week");
  const odd = priceiq.readMarketGrades({ currency: "INR", week: "2026-W35", grades: [{ grade: "Like New", lowMinor: 999_00 }, { grade: "Good", lowMinor: 5_139_950 }, { grade: "Fair", lowMinor: -1 }] });
  assert.deepEqual(odd?.rows, [{ grade: "Good", price: 51_399, week: "2026-W35" }], "unknown grade names and bad prices are dropped; paise round DOWN");
});

test("slow PriceIQ: the quote waits 6 seconds at most, then goes on with the last good answer", async () => {
  clear();
  connect();
  await freshMarket(S23U);
  ageCache(PRICEIQ_FRESH_MS + 60_000);
  fake.mode = "slow";
  fake.slowMs = 9_000;
  const t0 = Date.now();
  const r = await freshMarket(S23U);
  const took = Date.now() - t0;
  assert.ok(took >= 5_900 && took < 7_500, `waited ${took} ms`);
  assert.equal(r.answer?.unreachable, true);
  assert.ok(warnings.some((w) => /didn't answer within 6 s/.test(w)));
});
