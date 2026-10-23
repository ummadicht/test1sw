import { test } from "node:test";
import assert from "node:assert/strict";
import { luhnCheckDigit } from "../../lib/domain/imei.ts";
import {
  BAD_CHECK_DIGIT,
  BAD_CHECK_START,
  NOT_LOOKED_UP,
  STOP_BLACKLISTED,
  STOP_GSMA,
  imeiEntry,
  imeiFound,
  imeiPatch,
  readImeiRead,
  readLine,
  startCase,
  type Call,
} from "./imeiFirst.ts";

const body14 = "35467911234567";
const GOOD = body14 + String(luhnCheckDigit(body14));
const BAD = body14 + String((luhnCheckDigit(body14) + 1) % 10);
const body14b = "35467911234568";
const GOOD2 = body14b + String(luhnCheckDigit(body14b));

test("typed: empty is no IMEI; 14 digits are completed; a failed check digit warns at once and Start needs 'Record it anyway'", () => {
  assert.deepEqual(imeiEntry(""), { imei: null, warn: null, problem: null });
  assert.deepEqual(imeiEntry("  "), { imei: null, warn: null, problem: null });
  assert.deepEqual(imeiEntry(GOOD), { imei: GOOD, warn: null, problem: null });
  assert.deepEqual(imeiEntry(`${GOOD.slice(0, 2)} ${GOOD.slice(2)}`), { imei: GOOD, warn: null, problem: null }, "spaces are not digits");
  assert.deepEqual(imeiEntry(body14), { imei: GOOD, warn: null, problem: null }, "a box label without its check digit");
  assert.deepEqual(imeiEntry("3546791"), { imei: null, warn: null, problem: "An IMEI has 15 digits — this has 7." });
  assert.deepEqual(imeiEntry(BAD), { imei: BAD, warn: BAD_CHECK_DIGIT, problem: BAD_CHECK_START });
  assert.deepEqual(imeiEntry(BAD, true), { imei: BAD, warn: BAD_CHECK_DIGIT, problem: null }, "recorded as typed — the server never looks it up");
});

test("read the screen: the server's {imei, imei2, valid}, checked again here; IMEI 2 only when it passes and differs", () => {
  assert.deepEqual(readImeiRead({ imei: GOOD, imei2: GOOD2, valid: true }), { imei: GOOD, imei2: GOOD2, valid: true });
  assert.deepEqual(readImeiRead({ imei: BAD, imei2: null, valid: true }), { imei: BAD, imei2: null, valid: false }, "the check digit is ours to say");
  assert.deepEqual(readImeiRead({ imei: GOOD, imei2: GOOD }), { imei: GOOD, imei2: null, valid: true });
  assert.deepEqual(readImeiRead({ imei: GOOD, imei2: BAD }), { imei: GOOD, imei2: null, valid: true });
  assert.equal(readImeiRead({ imei: null }), null);
  assert.equal(readImeiRead(null), null);
  assert.equal(readLine({ imei: GOOD, imei2: GOOD2 }), `Read: ${GOOD} · IMEI 2 ${GOOD2} — check it against the screen.`);
  assert.equal(readLine({ imei: GOOD, imei2: null }), `Read: ${GOOD} — check it against the screen.`);
});

test("the save is the store app's PATCH: IMEI 2 with it when read; a new IMEI 1 alone clears the old IMEI 2", () => {
  assert.deepEqual(imeiPatch({ imei: GOOD, imei2: GOOD2 }, null), { imei: GOOD, imei2: GOOD2 });
  assert.deepEqual(imeiPatch({ imei: GOOD, imei2: null }, null), { imei: GOOD, imei2: null });
  assert.deepEqual(imeiPatch({ imei: GOOD, imei2: null }, GOOD), { imei: GOOD });
});

function fakeCall(fail: (path: string, method: string) => string | null = () => null) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const call: Call = async <T,>(path: string, opts: { method?: string; body?: unknown } = {}) => {
    const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
    calls.push({ path, method, body: opts.body });
    const err = fail(path, method);
    if (err) throw new Error(err);
    return { id: "case_1" } as T;
  };
  return { call, calls };
}

test("Start: POST /api/cases with the customer, then PATCH {imei, imei2} on that case; no IMEI → one call", async () => {
  const f = fakeCall();
  assert.deepEqual(await startCase(f.call, { customerName: " Asha ", customerPhone: "9820012345", imei: { imei: GOOD, imei2: GOOD2 }, caseId: null }), { caseId: "case_1", error: null });
  assert.deepEqual(f.calls, [
    { path: "/api/cases", method: "POST", body: { customerName: "Asha", customerPhone: "9820012345" } },
    { path: "/api/cases/case_1", method: "PATCH", body: { imei: GOOD, imei2: GOOD2 } },
  ]);
  const g = fakeCall();
  await startCase(g.call, { customerName: "", customerPhone: null, imei: null, caseId: null });
  assert.deepEqual(g.calls, [{ path: "/api/cases", method: "POST", body: {} }]);
});

test("Start: a failed IMEI save keeps the case it opened; Start again saves the customer and the IMEI on it in one PATCH", async () => {
  const f = fakeCall((path, method) => (method === "PATCH" ? "Request failed (502)" : null));
  const r = await startCase(f.call, { customerName: "Asha", customerPhone: null, imei: { imei: GOOD, imei2: null }, caseId: null });
  assert.deepEqual(r, { caseId: "case_1", error: "Request failed (502)" });
  const g = fakeCall();
  assert.deepEqual(await startCase(g.call, { customerName: "Asha Rao", customerPhone: "9820012345", imei: { imei: GOOD, imei2: null }, caseId: "case_1" }), { caseId: "case_1", error: null });
  assert.deepEqual(g.calls, [{ path: "/api/cases/case_1", method: "PATCH", body: { customer: { name: "Asha Rao", phone: "9820012345" }, imei: GOOD, imei2: null } }], "never a second case");
  const h = fakeCall();
  await startCase(h.call, { customerName: "", customerPhone: null, imei: null, caseId: "case_1" });
  assert.deepEqual(h.calls[0].body, { customer: null });
  const down = fakeCall(() => "Request failed (500)");
  assert.deepEqual(await startCase(down.call, { customerName: "", customerPhone: null, imei: null, caseId: null }), { caseId: null, error: "Request failed (500)" });
});

const VIEW = { imei: GOOD, imeiCheck: "valid" as const, imeiLookup: null, imeiWarnings: [] as string[], kymEarly: null, modelSource: null };
const lookup = (blacklist: "clean" | "blacklisted" | "unknown", model: string | null = "Galaxy S23 Ultra") => ({ brand: "Samsung", model, modelNumber: null, blacklist, source: "tac", at: "2026-10-22T00:00:00Z" });

test("what the server found: the model and GSMA's word, its warnings, and the stop — before any test", () => {
  assert.deepEqual(imeiFound({ ...VIEW, imeiLookup: lookup("clean"), modelSource: "imei" }), {
    line: "Galaxy S23 Ultra · not blacklisted (GSMA)",
    tone: "up",
    modelFromImei: true,
    warnings: [],
    stop: null,
  });
  const unknown = imeiFound({ ...VIEW, imeiLookup: lookup("unknown"), imeiWarnings: ["This IMEI is already on trade-in SU-AND-00031."] });
  assert.deepEqual([unknown.line, unknown.tone, unknown.warnings, unknown.modelFromImei], ["Galaxy S23 Ultra · Blacklist not checked", "warn", ["This IMEI is already on trade-in SU-AND-00031."], false]);
  assert.equal(imeiFound({ ...VIEW, imeiLookup: lookup("unknown", null) }).line, "Samsung · Blacklist not checked");
  assert.equal(imeiFound({ ...VIEW, imeiLookup: { ...lookup("unknown", null), brand: null } }).line, "Blacklist not checked", "never said as clean");
  const bad = imeiFound({ ...VIEW, imeiLookup: lookup("blacklisted") });
  assert.deepEqual([bad.line, bad.tone, bad.stop], ["Galaxy S23 Ultra · reported lost or stolen (GSMA)", "bad", STOP_GSMA]);
  assert.equal(imeiFound({ ...VIEW, imeiLookup: lookup("clean"), kymEarly: { status: "duplicate", reference: null } }).stop, STOP_BLACKLISTED);
  assert.equal(imeiFound({ ...VIEW, imeiLookup: lookup("clean"), kymEarly: { status: "clear", reference: null } }).stop, null);
  // A check digit that fails: kept, never looked up (never paid for).
  assert.deepEqual(imeiFound({ ...VIEW, imei: BAD, imeiCheck: "invalid" }).line, NOT_LOOKED_UP);
  assert.equal(imeiFound({ ...VIEW, imei: null, imeiCheck: null }).line, null);
});
