import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDOVER_KEYS, HANDOVER_LABEL, handoverChecks } from "./handover.ts";

test("one hand-over tick sends all four flags the server checks", () => {
  assert.deepEqual(handoverChecks(true), { ownership: true, simRemoved: true, imeiMatches: true, noFinanceLock: true });
  assert.deepEqual(handoverChecks(false), { ownership: false, simRemoved: false, imeiMatches: false, noFinanceLock: false });
  assert.deepEqual(Object.keys(handoverChecks(true)), [...HANDOVER_KEYS], "exactly the four keys lockTradeIn reads");
});

test("the one tick names all four, in the store app's words", () => {
  assert.equal(HANDOVER_LABEL, "Owner confirmed · SIM out · IMEI matches · no EMI/lock");
});

test("the hand-over hint names the memory card, word for word the store app's (when the app's source is beside this repo)", async () => {
  const { HANDOVER_HINT } = await import("./handover.ts");
  assert.match(HANDOVER_HINT, /SIM and memory card out/);
  const { existsSync, readFileSync } = await import("node:fs");
  const app = new URL("../../../swapup-mobile/src/store/lock.ts", import.meta.url);
  if (!existsSync(app)) return;
  const theirs = /export const HANDOVER_HINT = "([^"]+)";/.exec(readFileSync(app, "utf8"))?.[1];
  assert.equal(theirs, HANDOVER_HINT);
});
