import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gradeAfterRefurb,
  markdownBp,
  marketAgeDays,
  marketSell,
  marketUsable,
  priceiqModelName,
  sellFromListing,
  storageGb,
  weekAgeDays,
  MARKET_GRADES,
  type MarketAnswer,
} from "./marketSell.ts";

test("markdown: 5% on cheap phones down to 2% on dear ones, band edges inclusive", () => {
  assert.equal(markdownBp(9_999), 500);
  assert.equal(markdownBp(15_000), 500);
  assert.equal(markdownBp(15_001), 400);
  assert.equal(markdownBp(30_000), 400);
  assert.equal(markdownBp(30_001), 300);
  assert.equal(markdownBp(50_000), 300);
  assert.equal(markdownBp(50_001), 200);
  assert.equal(markdownBp(150_000), 200);
});

test("sell from a listing rounds DOWN — never promise a rupee more than the listing allows", () => {
  assert.deepEqual(sellFromListing(12_999), { amount: 12_349, markdownBp: 500, markdown: 650 }); // 12349.05
  assert.deepEqual(sellFromListing(54_799), { amount: 53_703, markdownBp: 200, markdown: 1_096 }); // 53703.02
  for (const p of [999, 15_000, 29_999, 49_999, 61_099]) {
    const s = sellFromListing(p);
    assert.ok(s.amount < p && s.amount + s.markdown === p);
  }
});

test("grade after refurb: what the refurb repairs comes out like new; what it doesn't keeps the grade down", () => {
  assert.equal(gradeAfterRefurb({ screen: "flawless", body: "flawless" }), "Superb");
  assert.equal(gradeAfterRefurb({ screen: "cracked", body: "flawless" }), "Superb");
  assert.equal(gradeAfterRefurb({ screen: "scratched", body: "flawless" }), "Good");
  assert.equal(gradeAfterRefurb({ screen: "flawless", body: "scuffed" }), "Good");
  assert.equal(gradeAfterRefurb({ screen: "flawless", body: "back_cracked" }), "Good");
  assert.equal(gradeAfterRefurb({ screen: "scratched", body: "dented" }), "Fair");
  assert.equal(gradeAfterRefurb({ screen: "not_working", body: "bent" }), "Best Value");
  assert.equal(gradeAfterRefurb(null), null);
  assert.deepEqual([...MARKET_GRADES], ["Superb", "Good", "Fair", "Best Value"]);
});

// PriceIQ's answer for the Galaxy S23 Ultra 256GB (contract §6 acceptance figures): the lowest listing per grade.
const ASOF = "2026-10-18T09:00:00.000Z";
const answer = (over: Partial<MarketAnswer> = {}): MarketAnswer => ({
  rows: [
    { grade: "Superb", price: 53_499, week: "2026-W35", points: 2 },
    { grade: "Good", price: 51_399, week: "2026-W35", points: 2 },
    { grade: "Best Value", price: 47_199, week: "2026-W35", points: 1 },
  ],
  week: "2026-W35",
  observedAt: "2026-10-10T06:57:05.000Z", // 8 days before ASOF: fresh
  fetchedAt: "2026-10-18T08:30:00.000Z",
  unreachable: false,
  ...over,
});

test("market sell: the LOWEST listing at the phone's grade, less the markdown", () => {
  const s = marketSell({ answer: answer(), condition: { screen: "flawless", body: "scuffed" }, label: "Galaxy S23 Ultra 256GB", asOf: ASOF });
  assert.equal(s.why, null);
  if (s.why !== null) return;
  assert.equal(s.grade, "Good");
  assert.equal(s.gradeWanted, "Good");
  assert.equal(s.listing, 51_399);
  assert.equal(s.listings, 2, "PriceIQ's count of distinct prices");
  assert.equal(s.markdownBp, 200);
  assert.equal(s.amount, 50_371);
  assert.equal(s.stale, false);
  assert.equal(s.note, null);
});

test("market sell: no listing at the grade → the next LOWER grade, named; never a higher one", () => {
  const s = marketSell({ answer: answer(), condition: { screen: "flawless", body: "dented" }, label: "Galaxy S23 Ultra 256GB", asOf: ASOF });
  assert.equal(s.why, null);
  if (s.why !== null) return;
  assert.equal(s.gradeWanted, "Fair");
  assert.equal(s.grade, "Best Value");
  assert.equal(s.listing, 47_199);

  const onlyBetter = marketSell({ answer: answer({ rows: [{ grade: "Superb", price: 53_499, week: "2026-W35" }] }), condition: { screen: "flawless", body: "dented" }, label: "X", asOf: ASOF });
  assert.equal(onlyBetter.amount, null);
  assert.equal(onlyBetter.why, 'The market lists the X only above "Fair".');
});

test("market sell: missing condition, no answer, or an empty answer say why instead of guessing", () => {
  assert.equal(marketSell({ answer: answer(), condition: null, label: "X", asOf: ASOF }).amount, null);
  const none = marketSell({ answer: answer({ rows: [], week: null, observedAt: null }), condition: { screen: "flawless", body: "flawless" }, label: "Galaxy S23 128GB", asOf: ASOF });
  assert.equal(none.amount, null);
  assert.equal(none.why, "PriceIQ has no refurbished market price for the Galaxy S23 128GB.");
  assert.equal(marketSell({ answer: null, condition: { screen: "flawless", body: "flawless" }, label: "X", asOf: ASOF }).why, "No refurbished market price yet.");
  assert.equal(
    marketSell({ answer: null, noAnswerWhy: "No refurbished market price yet — PriceIQ isn't connected.", condition: { screen: "flawless", body: "flawless" }, label: "X", asOf: ASOF }).why,
    "No refurbished market price yet — PriceIQ isn't connected."
  );
});

test("old data: over 14 days it is shown WITH its age; over 90 days it is no price; a grade off the ladder never prices", () => {
  const at52 = answer({ observedAt: "2026-08-27T06:57:05.000Z" }); // contract's example: 52 days old on 2026-10-18
  const u = marketUsable(at52, ASOF, "Galaxy S23 Ultra 256GB");
  assert.deepEqual(u, { ok: true, ageDays: 52, stale: true, note: "Refurbished market price, week 2026-W35, 52 days old." });
  const s = marketSell({ answer: at52, condition: { screen: "flawless", body: "flawless" }, label: "Galaxy S23 Ultra 256GB", asOf: ASOF });
  assert.equal(s.amount, 52_429, "still priced: 53,499 − 2%");
  if (s.why === null) assert.equal(s.note, "Refurbished market price, week 2026-W35, 52 days old.");

  // 14 days exactly is not stale; 15 is.
  assert.equal((marketUsable(answer({ observedAt: "2026-10-04T09:00:00.000Z" }), ASOF, "X") as { stale: boolean }).stale, false);
  assert.equal((marketUsable(answer({ observedAt: "2026-10-03T09:00:00.000Z" }), ASOF, "X") as { stale: boolean }).stale, true);
  // 90 days is still a price; 91 is none.
  assert.equal(marketUsable(answer({ observedAt: "2026-07-20T09:00:00.000Z" }), ASOF, "X").ok, true);
  const old = marketUsable(answer({ week: "2026-W29", observedAt: "2026-07-19T09:00:00.000Z" }), ASOF, "Galaxy S23 Ultra 256GB");
  assert.deepEqual(old, { ok: false, why: "PriceIQ's prices for the Galaxy S23 Ultra 256GB are from 2026-W29 (91 days old) — too old to price." });
  assert.equal(marketSell({ answer: answer({ observedAt: "2026-07-19T09:00:00.000Z" }), condition: { screen: "flawless", body: "flawless" }, label: "X", asOf: ASOF }).amount, null);

  // No date at all: not used.
  assert.equal(marketUsable(answer({ week: null, observedAt: null }), ASOF, "X").ok, false);
  // The week alone dates it when there is no observation time.
  assert.equal(marketAgeDays({ week: "2026-W35", observedAt: null }, ASOF), weekAgeDays("2026-W35", ASOF));
  // A grade name PriceIQ might add that isn't on the ladder never prices.
  assert.equal(marketUsable(answer({ rows: [{ grade: "Like New", price: 60_000, week: "2026-W35" }] }), ASOF, "X").ok, false);
});

test("PriceIQ unreachable: the last good answer, labelled — with its age too when it is old", () => {
  const u = marketUsable(answer({ unreachable: true }), ASOF, "X");
  assert.deepEqual(u, { ok: true, ageDays: 8, stale: false, note: "PriceIQ unreachable, last answer 2026-10-18 08:30 UTC." });
  const both = marketUsable(answer({ unreachable: true, observedAt: "2026-08-27T06:57:05.000Z" }), ASOF, "X");
  assert.equal(both.ok && both.note, "Refurbished market price, week 2026-W35, 52 days old · PriceIQ unreachable, last answer 2026-10-18 08:30 UTC.");
});

test("ISO week arithmetic: 2026-W35 starts Monday 24 Aug 2026", () => {
  assert.equal(weekAgeDays("2026-W35", "2026-08-24T00:00:00.000Z"), 0);
  assert.equal(weekAgeDays("2026-W35", "2026-10-18T09:00:00.000Z"), 55);
  assert.equal(weekAgeDays("nonsense", ASOF), null);
});

test("what PriceIQ is asked: the brand and any (code) stripped, never shortened further; storage in GB, never guessed", () => {
  assert.equal(priceiqModelName("Samsung", "Galaxy S23 Ultra"), "Galaxy S23 Ultra");
  assert.equal(priceiqModelName("Samsung", "Samsung Galaxy S23 Ultra (SM-S918B)"), "Galaxy S23 Ultra");
  assert.equal(priceiqModelName("Apple", "Apple iPhone 16 Pro Max (A3295)"), "iPhone 16 Pro Max");
  assert.equal(priceiqModelName("Samsung", "Galaxy Z Flip7 FE"), "Galaxy Z Flip7 FE", "an FE stays an FE");
  assert.equal(priceiqModelName("OnePlus", "OnePlus 11"), "11", "PriceIQ names it without the brand (its \"11 5G\" matches by the 5G rule)");
  assert.equal(priceiqModelName("Samsung", "Samsungish X1"), "Samsungish X1", "only the brand followed by a space is a prefix");
  assert.equal(storageGb("256GB"), 256);
  assert.equal(storageGb("1TB"), 1024);
  assert.equal(storageGb("8GB+256GB"), null, "a RAM+storage label is not asked as a guess");
  assert.equal(storageGb(null), null);
});
