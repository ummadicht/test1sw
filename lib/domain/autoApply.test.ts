import { test } from "node:test";
import assert from "node:assert/strict";
import { WAIT_TEXT, autoApplyState, cameraUndecided, certifyWaiting, type AutoApplyInput } from "./autoApply.ts";

const done = { value: "ok", label: "OK", by: "Rahul Desai" };
const base = (over: Partial<AutoApplyInput> = {}): AutoApplyInput => ({
  status: "complete",
  gradePending: false,
  certify: { needed: [], rows: { screen: null, body: null, liquid: null } },
  refused: null,
  key: "2026-10-17T10:00:00.000Z",
  ...over,
});

test("the phone's tests come first: nothing is applied before the phone says it has finished", () => {
  for (const status of ["waiting", "opened", "joined", "testing"]) assert.deepEqual(autoApplyState(base({ status })), { state: "waiting", for: "tests", text: WAIT_TEXT.tests }, status);
  assert.deepEqual(autoApplyState(base({ status: "applied" })), { state: "applied" });
  assert.deepEqual(autoApplyState(base({ status: "expired" })), { state: "off" });
  assert.deepEqual(autoApplyState(base({ status: "cancelled" })), { state: "off" });
});

test("tests in and the camera decided everything: apply now", () => {
  assert.deepEqual(autoApplyState(base()), { state: "ready" });
});

test("the camera grade still being worked out holds it (Apply's own gate, seen first)", () => {
  assert.deepEqual(autoApplyState(base({ gradePending: true })), { state: "waiting", for: "camera", text: WAIT_TEXT.camera });
  // …even with the card open: the camera may yet decide what the advisor would be asked.
  assert.equal(autoApplyState(base({ gradePending: true, certify: { needed: ["screen", "body", "liquid"], rows: {} } })).state, "waiting");
  assert.equal((autoApplyState(base({ gradePending: true, certify: { needed: ["screen", "body", "liquid"], rows: {} } })) as { for: string }).for, "camera");
});

test("the camera couldn't decide: wait for every row on the card, then apply", () => {
  const needed = ["screen", "body", "liquid"];
  assert.deepEqual(autoApplyState(base({ certify: { needed, rows: {} } })), { state: "waiting", for: "certify", text: WAIT_TEXT.certify });
  assert.equal(autoApplyState(base({ certify: { needed, rows: { screen: done, body: done } } })).state, "waiting", "the liquid indicator is on the card too");
  assert.deepEqual(autoApplyState(base({ certify: { needed, rows: { screen: done, body: done, liquid: done } } })), { state: "ready" });
  // Only the screen undecided (the grade is final): screen + liquid.
  assert.equal(autoApplyState(base({ certify: { needed: ["screen", "liquid"], rows: { screen: done } } })).state, "waiting");
  assert.equal(autoApplyState(base({ certify: { needed: ["screen", "liquid"], rows: { screen: done, liquid: done } } })).state, "ready");
});

test("no card when the camera decided both — a lone liquid row never holds the answer", () => {
  assert.equal(cameraUndecided(["liquid"]), false);
  assert.equal(cameraUndecided([]), false);
  assert.equal(cameraUndecided(["body", "liquid"]), true);
  assert.equal(certifyWaiting({ needed: ["liquid"], rows: {} }), false);
  assert.equal(certifyWaiting(null), false);
  assert.equal(autoApplyState(base({ certify: { needed: ["liquid"], rows: {} } })).state, "ready");
  assert.equal(autoApplyState(base({ certify: null })).state, "ready", "no block (an older call): Apply's own gates decide");
});

test("a card nobody can tap any more (the case left the counter) holds nothing: Apply is tried and its refusal shows", () => {
  const needed = ["screen", "body", "liquid"];
  assert.equal(certifyWaiting({ needed, rows: {}, canEdit: false }), false);
  assert.deepEqual(autoApplyState(base({ certify: { needed, rows: {}, canEdit: false } })), { state: "ready" });
  const refused = { reason: "The case is past the counter.", key: "v1" };
  assert.deepEqual(autoApplyState(base({ certify: { needed, rows: {}, canEdit: false }, refused, key: "v1" })), { state: "refused", reason: refused.reason });
  assert.equal(WAIT_TEXT.camera, "Camera grade coming — the answer opens itself.", "no time promised: the wait can run to 3 minutes");
});

test("a refusal is shown, and not tried again until the session changes", () => {
  const refused = { reason: "The case is past the counter.", key: "v1" };
  assert.deepEqual(autoApplyState(base({ refused, key: "v1" })), { state: "refused", reason: refused.reason });
  assert.deepEqual(autoApplyState(base({ refused, key: "v2" })), { state: "ready" }, "new results, a new phase, a tap: try once more");
  // The waits still come first: a refusal recorded earlier never hides "the phone is still testing".
  assert.equal(autoApplyState(base({ refused, key: "v1", status: "testing" })).state, "waiting");
});
