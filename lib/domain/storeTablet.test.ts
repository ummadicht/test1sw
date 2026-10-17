import { test } from "node:test";
import assert from "node:assert/strict";
import { afterWrongPin, deviceNameProblem, isLocked, pinProblem, PIN_LOCK_MS, PIN_MAX_FAILURES, TABLET_IDLE_MS } from "./storeTablet.ts";

const RUN = "Pick a PIN that isn't a run or one repeated digit.";
const SHAPE = "The PIN is 4 digits.";

test("a PIN is exactly 4 digits, as a string", () => {
  assert.equal(pinProblem("2580"), null);
  assert.equal(pinProblem("0258"), null, "a leading zero is fine");
  assert.equal(pinProblem(""), SHAPE);
  assert.equal(pinProblem("12a4"), SHAPE);
  assert.equal(pinProblem("258"), SHAPE);
  assert.equal(pinProblem("25801"), SHAPE);
  assert.equal(pinProblem(" 2580"), SHAPE, "no padding");
  assert.equal(pinProblem("２５８０"), SHAPE, "full-width digits are not digits here");
  assert.equal(pinProblem(2580), SHAPE, "a number would lose leading zeros");
  assert.equal(pinProblem(null), SHAPE);
  assert.equal(pinProblem(undefined), SHAPE);
});

test("one repeated digit and straight runs are refused", () => {
  for (const p of ["0000", "1111", "9999"]) assert.equal(pinProblem(p), RUN, p);
  for (const p of ["0123", "1234", "3456", "6789"]) assert.equal(pinProblem(p), RUN, p);
  for (const p of ["4321", "9876", "3210"]) assert.equal(pinProblem(p), RUN, p);
});

test("near-runs and runs that would wrap are allowed", () => {
  for (const p of ["8901", "7890", "1098", "1235", "1122", "1212", "1357", "2468", "1110"]) assert.equal(pinProblem(p), null, p);
});

test("wrong PINs count down to a lock", () => {
  const now = Date.parse("2026-10-17T10:00:00Z");
  let failures = 0;
  for (let i = 1; i < PIN_MAX_FAILURES; i++) {
    const r = afterWrongPin(failures, now);
    assert.equal(r.failures, i);
    assert.equal(r.lockedUntil, null);
    assert.equal(r.triesLeft, PIN_MAX_FAILURES - i);
    failures = r.failures;
  }
  assert.equal(failures, 4);
  const locked = afterWrongPin(failures, now);
  assert.deepEqual(locked, { failures: 5, lockedUntil: now + PIN_LOCK_MS, triesLeft: 0 });
  assert.equal(PIN_MAX_FAILURES, 5);
  assert.equal(PIN_LOCK_MS, 10 * 60_000);
});

test("a nonsense failure count starts from zero", () => {
  const now = 1_000;
  assert.deepEqual(afterWrongPin(Number.NaN, now), { failures: 1, lockedUntil: null, triesLeft: 4 });
  assert.deepEqual(afterWrongPin(-3, now), { failures: 1, lockedUntil: null, triesLeft: 4 });
  assert.equal(afterWrongPin(12, now).lockedUntil, now + PIN_LOCK_MS, "past the limit stays locked");
});

test("a lock runs until its time, then stops", () => {
  const now = Date.parse("2026-10-17T10:00:00Z");
  const until = new Date(now + PIN_LOCK_MS).toISOString();
  assert.equal(isLocked(until, now), true);
  assert.equal(isLocked(until, now + PIN_LOCK_MS - 1), true);
  assert.equal(isLocked(until, now + PIN_LOCK_MS), false);
  assert.equal(isLocked(null, now), false);
  assert.equal(isLocked("not a time", now), false);
});

test("a tablet's name is 2 to 40 characters after trimming", () => {
  assert.equal(deviceNameProblem("Counter tablet 1"), null);
  assert.equal(deviceNameProblem("  T2  "), null);
  assert.equal(deviceNameProblem("x".repeat(40)), null);
  assert.match(deviceNameProblem("x".repeat(41)) ?? "", /2 to 40/);
  assert.match(deviceNameProblem(" a ") ?? "", /2 to 40/);
  assert.match(deviceNameProblem("") ?? "", /2 to 40/);
  assert.match(deviceNameProblem(42) ?? "", /2 to 40/);
  assert.match(deviceNameProblem(undefined) ?? "", /2 to 40/);
});

test("the idle lock is 15 minutes", () => {
  assert.equal(TABLET_IDLE_MS, 15 * 60_000);
});
