import { test } from "node:test";
import assert from "node:assert/strict";
import { dataClearState, missingDataClearSteps, DATA_CLEAR_STEPS, type DataClearRecord } from "./dataClear.ts";

const all = Object.fromEntries(DATA_CLEAR_STEPS.map(([k]) => [k, true]));
const rec: DataClearRecord = { label: "x", steps: all as DataClearRecord["steps"], note: null, by: "A", at: "2026-10-16T10:00:00Z" };

test("data clearing is due only while an accepted phone is at the store", () => {
  assert.equal(dataClearState("locked", null, false), "due");
  assert.equal(dataClearState("in_pickup", null, false), "due");
  for (const s of ["draft", "quoted", "repair_chosen", "walked_away", "cancelled", "collected", "cleared", "rejected"] as const)
    assert.equal(dataClearState(s, null, false), "not_applicable", s);
});

test("a record wins; an older case's hand-over tick reads as attested, never as done", () => {
  assert.equal(dataClearState("locked", rec, false), "done");
  assert.equal(dataClearState("collected", rec, true), "done");
  assert.equal(dataClearState("locked", null, true), "attested");
});

test("every step must be confirmed with a real true", () => {
  assert.deepEqual(missingDataClearSteps(all), []);
  assert.equal(missingDataClearSteps({}).length, DATA_CLEAR_STEPS.length);
  assert.equal(missingDataClearSteps({ ...all, noPreviousAccount: "true" }).length, 1, "a string is not a confirmation");
  assert.match(missingDataClearSteps({ ...all, setupScreenSeen: false })[0], /Welcome screen/);
});
