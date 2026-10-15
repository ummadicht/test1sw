import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type DecisionInput } from "./decision.ts";
import { canHold, position, exposure, checkLedger, pickupAdvice, type CreditEvent, type CreditPolicy } from "./credit.ts";
import { canTransition, collectionEvents, clearanceEvents, cancelEvents, type ClearanceOutcome } from "./lifecycle.ts";

const BASE: DecisionInput = {
  repairPays: 15000,
  repairCovered: false,
  repairedValue: 21000,
  asIsValue: 9000,
  valueSource: "partner_ratecard",
  upgrade: { label: "Galaxy S25", newPrice: 80999, bonus: 3240, supportEndYear: 2032 },
  old: { ageYears: 4, supportEndYear: 2026 },
  thisYear: 2026,
};

test("decision: covered repair is always recommended, even with no values", () => {
  const d = decide({ ...BASE, repairPays: 0, repairCovered: true, repairedValue: null, asIsValue: null });
  assert.equal(d.recommendation, "repair");
  assert.equal(d.favoursCustomer, "keep");
});

test("decision: refuses without a repair quote or partner value", () => {
  assert.equal(decide({ ...BASE, repairPays: null }).recommendation, "cannot_say");
  assert.equal(decide({ ...BASE, repairedValue: null }).recommendation, "cannot_say");
  assert.equal(decide({ ...BASE, asIsValue: null }).recommendation, "cannot_say");
});

test("decision: the 50% rule compares the repair with the NEW phone's price", () => {
  // ₹15,000 is 71% of the repaired phone's resale value but only 19% of a new ₹80,999 S25
  const d = decide(BASE);
  assert.equal(d.recommendation, "repair");
  assert.ok(d.signals.some((s) => s.code === "repair_vs_new_low" && s.strength === "strong"));
  assert.ok(d.signals.some((s) => s.code === "repair_destroys_value" && s.strength === "soft"));
  assert.equal(d.upgrade?.pays, 80999 - 9000 - 3240);
  assert.equal(d.upgrade?.extraVsRepair, 80999 - 9000 - 3240 - 15000);
  // the same repair against a ₹25,000 phone is 60% → a replacement is worth considering
  const cheapNew = decide({ ...BASE, upgrade: { label: "Galaxy A36", newPrice: 25000, bonus: 500, supportEndYear: 2031 } });
  assert.equal(cheapNew.recommendation, "upgrade");
  assert.equal(d.version, cheapNew.version);
});

test("decision: cheap repair on a supported phone is repair", () => {
  const d = decide({ ...BASE, repairPays: 3500, old: { ageYears: 2, supportEndYear: 2029 } });
  assert.equal(d.recommendation, "repair");
  assert.equal(d.favoursCustomer, "keep");
});

test("decision: the bonus never changes the recommendation", () => {
  const cheap = { ...BASE, repairPays: 3500, old: { ageYears: 2, supportEndYear: 2029 } };
  const a = decide(cheap);
  const b = decide({ ...cheap, upgrade: { ...cheap.upgrade!, bonus: 50000 } });
  assert.equal(a.recommendation, b.recommendation);
  assert.deepEqual(a.signals, b.signals);
  assert.equal(a.favoursCustomer, b.favoursCustomer);
});

test("decision: repair costs more than the phone is worth, yet is small next to a new one — the customer's call", () => {
  const d = decide({ ...BASE, repairPays: 12000, repairedValue: 11000, asIsValue: 4000, old: { ageYears: 3, supportEndYear: 2028 } });
  assert.ok(d.signals.some((s) => s.code === "repair_exceeds_value" && s.strength === "strong"));
  assert.equal(d.recommendation, "either");
  assert.equal(d.favoursCustomer, "let_go");
});

test("decision: support ending never flips the advice on its own", () => {
  const d = decide({ ...BASE, repairPays: 2000, repairedValue: 8000, asIsValue: 5000, old: { ageYears: 6, supportEndYear: 2024 } });
  const s = d.signals.find((x) => x.code === "support_ended");
  assert.equal(s?.strength, "soft");
  assert.equal(d.recommendation, "repair");
  assert.ok(d.caveats.some((c) => c.includes("still works")));
});

test("decision: sample prices are always caveated", () => {
  const d = decide({ ...BASE, valueSource: "sample" });
  assert.ok(d.caveats.some((c) => c.includes("SAMPLE")));
});

const POLICY: CreditPolicy = { limit: 100000, releaseOn: "collected", warnAt: 0.8, maxAgeDays: 7, pickupAtCount: 10 };

test("credit: holds consume the line, the limit is hard", () => {
  const ev: CreditEvent[] = [
    { kind: "hold", caseId: "a", amount: 60000, at: "2026-10-01" },
    { kind: "hold", caseId: "b", amount: 30000, at: "2026-10-02" },
  ];
  const ok = canHold(POLICY, ev, 10000);
  assert.ok(ok.ok);
  if (ok.ok) assert.ok(ok.warn); // 100% after
  const no = canHold(POLICY, ev, 10001);
  assert.equal(no.ok, false);
  if (!no.ok) assert.equal(no.shortBy, 1);
  assert.equal(position(POLICY, ev).state, "warn");
  assert.equal(canHold(POLICY, ev, 0).ok, false);
});

test("credit: pickup advice by utilisation, age and count", () => {
  const ev: CreditEvent[] = [{ kind: "hold", caseId: "a", amount: 85000, at: "2026-10-01" }];
  const adv = pickupAdvice(POLICY, ev, [{ caseId: "a", value: 85000, heldSince: "2026-10-01T10:00:00Z" }], "2026-10-09T10:00:00Z");
  assert.ok(adv.due);
  assert.equal(adv.reasons.length, 2);
  assert.equal(adv.oldestDays, 8);
});

test("credit: ledger invariants catch double release and over-recovery", () => {
  assert.ok(checkLedger([
    { kind: "hold", caseId: "a", amount: 100, at: "1" },
    { kind: "release", caseId: "a", amount: 100, at: "2" },
    { kind: "release", caseId: "a", amount: 100, at: "3" },
  ]).length > 0);
  assert.ok(checkLedger([
    { kind: "hold", caseId: "a", amount: 100, at: "1" },
    { kind: "chargeback", caseId: "a", amount: 10, at: "2" },
    { kind: "recovery", caseId: "a", amount: 20, at: "3" },
  ]).length > 0);
});

test("lifecycle: transitions are guarded", () => {
  assert.ok(canTransition("quoted", "locked"));
  assert.ok(!canTransition("draft", "locked"));
  assert.ok(!canTransition("cleared", "locked"));
  assert.ok(canTransition("in_pickup", "locked"));
  assert.ok(!canTransition("collected", "cancelled"));
});

test("lifecycle: after the verdict, exposure equals exactly what the store is still out — both release points", () => {
  const outcomes: { o: ClearanceOutcome; accepted: number }[] = [
    { o: "cleared", accepted: 0 }, // ignored → T
    { o: "regraded", accepted: 7000 },
    { o: "rejected", accepted: 999 }, // ignored → 0
    { o: "not_received", accepted: 0 },
  ];
  for (const releaseOn of ["collected", "cleared"] as const) {
    for (const liab of ["store", "partner"] as const) {
      for (const { o, accepted } of outcomes) {
        const T = 10000;
        const ev: CreditEvent[] = [{ kind: "hold", caseId: "c", amount: T, at: "1" }];
        ev.push(...collectionEvents(releaseOn, "c", T, "2"));
        const r = clearanceEvents({ releaseOn, caseId: "c", held: T, outcome: o, accepted, shortfallLiability: liab, at: "3" });
        ev.push(...r.events);
        assert.deepEqual(checkLedger(ev), [], `${releaseOn}/${liab}/${o}`);
        const expected = o === "not_received" || liab === "store" ? T - r.accepted : 0;
        assert.equal(exposure(ev), expected, `${releaseOn}/${liab}/${o}`);
      }
    }
  }
});

test("lifecycle: a regrade must actually be lower", () => {
  assert.throws(() => clearanceEvents({ releaseOn: "collected", caseId: "c", held: 100, outcome: "regraded", accepted: 100, shortfallLiability: "store", at: "x" }));
});

test("lifecycle: cancelling gives the whole hold back", () => {
  const ev: CreditEvent[] = [{ kind: "hold", caseId: "c", amount: 5000, at: "1" }, ...cancelEvents("c", 5000, "2")];
  assert.equal(exposure(ev), 0);
  assert.deepEqual(checkLedger(ev), []);
});

test("credit: random walk of many cases never breaks the ledger", () => {
  // deterministic pseudo-random
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const releaseOn of ["collected", "cleared"] as const) {
    const ev: CreditEvent[] = [];
    let expectedOpen = 0;
    for (let i = 0; i < 300; i++) {
      const id = `c${i}`;
      const T = 1000 + Math.floor(rnd() * 40000);
      ev.push({ kind: "hold", caseId: id, amount: T, at: String(i) });
      const roll = rnd();
      if (roll < 0.15) { ev.push(...cancelEvents(id, T, String(i))); continue; }
      if (roll < 0.25) { expectedOpen += T; continue; } // still at store
      ev.push(...collectionEvents(releaseOn, id, T, String(i)));
      if (roll < 0.35) { if (releaseOn === "cleared") expectedOpen += T; continue; } // collected, not yet verified
      const os: ClearanceOutcome[] = ["cleared", "regraded", "rejected", "not_received"];
      const o = os[Math.floor(rnd() * 4)];
      const acc = o === "regraded" ? Math.floor(T * 0.6) : 0;
      const r = clearanceEvents({ releaseOn, caseId: id, held: T, outcome: o, accepted: acc, shortfallLiability: "store", at: String(i) });
      ev.push(...r.events);
      expectedOpen += r.shortfall;
    }
    assert.deepEqual(checkLedger(ev), []);
    assert.equal(exposure(ev), expectedOpen);
  }
});

test("decision: a cheap repair is repair even when it does not pay back at resale", () => {
  // battery ₹2,856 on a phone worth 11,220 repaired / 10,120 as-is
  const d = decide({ ...BASE, repairPays: 2856, repairedValue: 11220, asIsValue: 10120, old: { ageYears: 3, supportEndYear: 2028 } });
  assert.equal(d.recommendation, "repair");
  assert.ok(d.signals.some((s) => s.code === "repair_destroys_value" && s.strength === "soft"));
});

test("decision: no faults is a straight trade-in, not a comparison", () => {
  const d = decide({ ...BASE, repairPays: null, repairedValue: 9000, nothingToRepair: true });
  assert.equal(d.recommendation, "no_repair");
  assert.equal(d.upgrade?.pays, 80999 - 9000 - 3240);
});

test("decision: with no new phone chosen, only the repaired value can say a repair does not pay", () => {
  const d = decide({ ...BASE, upgrade: null, repairPays: 9000, repairedValue: 8000, asIsValue: 2000 });
  assert.equal(d.recommendation, "upgrade");
  assert.ok(!d.signals.some((s) => s.code.startsWith("repair_vs_new")));
  assert.equal(d.metrics.repairVsNewRatio, null);
});

test("decision: swollen battery is a safety caveat, not a sales hook", () => {
  const d = decide({ ...BASE, repairPays: 2500, repairedValue: 11000, asIsValue: 9800, swollenBattery: true, faultCount: 1 });
  assert.equal(d.recommendation, "repair");
  assert.ok(d.caveats[0].includes("safety"));
});
