import { test } from "node:test";
import assert from "node:assert/strict";
import { pctOf, inr, roundDown, fmtBp } from "./money.ts";
import { readImei, luhnValid, maskImei } from "./imei.ts";
import { FAULT_BY_ID, conditionFromFaults, conditionFloor, faultsNamedByCondition, healedCondition, partsForFaults, withConditionFaults, type ConditionAnswers, type FaultId } from "./condition.ts";
import { priceFromCard, linesSum } from "./ratecard.ts";
import { estimateRepair } from "./repair.ts";
import { computeBonus, validateCampaign, bestCampaign, type BonusContext } from "./bonus.ts";
import { CARD, BOOK, CAMPAIGN } from "./fixtures.ts";

const ACC = { accessories: { charger: true, box: true, bill: true }, age: "gt11m" as const };

test("money: percentages floor, never overpay", () => {
  assert.equal(pctOf(74999, 350), 2624); // 2624.965 → 2624
  assert.equal(pctOf(0, 500), 0);
  assert.equal(pctOf(1000, 0), 0);
  assert.equal(roundDown(12349, 10), 12340);
  assert.equal(inr(12345678), "₹1,23,45,678");
  assert.equal(inr(999), "₹999");
  assert.equal(inr(-1500), "−₹1,500");
  assert.equal(fmtBp(350), "3.5%");
  assert.equal(fmtBp(200), "2%");
});

test("imei: luhn, completion, masking", () => {
  assert.ok(luhnValid("490154203237518"));
  assert.ok(!luhnValid("490154203237519"));
  const r14 = readImei("49015420323751");
  assert.deepEqual(r14, { ok: true, imei: "490154203237518", checkDigit: "valid" });
  const bad = readImei("490154203237519");
  assert.equal(bad.ok && bad.checkDigit, "invalid");
  assert.equal(readImei("12345").ok, false);
  assert.equal(maskImei("490154203237518"), "49•••••••••7518");
});

test("condition: faults imply the floor, worst wins", () => {
  const a = conditionFromFaults(["screen_cracked", "display_lines", "battery_drain"], ACC);
  assert.equal(a.screen, "cracked");
  assert.deepEqual(a.issues, ["battery"]);
  const dead = conditionFromFaults(["no_power"], ACC);
  assert.equal(dead.powersOn, false);
});

test("condition: declaring better than the faults is reported", () => {
  const declared: ConditionAnswers = { powersOn: true, calls: true, screen: "flawless", body: "flawless", issues: [], ...ACC };
  const probs = conditionFloor(declared, ["screen_cracked", "battery_drain"]);
  assert.equal(probs.length, 2);
  const honest = conditionFromFaults(["screen_cracked", "battery_drain"], ACC);
  assert.deepEqual(conditionFloor({ ...honest, body: "dented" }, ["screen_cracked", "battery_drain"]), []); // worse is fine
});

test("condition: healing undoes only what repaired faults implied", () => {
  const a: ConditionAnswers = { ...conditionFromFaults(["screen_cracked", "back_cracked"], ACC), issues: ["battery", "speaker"] };
  const h = healedCondition(a, ["screen_cracked", "back_cracked"]);
  assert.equal(h.screen, "flawless");
  assert.equal(h.body, "flawless"); // a new back glass is the look the grade priced (one grade)
  assert.equal(healedCondition({ ...a, body: "bent" }, ["frame_damage"]).body, "scuffed"); // a frame: never better than scuffed
  assert.deepEqual(h.issues, ["battery", "speaker"]); // not repaired, not healed
});

test("condition names its fault (SUP-29): a crack, lines or a cracked back set on the condition alone is a fault to repair", () => {
  const healthy: ConditionAnswers = { powersOn: true, calls: true, screen: "flawless", body: "flawless", issues: [], ...ACC };
  assert.deepEqual(faultsNamedByCondition({ ...healthy, screen: "cracked" }, []), ["screen_cracked"]);
  assert.deepEqual(faultsNamedByCondition({ ...healthy, screen: "lines_or_spots" }, []), ["display_lines"]);
  assert.deepEqual(faultsNamedByCondition({ ...healthy, body: "back_cracked" }, []), ["back_cracked"]);
  assert.deepEqual(faultsNamedByCondition({ ...healthy, screen: "cracked", body: "back_cracked", issues: ["speaker"] }, []), ["screen_cracked", "back_cracked", "speaker"]);
  // Already a fault (or worse than the condition says): nothing to add, and the same list back.
  const f = ["screen_cracked"] as const;
  assert.deepEqual(faultsNamedByCondition({ ...healthy, screen: "cracked" }, [...f]), []);
  const same = [...f];
  assert.equal(withConditionFaults(same, { ...healthy, screen: "cracked" }), same);
  // Lines on file, the condition says cracked: the crack is physical damage the warranty won't cover — added.
  assert.deepEqual(faultsNamedByCondition({ ...healthy, screen: "cracked" }, ["display_lines"]), ["screen_cracked"]);
  // A swollen battery already explains "battery": no second battery fault.
  assert.deepEqual(faultsNamedByCondition({ ...conditionFromFaults(["battery_swollen"], ACC) }, ["battery_swollen"]), []);
  // Looks, a bent frame, and what only a bench can price name no fault.
  assert.deepEqual(faultsNamedByCondition({ ...healthy, screen: "scratched", body: "dented" }, []), []);
  assert.deepEqual(faultsNamedByCondition({ ...healthy, body: "bent", powersOn: false, calls: false, issues: ["liquid", "wifi_bt", "fingerprint", "vibration"] }, []), []);
  // Each fault named implies exactly the answer that named it: the trade-in condition doesn't move.
  for (const c of [{ ...healthy, screen: "cracked" as const }, { ...healthy, screen: "lines_or_spots" as const }, { ...healthy, body: "back_cracked" as const }, { ...healthy, issues: ["battery", "buttons", "charging", "front_camera", "mic", "rear_camera", "speaker", "touch"] as ConditionAnswers["issues"] }]) {
    const faults = withConditionFaults([], c);
    assert.ok(faults.length > 0);
    assert.deepEqual(conditionFloor(c, faults), [], "consistent: the condition already says what the faults imply");
    assert.deepEqual(conditionFromFaults(faults, c), c, "the faults imply exactly this condition");
    for (const id of faults) assert.ok(FAULT_BY_ID[id].part, `${id} is priced by the book`);
  }
});

test("condition takes back its own fault (SUP-29 review): a fault only the condition named goes when the answer changes; nothing else does", () => {
  const healthy: ConditionAnswers = { powersOn: true, calls: true, screen: "flawless", body: "flawless", issues: [], ...ACC };
  // "Cracked glass" tapped by mistake, then the right answer: the crack goes with it.
  assert.deepEqual(withConditionFaults(["screen_cracked"], { ...healthy, screen: "flawless" }, ["screen_cracked"]), []);
  // Cracked, then "Lines / spots": the one fault swapped for the other.
  assert.deepEqual(withConditionFaults(["screen_cracked"], { ...healthy, screen: "lines_or_spots" }, ["screen_cracked"]), ["display_lines"]);
  // Still named: kept, in place, and the same array back.
  const same: FaultId[] = ["mic", "screen_cracked"];
  assert.equal(withConditionFaults(same, { ...healthy, screen: "cracked", issues: ["mic"] }, ["screen_cracked"]), same);
  // An issue chip off takes its fault; another issue's fault stays.
  assert.deepEqual(withConditionFaults(["speaker", "mic"], { ...healthy, issues: ["mic"] }, ["speaker", "mic"]), ["mic"]);
  // A fault from anywhere else (the fault list, a test, the camera) is never the condition's to remove.
  assert.deepEqual(withConditionFaults(["screen_cracked"], { ...healthy, screen: "flawless" }, []), ["screen_cracked"]);
  assert.deepEqual(withConditionFaults(["screen_cracked", "speaker"], { ...healthy, screen: "cracked" }, ["speaker"]), ["screen_cracked"]);
});

test("condition: one display fixes crack + lines + touch", () => {
  const { parts, inspectionFaults } = partsForFaults(["screen_cracked", "display_lines", "touch_issue", "water_damage"]);
  assert.deepEqual(parts, ["display"]);
  assert.deepEqual(inspectionFaults, ["water_damage"]);
});

test("ratecard: unknown model is unpriced, never borrowed", () => {
  const q = priceFromCard(CARD, "galaxy-s22-fe", "8/128", conditionFromFaults([], ACC));
  assert.equal(q.status, "unpriced");
});

test("ratecard: trace always sums to the quote", () => {
  const cases: string[][] = [[], ["screen_cracked"], ["screen_cracked", "back_cracked", "touch_issue", "water_damage"], ["no_power"]];
  for (const f of cases) {
    const q = priceFromCard(CARD, "galaxy-s22", "8/128", conditionFromFaults(f as never, ACC));
    assert.equal(q.status, "priced");
    if (q.status === "priced") assert.equal(linesSum(q.lines), q.amount, `faults ${f.join(",")}`);
  }
});

test("ratecard: deductions are capped and floored visibly", () => {
  const a = conditionFromFaults(["screen_cracked", "back_cracked", "touch_issue", "water_damage", "rear_camera"], { ...ACC, accessories: { charger: false, box: false, bill: false } });
  const q = priceFromCard(CARD, "galaxy-s22", "8/128", a);
  assert.equal(q.status, "priced");
  if (q.status === "priced") {
    assert.ok(q.capped);
    assert.ok(q.lines.some((l) => l.label === "Deductions capped"));
    assert.equal(q.amount, 3600); // 24000 × 15% = 3600
  }
});

test("ratecard: a flawless S22 over a year old", () => {
  const q = priceFromCard(CARD, "galaxy-s22", "8/128", conditionFromFaults([], ACC));
  assert.equal(q.status === "priced" && q.amount, 24000 - 1920);
});

test("repair: book quote, display bundles faults, labour added", () => {
  const e = estimateRepair({ book: BOOK, modelId: "galaxy-s22", faults: ["screen_cracked", "touch_issue", "battery_drain"], coverage: "none", policy: { labour: 500, carePlusFee: 2000, gstBp: 0 } });
  assert.equal(e.status, "quoted");
  assert.equal(e.lines.length, 2);
  assert.equal(e.customerPays, 14000 + 3000 + 500);
});

test("repair: warranty covers non-physical, charges physical", () => {
  const e = estimateRepair({ book: BOOK, modelId: "galaxy-s22", faults: ["battery_drain", "back_cracked"], coverage: "warranty", policy: { labour: 500, carePlusFee: 2000, gstBp: 0 } });
  assert.equal(e.customerPays, 2500 + 500);
  const free = estimateRepair({ book: BOOK, modelId: "galaxy-s22", faults: ["battery_drain"], coverage: "warranty", policy: { labour: 500, carePlusFee: 2000, gstBp: 0 } });
  assert.equal(free.customerPays, 0);
});

test("repair: care plus charges the claim fee for physical damage", () => {
  const e = estimateRepair({ book: BOOK, modelId: "galaxy-s22", faults: ["screen_cracked"], coverage: "care_plus", policy: { labour: 500, carePlusFee: 2000, gstBp: 0 } });
  assert.equal(e.customerPays, 2000);
});

test("repair: inspection faults and missing prices refuse to quote", () => {
  const w = estimateRepair({ book: BOOK, modelId: "galaxy-s22", faults: ["water_damage"], coverage: "none", policy: { labour: 500, carePlusFee: 0, gstBp: 0 } });
  assert.equal(w.status, "needs_inspection");
  assert.equal(w.customerPays, null);
  const m = estimateRepair({ book: BOOK, modelId: "galaxy-a52", faults: ["battery_drain"], coverage: "none", policy: { labour: 500, carePlusFee: 0, gstBp: 0 } });
  assert.equal(m.status, "unpriced");
  const manual = estimateRepair({ book: BOOK, modelId: "galaxy-s22", faults: ["water_damage"], coverage: "none", policy: { labour: 500, carePlusFee: 0, gstBp: 0 }, manual: { amount: 9000, reason: "Board-level liquid repair per bench", by: "advisor" } });
  assert.equal(manual.customerPays, 9000);
  assert.throws(() => estimateRepair({ book: BOOK, modelId: "galaxy-s22", faults: [], coverage: "none", policy: { labour: 0, carePlusFee: 0, gstBp: 0 }, manual: { amount: 100, reason: "x", by: "a" } }));
});

const CTX: BonusContext = { today: "2026-10-15", oldBrand: "Samsung", oldAgeYears: 4, targetSeries: "S", newPrice: 79999, tradeInValue: 9000, repairRatio: 0.6, storeKind: "service_center" };

test("bonus: rules add up, clamp to the 2–5% band", () => {
  const r = computeBonus(CAMPAIGN, CTX);
  assert.equal(r.bp, 500); // 200+100+100+100+50 = 550 → 500
  assert.equal(r.clampedBy, "max");
  assert.equal(r.amount, pctOf(79999, 500));
  const lean = computeBonus(CAMPAIGN, { ...CTX, oldBrand: "Apple", targetSeries: "A", repairRatio: 0.1, oldAgeYears: 1 });
  assert.equal(lean.bp, 200);
});

test("bonus: cap and campaign validation", () => {
  const capped = computeBonus({ ...CAMPAIGN, capRupees: 1500 }, CTX);
  assert.equal(capped.amount, 1500);
  assert.equal(capped.clampedBy, "cap");
  assert.ok(validateCampaign({ ...CAMPAIGN, maxBp: 700 }).length > 0);
  assert.ok(validateCampaign({ ...CAMPAIGN, minBp: 100 }).length > 0);
  assert.deepEqual(validateCampaign(CAMPAIGN), []);
});

test("bonus: inactive campaigns are skipped", () => {
  assert.equal(bestCampaign([{ ...CAMPAIGN, endsOn: "2026-10-14" }], CTX), null);
  assert.ok(bestCampaign([CAMPAIGN], CTX));
});

test("repair: GST on parts + labour, plan fee is tax-inclusive", () => {
  const e = estimateRepair({ book: BOOK, modelId: "galaxy-s22", faults: ["screen_cracked"], coverage: "none", policy: { labour: 425, carePlusFee: 3699, gstBp: 1800 } });
  assert.equal(e.gst, Math.round((14000 + 425) * 0.18));
  assert.equal(e.customerPays, 14000 + 425 + e.gst);
  const cp = estimateRepair({ book: BOOK, modelId: "galaxy-s22", faults: ["screen_cracked"], coverage: "care_plus", policy: { labour: 425, carePlusFee: 3699, gstBp: 1800 } });
  assert.equal(cp.customerPays, 3699);
  assert.equal(cp.gst, 0);
});
