/**
 * THE IMEI FIRST (contract I2/I3, lib/server/imeiResolve.ts) through the REAL server services on a
 * throwaway database, against a stand-in GradeIQ on 127.0.0.1 (no real network): an IMEI saved on a
 * case names its model from the free TAC list, GradeIQ's lookup runs once per case + IMEI with the
 * server key, a Samsung model number beats the TAC, the model is set only where the case has none,
 * a blacklisted phone is refused before tests and at the lock, the early KYM answer is kept for Lock,
 * the "already traded in" warning comes at once, join prefers the case's model and Apply flags a
 * phone code that disagrees with the IMEI; POST /api/imei/read maps GradeIQ's reader to its three
 * answers. GradeIQ off, or no key: nothing is called and nothing breaks.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/*.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "swapup-imei-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_") || k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_") || k.startsWith("GRADEIQ_IMEI")) delete process.env[k];
delete process.env.GRADEIQ_SERVER_KEY;

/* ─────────────────────────── a stand-in GradeIQ (its IMEI routes only) ─────────────────────────── */

const KEY = "giq_server_test_key_0000000000000000";
type Info = Record<string, unknown>;
const fake = {
  url: "",
  /** imei → what GET /api/imei/<imei> answers (absent → a TAC-only "unknown"). */
  infos: new Map<string, Info>(),
  ocr: { imei: "", error: "not_found" } as Record<string, unknown>,
  mode: "ok" as "ok" | "slow" | "down",
  calls: [] as { method: string; path: string; keyOk: boolean; body: unknown }[],
};
const readBody = (req: IncomingMessage) =>
  new Promise<string>((res) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => res(s));
  });
const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const path = (req.url || "").split("?")[0];
  const keyOk = req.headers["x-gradeiq-server-key"] === KEY;
  fake.calls.push({ method: req.method || "", path, keyOk, body: body ? JSON.parse(body) : null });
  const send = (status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (fake.mode === "down") return send(503, { error: "down" });
  if (fake.mode === "slow") await new Promise((r) => setTimeout(r, 1500));
  if (!keyOk) return send(401, { error: "unauthorised" });
  const m = /^\/api\/imei\/(\d{15})$/.exec(path);
  if (req.method === "GET" && m) return send(200, fake.infos.get(m[1]) ?? { imei: m[1], brand: "", model: `Unknown device (TAC ${m[1].slice(0, 8)})`, blacklist: "unknown", source: "stub" });
  if (req.method === "POST" && path === "/api/imei/ocr") return send(200, fake.ocr);
  return send(404, { error: "not found" });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.GRADEIQ_BASE_URL = fake.url;
/** GradeIQ on, with the key, for exactly this call (sessions are made with it off: no background create). */
async function withGiq<T>(fn: () => Promise<T>, env: Record<string, string> = {}): Promise<T> {
  const set = { GRADEIQ_ENABLED: "1", GRADEIQ_SERVER_KEY: KEY, ...env };
  Object.assign(process.env, set);
  try {
    return await fn();
  } finally {
    process.env.GRADEIQ_ENABLED = "0";
    for (const k of Object.keys(set)) if (k !== "GRADEIQ_ENABLED") delete process.env[k];
  }
}
const imeiCalls = () => fake.calls.filter((c) => c.path.startsWith("/api/imei/") && c.path !== "/api/imei/ocr");

const origLog = console.log;
const origError = console.error;
console.log = () => {};
console.error = () => {};

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db, MIGRATIONS } = await import("./db.ts");
const { issueToken } = await import("./auth.ts");
const { handle } = await import("./http.ts");
const cases = await import("./cases.ts");
const sessions = await import("./testSessions.ts");
const { BLACKLISTED, READER_OFF, NO_IMEI_IN_PHOTO } = await import("./imeiResolve.ts");
const { DEFAULT_PLAN } = await import("../domain/diagnostics.ts");
const { luhnCheckDigit } = await import("../domain/imei.ts");
const readRoute = await import("../../app/api/imei/read/route.ts");
const caseRoute = await import("../../app/api/cases/[id]/route.ts");

after(async () => {
  console.log = origLog;
  console.error = origError;
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

type U = import("./auth.ts").SessionUser;
function who(id: string): U {
  const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE id = ?`).get(id) as { id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null };
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
}
const adv = who("usr_adv_and");
const partner = who((db().prepare(`SELECT id FROM users WHERE username = 'partner'`).get() as { id: string }).id);
const S26U_256 = (db().prepare(`SELECT id FROM new_devices WHERE org_id = ? AND model = 'Galaxy S26 Ultra' AND variant = '256GB'`).get(adv.orgId) as { id: string }).id;
// The partner's card prices the S23 Ultra these lock tests trade in: the price is always the system's, never typed.
const { uploadRateCard } = await import("./catalog.ts");
const { DEFECT_DEDUCTIONS } = await import("../domain/ratecard.ts");
uploadRateCard(partner, { label: "Week 41 (test)", effectiveFrom: "2026-10-05", quoteValidityDays: 3, csv: "model_id,variant,max_price\ngalaxy-s23-ultra,256GB,40000\n", deductions: DEFECT_DEDUCTIONS, activate: true });

/* IMEIs on real TACs (the offline list's own first TAC for each name), each one new. */
const TACS = JSON.parse(readFileSync(new URL("../domain/tacdb.json", import.meta.url), "utf8")) as Record<string, string>;
const tacFor = (name: string) => Object.keys(TACS).find((t) => TACS[t] === name)!;
let seq = 0;
function imeiOn(name: string): string {
  const body = `${tacFor(name)}${String(100000 + ++seq).slice(-6)}`;
  return body + String(luhnCheckDigit(body));
}
const S23U = "Samsung Galaxy S23 Ultra";
const S23 = "Samsung Galaxy S23";
const IP13 = "Apple Iphone 13";

const CUSTOMER = { name: "Asha Rao", phone: "9820012345", idType: "aadhaar", idLast4: "1234" };
const CHECKS = { ownership: true, simRemoved: true, imeiMatches: true, noFinanceLock: true, kym: { status: "clear" as const, reference: "SS-1" } };
const COND = { powersOn: true, calls: true, screen: "cracked", body: "dented", issues: [] as string[], accessories: { charger: true, box: false, bill: false }, age: "gt11m" };
const fresh = () => cases.createCase(adv, { customerName: CUSTOMER.name, customerPhone: CUSTOMER.phone });

async function asUser<T>(u: U, fn: () => Promise<T>): Promise<T> {
  (globalThis as { __swapupTestHeaders?: Record<string, string> }).__swapupTestHeaders = { authorization: `Bearer ${issueToken(u)}` };
  try {
    return await fn();
  } finally {
    (globalThis as { __swapupTestHeaders?: Record<string, string> }).__swapupTestHeaders = {};
  }
}

/* ─────────────────────────── migration 17 ─────────────────────────── */

test("migration 17 adds imei_lookup, kym_early and model_source to cases", () => {
  assert.equal(MIGRATIONS.length, 17);
  const cols = (db().prepare(`PRAGMA table_info(cases)`).all() as { name: string }[]).map((c) => c.name);
  for (const c of ["imei_lookup", "kym_early", "model_source"]) assert.ok(cols.includes(c), c);
});

/* ─────────────────────────── I2.1 + I2.2: the model and the lookup, once ─────────────────────────── */

test("an IMEI on a case with no model: the TAC names it (source imei, no storage), GradeIQ is asked ONCE with the server key", async () => {
  const imei = imeiOn(S23U);
  fake.infos.set(imei, { imei, brand: "Samsung", model: "Galaxy S23 Ultra", modelNumber: "SM-S918B", blacklist: "clean", source: "gsma", lock: "unknown", fmip: "unknown" });
  const c = fresh();
  const before = imeiCalls().length;
  const v = await withGiq(() => cases.updateCase(adv, c.id, { imei }));
  assert.equal(v.device?.modelId, "galaxy-s23-ultra");
  assert.equal(v.modelSource, "imei");
  assert.equal(v.device?.variant, null, "never a storage from the IMEI");
  assert.equal(v.variantSource, null);
  assert.deepEqual(v.imeiLookup, { brand: "Samsung", model: "Galaxy S23 Ultra", modelNumber: "SM-S918B", blacklist: "clean", source: "gsma", at: v.imeiLookup!.at });
  assert.ok(!Number.isNaN(Date.parse(v.imeiLookup!.at)));
  assert.deepEqual(v.imeiWarnings, []);
  const calls = imeiCalls().slice(before);
  assert.deepEqual(calls.map((x) => [x.method, x.path, x.keyOk]), [["GET", `/api/imei/${imei}`, true]]);
  // The same IMEI again, the second IMEI, a KYM tap: no new lookup.
  await withGiq(() => cases.updateCase(adv, c.id, { imei }));
  await withGiq(() => cases.updateCase(adv, c.id, { imei2: imeiOn(S23U) }));
  assert.equal(imeiCalls().length, before + 1, "never re-run for the same IMEI");
  // Another IMEI, then back to the first: only the new one is asked; the first comes from the case.
  const other = imeiOn(S23U);
  await withGiq(() => cases.updateCase(adv, c.id, { imei: other }));
  const back = await withGiq(() => cases.updateCase(adv, c.id, { imei }));
  assert.equal(imeiCalls().length, before + 2);
  assert.equal(back.imeiLookup?.blacklist, "clean", "the first IMEI's answer, kept on the case");
  // One audit row per paid call.
  const rows = db().prepare(`SELECT detail FROM audit WHERE action = 'case.imei_lookup' AND entity_id = ?`).all(c.id) as { detail: string }[];
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0].detail), { source: "gsma", blacklist: "clean", modelId: "galaxy-s23-ultra", modelNumber: "SM-S918B", setModel: "galaxy-s23-ultra" });
});

test("a Samsung model number is the maker's code: it beats the TAC's name", async () => {
  const imei = imeiOn(S23);
  fake.infos.set(imei, { imei, brand: "Samsung", model: "Galaxy S23 Ultra", modelNumber: "SM-S918B", blacklist: "clean", source: "gsma" });
  const v = await withGiq(() => cases.updateCase(adv, fresh().id, { imei }));
  assert.equal(v.device?.modelId, "galaxy-s23-ultra");
  const stored = JSON.parse((db().prepare(`SELECT imei_lookup FROM cases WHERE id = ?`).get(v.id) as { imei_lookup: string }).imei_lookup) as { modelWhy: string }[];
  assert.match(stored[0].modelWhy, /^Model number SM-S918B \(the type code says Galaxy S23\): Samsung Galaxy S23 Ultra\.$/);
});

test("a case that has a model keeps it — the IMEI's other model is a warning; a model the IMEI named follows a corrected IMEI", async () => {
  const c = fresh();
  await cases.updateCase(adv, c.id, { modelId: "galaxy-s23", variant: "128GB" });
  const v = await cases.updateCase(adv, c.id, { imei: imeiOn(S23U) });
  assert.equal(v.device?.modelId, "galaxy-s23");
  assert.equal(v.modelSource, "advisor");
  assert.deepEqual(v.imeiWarnings, ["The IMEI says Samsung Galaxy S23 Ultra; the case has Samsung Galaxy S23 — check Settings › About phone."]);
  // Model and IMEI in one save: staff's model stands.
  const both = await cases.updateCase(adv, fresh().id, { modelId: "galaxy-s23", imei: imeiOn(S23U) });
  assert.equal(both.device?.modelId, "galaxy-s23");

  const d = fresh();
  const first = await cases.updateCase(adv, d.id, { imei: imeiOn(S23U) });
  assert.equal(first.device?.modelId, "galaxy-s23-ultra");
  await cases.updateCase(adv, d.id, { variant: "256GB" });
  const fixed = await cases.updateCase(adv, d.id, { imei: imeiOn(IP13) });
  assert.deepEqual([fixed.device?.modelId, fixed.modelSource, fixed.device?.variant], ["iphone-13", "imei", null], "the old IMEI's model and its storage go");
  const none = await cases.updateCase(adv, d.id, { imei: imeiOn("Apple Iphone 13 Pro Max") });
  assert.equal(none.device, null, "an IMEI that names no model on file leaves none — the old one had no basis left");
  assert.equal(none.modelSource, null);
});

test("GradeIQ off, or no server key: nothing is called — the TAC's model, blacklist 'unknown'; a misread IMEI is not resolved at all", async () => {
  const before = fake.calls.length;
  const off = await cases.updateCase(adv, fresh().id, { imei: imeiOn(S23U) });
  assert.equal(off.device?.modelId, "galaxy-s23-ultra");
  assert.deepEqual(off.imeiLookup, { brand: "Samsung", model: "Galaxy S23 Ultra", modelNumber: null, blacklist: "unknown", source: "tac", at: off.imeiLookup!.at });
  const noKey = await withGiq(() => cases.updateCase(adv, fresh().id, { imei: imeiOn(IP13) }), { GRADEIQ_SERVER_KEY: "" });
  assert.deepEqual([noKey.device?.modelId, noKey.imeiLookup?.blacklist, noKey.imeiLookup?.source], ["iphone-13", "unknown", "tac"]);
  assert.equal(fake.calls.length, before, "no call without the key");
  const good = imeiOn(S23U);
  const bad = good.slice(0, 14) + String((Number(good[14]) + 1) % 10);
  const misread = await withGiq(() => cases.updateCase(adv, fresh().id, { imei: bad }));
  assert.deepEqual([misread.imeiCheck, misread.imeiLookup, misread.device], ["invalid", null, null]);
  assert.equal(fake.calls.length, before, "a check-digit failure is never paid for");
  // An IMEI on no TAC the list knows: a record that knows nothing, still "not checked".
  const unknown = await cases.updateCase(adv, fresh().id, { imei: "352099001761481" });
  assert.deepEqual([unknown.device, unknown.imeiLookup?.brand, unknown.imeiLookup?.blacklist, unknown.imeiLookup?.source], [null, null, "unknown", "none"]);
});

test("GradeIQ slow or down: the save still answers (≤ the timeout), blacklist 'unknown', and that IMEI is not asked again", async () => {
  fake.mode = "slow";
  try {
    const c = fresh();
    const imei = imeiOn(S23U);
    const t0 = Date.now();
    const v = await withGiq(() => cases.updateCase(adv, c.id, { imei }), { GRADEIQ_IMEI_TIMEOUT_MS: "200" });
    assert.ok(Date.now() - t0 < 1400, `answered in ${Date.now() - t0} ms`);
    assert.deepEqual([v.device?.modelId, v.imeiLookup?.blacklist, v.imeiLookup?.source], ["galaxy-s23-ultra", "unknown", "tac"]);
    const n = imeiCalls().length;
    fake.mode = "ok";
    await withGiq(() => cases.updateCase(adv, c.id, { imei }));
    assert.equal(imeiCalls().length, n, "no retry for the same IMEI — not in the background either");
    fake.mode = "down";
    const down = await withGiq(() => cases.updateCase(adv, fresh().id, { imei: imeiOn(S23U) }));
    assert.equal(down.imeiLookup?.blacklist, "unknown");
  } finally {
    fake.mode = "ok";
  }
});

/* ─────────────────────────── I2.3: blacklisted stops the trade-in ─────────────────────────── */

test("blacklisted (GSMA): test sessions refuse 409 {error, reason:'blacklisted'}, the lock refuses with the same sentence, and leads the blockers", async () => {
  const imei = imeiOn(S23U);
  fake.infos.set(imei, { imei, brand: "Samsung", model: "Galaxy S23 Ultra", modelNumber: "SM-S918B", blacklist: "blacklisted", source: "gsma" });
  const c = fresh();
  const v = await withGiq(() => cases.updateCase(adv, c.id, { imei }));
  assert.equal(v.imeiLookup?.blacklist, "blacklisted");
  await cases.updateCase(adv, c.id, { variant: "256GB", faults: ["screen_cracked"], condition: COND, upgradeDeviceId: S26U_256 });
  const res = await handle(() => sessions.createTestSession(adv, { caseId: c.id }));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "This phone is reported lost or stolen. It can't be traded in.", reason: "blacklisted" });
  assert.equal((db().prepare(`SELECT COUNT(*) AS n FROM test_sessions WHERE case_id = ?`).get(c.id) as { n: number }).n, 0, "no session made");
  const priced = await cases.reprice(adv, c.id);
  assert.equal(priced.lockBlockers[0], BLACKLISTED);
  assert.throws(() => cases.lockTradeIn(adv, c.id, { customer: CUSTOMER, checks: CHECKS }), (e: Error & { status?: number; extra?: Record<string, string> }) => e.status === 409 && e.message === BLACKLISTED && e.extra?.reason === "blacklisted");
});

test("blacklisted is the CASE's, and sticky: GSMA's answer for any IMEI ever saved on it stops it — moved to IMEI 2, or gone — with no second paid lookup", async () => {
  const refused = (e: Error & { status?: number; extra?: Record<string, string> }) => e.status === 409 && e.message === BLACKLISTED && e.extra?.reason === "blacklisted";
  const x = imeiOn(S23U);
  const y = imeiOn(S23U);
  fake.infos.set(x, { imei: x, brand: "Samsung", model: "Galaxy S23 Ultra", modelNumber: "SM-S918B", blacklist: "blacklisted", source: "gsma" });
  fake.infos.set(y, { imei: y, brand: "Samsung", model: "Galaxy S23 Ultra", modelNumber: "SM-S918B", blacklist: "clean", source: "gsma" });
  const c = fresh();
  assert.equal((await withGiq(() => cases.updateCase(adv, c.id, { imei: x }))).imeiLookup?.blacklist, "blacklisted");
  // The advisor taps Change and re-scans *#06#: the camera decodes IMEI 2 first, so the clean
  // number lands in the IMEI 1 slot and the blacklisted one in IMEI 2.
  const n = imeiCalls().length;
  const swapped = await withGiq(() => cases.updateCase(adv, c.id, { imei: y, imei2: x }));
  assert.deepEqual(imeiCalls().slice(n).map((k) => k.path), [`/api/imei/${y}`], "only the new IMEI 1 is looked up — never a second lookup for IMEI 2");
  assert.equal(swapped.imeiLookup?.blacklist, "blacklisted", "the case's answer, not only IMEI 1's");
  assert.equal(swapped.imeiLookup?.model, "Galaxy S23 Ultra");
  assert.ok(swapped.imeiWarnings.includes(`IMEI 2 (${x}) is reported lost or stolen (GSMA).`), swapped.imeiWarnings.join(" | "));
  await cases.updateCase(adv, c.id, { variant: "256GB", faults: ["screen_cracked"], condition: COND, upgradeDeviceId: S26U_256 });
  assert.throws(() => sessions.createTestSession(adv, { caseId: c.id }), refused);
  const priced = await cases.reprice(adv, c.id);
  assert.equal(priced.lockBlockers[0], BLACKLISTED);
  assert.throws(() => cases.lockTradeIn(adv, c.id, { customer: CUSTOMER, checks: CHECKS }), refused);

  // Gone from the case, and pushed past the short list of answers by six later IMEIs: still stopped.
  for (let i = 0; i < 6; i++) await withGiq(() => cases.updateCase(adv, c.id, { imei: imeiOn(S23U), imei2: null }));
  const later = cases.getCase(adv, c.id);
  assert.deepEqual([later.imei2, later.imeiLookup?.blacklist], [null, "blacklisted"]);
  assert.ok(later.imeiWarnings.includes(`IMEI ${x}, saved on this case before, is reported lost or stolen (GSMA).`), later.imeiWarnings.join(" | "));
  assert.equal(later.lockBlockers[0], BLACKLISTED);
  assert.throws(() => sessions.createTestSession(adv, { caseId: c.id }), refused);
  assert.throws(() => cases.lockTradeIn(adv, c.id, { customer: CUSTOMER, checks: CHECKS }), refused);
  assert.equal((db().prepare(`SELECT COUNT(*) AS n FROM test_sessions WHERE case_id = ?`).get(c.id) as { n: number }).n, 0, "no session made");
});

/* ─────────────────────────── I2.4: early KYM, early duplicate warning ─────────────────────────── */

test("kymEarly: recorded with the advisor's name, needs an IMEI, refuses an unknown status; not clear → no tests; a new IMEI clears it", async () => {
  const c = fresh();
  await assert.rejects(cases.updateCase(adv, c.id, { kymEarly: { status: "clear", reference: "SS-1" } }), (e: Error & { status?: number }) => e.status === 400 && /IMEI first/.test(e.message));
  await cases.updateCase(adv, c.id, { imei: imeiOn(S23U) });
  await assert.rejects(cases.updateCase(adv, c.id, { kymEarly: { status: "toString" } }), (e: Error & { status?: number }) => e.status === 400);
  const v = await cases.updateCase(adv, c.id, { kymEarly: { status: "clear", reference: "  KYM-77  " } });
  assert.deepEqual(v.kymEarly, { status: "clear", reference: "KYM-77" });
  const stored = JSON.parse((db().prepare(`SELECT kym_early FROM cases WHERE id = ?`).get(c.id) as { kym_early: string }).kym_early);
  assert.equal(stored.by, adv.name);
  const ok = sessions.createTestSession(adv, { caseId: c.id });
  assert.equal(ok.session.caseId, c.id, "clear: the tests start");

  const d = fresh();
  await cases.updateCase(adv, d.id, { imei: imeiOn(S23U) });
  const flagged = await cases.updateCase(adv, d.id, { kymEarly: { status: "duplicate", reference: null } });
  assert.deepEqual(flagged.kymEarly, { status: "duplicate", reference: null });
  assert.throws(() => sessions.createTestSession(adv, { caseId: d.id }), (e: Error & { status?: number; extra?: Record<string, string> }) => e.status === 409 && e.extra?.reason === "blacklisted");
  const moved = await cases.updateCase(adv, d.id, { imei: imeiOn(S23U) });
  assert.equal(moved.kymEarly, null, "the answer was for the old number");
  const cleared = await cases.updateCase(adv, c.id, { kymEarly: null });
  assert.equal(cleared.kymEarly, null);
});

test("SUP-17: an early KYM answer — clear starts the tests; blacklisted, duplicate and in use each refuse in the register's own words; GSMA's sentence is unchanged", async () => {
  const said: Record<string, string> = {
    blacklisted: 'IMEI register says "Black-listed (reported lost/stolen)" — check it before testing.',
    duplicate: 'IMEI register says "Duplicate IMEI" — check it before testing.',
    in_use: 'IMEI register says "Already in use" — check it before testing.',
  };
  const ok = fresh();
  await cases.updateCase(adv, ok.id, { imei: imeiOn(S23U), kymEarly: { status: "clear", reference: "SS-17" } });
  assert.equal(sessions.createTestSession(adv, { caseId: ok.id }).session.caseId, ok.id, "clear: the tests start");
  for (const status of ["blacklisted", "duplicate", "in_use"] as const) {
    const c = fresh();
    await cases.updateCase(adv, c.id, { imei: imeiOn(S23U), kymEarly: { status, reference: null } });
    assert.throws(
      () => sessions.createTestSession(adv, { caseId: c.id }),
      (e: Error & { status?: number; extra?: Record<string, string> }) => e.status === 409 && e.message === said[status] && e.extra?.reason === "blacklisted",
      status
    );
    assert.equal((db().prepare(`SELECT COUNT(*) AS n FROM test_sessions WHERE case_id = ?`).get(c.id) as { n: number }).n, 0, `${status}: no session made`);
    if (status !== "blacklisted") assert.doesNotMatch(said[status], /lost or stolen/, status);
  }
  assert.equal(BLACKLISTED, "This phone is reported lost or stolen. It can't be traded in.", "GSMA's sentence, word for word");
});

test("at the lock, the advisor's KYM answer (it must be clear) supersedes a non-clear early one and is stored back; GSMA's blacklisted still refuses", async () => {
  const c = fresh();
  await cases.updateCase(adv, c.id, { modelId: "galaxy-s23-ultra", variant: "256GB", imei: imeiOn(S23U), faults: ["screen_cracked"], condition: COND, upgradeDeviceId: S26U_256 });
  // A mis-tap while the phone tested; the answer opened by itself, so the IMEI card is gone.
  await cases.updateCase(adv, c.id, { kymEarly: { status: "duplicate", reference: null } });
  const priced = await cases.reprice(adv, c.id);
  assert.deepEqual(priced.kymEarly, { status: "duplicate", reference: null });
  assert.ok(!priced.lockBlockers.includes(BLACKLISTED), `the lock's own KYM answer decides: ${priced.lockBlockers.join(" | ")}`);
  assert.deepEqual(priced.lockBlockers, []);
  assert.throws(() => sessions.createTestSession(adv, { caseId: c.id }), (e: Error & { status?: number }) => e.status === 409, "no new test on it, as before");
  // The lock's answer must itself be clear.
  assert.throws(() => cases.lockTradeIn(adv, c.id, { customer: CUSTOMER, checks: { ...CHECKS, kym: { status: "duplicate" as never, reference: null } } }), (e: Error & { status?: number }) => e.status === 409 && /IMEI register says/.test(e.message));
  const locked = cases.lockTradeIn(adv, c.id, { customer: CUSTOMER, checks: { ...CHECKS, kym: { status: "clear", reference: "SMS-OK-1" } } });
  assert.equal(locked.status, "locked");
  assert.deepEqual(locked.kymEarly, { status: "clear", reference: "SMS-OK-1" }, "stored back for the record");
  const stored = JSON.parse((db().prepare(`SELECT kym_early FROM cases WHERE id = ?`).get(c.id) as { kym_early: string }).kym_early);
  assert.deepEqual([stored.status, stored.reference, stored.by], ["clear", "SMS-OK-1", adv.name]);
  const rows = db().prepare(`SELECT detail FROM audit WHERE action = 'case.kym_early' AND entity_id = ? ORDER BY rowid`).all(c.id) as { detail: string }[];
  assert.deepEqual(JSON.parse(rows.at(-1)!.detail), { status: "clear", reference: "SMS-OK-1", supersedes: "duplicate", at: "lock" });

  // GSMA blacklisted, with a clear early KYM and a clear lock answer: still refused.
  const imei = imeiOn(S23U);
  fake.infos.set(imei, { imei, brand: "Samsung", model: "Galaxy S23 Ultra", modelNumber: "SM-S918B", blacklist: "blacklisted", source: "gsma" });
  const d = fresh();
  await withGiq(() => cases.updateCase(adv, d.id, { imei }));
  await cases.updateCase(adv, d.id, { variant: "256GB", faults: ["screen_cracked"], condition: COND, upgradeDeviceId: S26U_256, kymEarly: { status: "clear", reference: "SS-2" } });
  const bad = await cases.reprice(adv, d.id);
  assert.equal(bad.lockBlockers[0], BLACKLISTED);
  assert.throws(() => cases.lockTradeIn(adv, d.id, { customer: CUSTOMER, checks: CHECKS }), (e: Error & { status?: number; extra?: Record<string, string> }) => e.status === 409 && e.message === BLACKLISTED && e.extra?.reason === "blacklisted");
});

test("the duplicate is said as soon as the IMEI is saved (the lock still refuses); the partner gets no lookup and no warnings", async () => {
  const imei = imeiOn(S23U);
  const a = fresh();
  await cases.updateCase(adv, a.id, { modelId: "galaxy-s23-ultra", variant: "256GB", imei, faults: ["screen_cracked"], condition: COND, upgradeDeviceId: S26U_256 });
  const locked = cases.lockTradeIn(adv, a.id, { customer: CUSTOMER, checks: CHECKS });
  assert.deepEqual(locked.imeiWarnings, [], "a case past the counter isn't warned about itself");
  const b = await cases.updateCase(adv, fresh().id, { imei });
  assert.deepEqual(b.imeiWarnings, [`This IMEI is already on trade-in ${locked.ref}.`]);
  const asImei2 = await cases.updateCase(adv, fresh().id, { imei: imeiOn(S23U), imei2: imei });
  assert.deepEqual(asImei2.imeiWarnings, [`This IMEI is already on trade-in ${locked.ref}.`], "either number");
  const seen = cases.getCase(partner, a.id);
  assert.deepEqual([seen.imeiLookup, seen.imeiWarnings], [null, []]);
  assert.ok(cases.getCase(adv, a.id).imeiLookup, "staff still see it");
});

test("a new IMEI 1 without an IMEI 2 clears the old phone's IMEI 2; an IMEI 1 equal to the case's IMEI 2 is a clear 400", async () => {
  const [a, b, c1, d] = [imeiOn(S23U), imeiOn(S23U), imeiOn(S23U), imeiOn(S23U)];
  const c = fresh();
  await cases.updateCase(adv, c.id, { imei: a, imei2: b });
  // "Change IMEI": another phone's IMEI 1, typed (no IMEI 2 sent).
  const changed = await cases.updateCase(adv, c.id, { imei: c1 });
  assert.deepEqual([changed.imei, changed.imei2, changed.imei2Check], [c1, null, null], "the old phone's IMEI 2 goes with its IMEI 1");
  // The same IMEI 1 saved again is no change: IMEI 2 stays.
  await cases.updateCase(adv, c.id, { imei2: d });
  const same = await cases.updateCase(adv, c.id, { imei: c1 });
  assert.deepEqual([same.imei, same.imei2, same.imei2Check], [c1, d, "valid"]);
  // IMEI 1 = the case's IMEI 2, with no IMEI 2 sent: refused, nothing changes, nothing is paid for.
  const n = imeiCalls().length;
  await assert.rejects(withGiq(() => cases.updateCase(adv, c.id, { imei: d })), (e: Error & { status?: number }) => e.status === 400 && e.message === "IMEI 1 can't be the same as IMEI 2 — that number is this case's IMEI 2.");
  assert.equal(imeiCalls().length, n, "a refused save is never looked up");
  const kept = cases.getCase(adv, c.id);
  assert.deepEqual([kept.imei, kept.imei2], [c1, d]);
  // Both numbers sent: swapped, as asked.
  const swapped = await cases.updateCase(adv, c.id, { imei: d, imei2: c1 });
  assert.deepEqual([swapped.imei, swapped.imei2], [d, c1]);
  // IMEI 1 cleared: IMEI 2 goes too.
  const cleared = await cases.updateCase(adv, c.id, { imei: null });
  assert.deepEqual([cleared.imei, cleared.imei2, cleared.imei2Check], [null, null, null]);

  // Apply filling IMEI 1 on a case that has only an IMEI 2 keeps both numbers, never one twice.
  const [z, y] = [imeiOn(S23U), imeiOn(S23U)];
  const e = fresh();
  await cases.updateCase(adv, e.id, { imei2: z });
  const s = sessions.createTestSession(adv, { caseId: e.id });
  const j = joinWith(s.session.code, { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", totalDiskBytes: 256e9, isPhysicalDevice: true }, "0.9.0");
  sessions.deviceDeclare(`Ticket ${j.ticket}`, { imei: z, imei2: y });
  await runTests(`Ticket ${j.ticket}`, s.session.id);
  const w = cases.getCase(adv, e.id);
  assert.deepEqual([w.imei, w.imei2], [z, y]);
});

test("PATCH /api/cases/<id> {imei, imei2} answers with the case view and its new fields", async () => {
  const c = fresh();
  const imei = imeiOn(S23U);
  fake.infos.set(imei, { imei, brand: "Samsung", model: "Galaxy S23 Ultra", modelNumber: "SM-S918B", blacklist: "clean", source: "gsma" });
  const res = await withGiq(() =>
    asUser(adv, () => caseRoute.PATCH(new Request(`http://x/api/cases/${c.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ imei, imei2: null }) }), { params: Promise.resolve({ id: c.id }) }))
  );
  assert.equal(res.status, 200);
  const v = (await res.json()) as Record<string, unknown>;
  assert.equal(v.modelSource, "imei");
  assert.deepEqual(Object.keys(v.imeiLookup as object).sort(), ["at", "blacklist", "brand", "model", "modelNumber", "source"]);
  assert.deepEqual(v.imeiWarnings, []);
  assert.equal(v.kymEarly, null);
});

/* ─────────────────────────── I2.5: join and Apply prefer the case's model ─────────────────────────── */

function joinWith(sessionCode: string, device: Record<string, unknown>, appVersion: string) {
  return sessions.joinByCode({ code: sessionCode, installId: `install-${Math.random().toString(36).slice(2, 12)}`, appVersion, device }, "127.0.0.1");
}
async function runTests(ticket: string, sessionId: string) {
  const at = new Date().toISOString();
  sessions.deviceResults(ticket, { results: DEFAULT_PLAN.filter((p) => p.id !== "battery_health").map((p) => ({ testId: p.id, outcome: "pass", at, detail: null })) });
  sessions.deviceComplete(ticket);
  await sessions.applyTestSession(adv, sessionId).catch(() => undefined); // auto-apply may have won the race
}

test("join: a browser iPhone on a case whose IMEI named the model is told that model — no customer picker", async () => {
  const c = fresh();
  await cases.updateCase(adv, c.id, { imei: imeiOn(IP13) });
  const s = sessions.createTestSession(adv, { caseId: c.id });
  const j = joinWith(s.session.code, { brand: "Apple", manufacturer: "Apple", modelName: "iPhone", osVersion: "17.5", isPhysicalDevice: true }, "web-0.9.0");
  assert.deepEqual([j.session.identity.match, j.session.identity.modelId, j.session.identity.label], ["exact", "iphone-13", "Apple iPhone 13"]);
  assert.deepEqual(j.session.identity.variants, ["128GB", "256GB"], "the storage is still asked: the IMEI never says it");
  // A case with no model: the phone's own answer, as before.
  const none = sessions.createTestSession(adv, { customerName: "B" });
  const jn = joinWith(none.session.code, { brand: "Apple", manufacturer: "Apple", modelName: "iPhone", osVersion: "17.5", isPhysicalDevice: true }, "web-0.9.0");
  assert.equal(jn.session.identity.match, "none");
});

test("Apply: a phone code that DISAGREES with the IMEI's model is a flag, not an overwrite; one that agrees makes the model the phone's", async () => {
  const c = fresh();
  await cases.updateCase(adv, c.id, { imei: imeiOn(S23U) });
  const s = sessions.createTestSession(adv, { caseId: c.id });
  const j = joinWith(s.session.code, { brand: "samsung", manufacturer: "samsung", modelName: "SM-S911B", modelCode: "SM-S911B", osVersion: "14", totalDiskBytes: 128e9, isPhysicalDevice: true }, "0.9.0");
  assert.equal(j.session.identity.modelId, "galaxy-s23-ultra", "join shows the IMEI's model");
  await runTests(`Ticket ${j.ticket}`, s.session.id);
  const v = cases.getCase(adv, c.id);
  assert.equal(v.device?.modelId, "galaxy-s23-ultra", "not overwritten");
  assert.equal(v.modelSource, "imei");
  assert.equal(v.device?.variant, null, "the other model's storage is not put on this one");
  assert.ok(v.camera?.flags.includes("Model: phone code says Samsung Galaxy S23; the IMEI says Samsung Galaxy S23 Ultra — check Settings › About phone."), v.camera?.flags.join(" | "));

  const d = fresh();
  await cases.updateCase(adv, d.id, { imei: imeiOn(S23U) });
  const s2 = sessions.createTestSession(adv, { caseId: d.id });
  const j2 = joinWith(s2.session.code, { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", totalDiskBytes: 256e9, isPhysicalDevice: true }, "0.9.0");
  await runTests(`Ticket ${j2.ticket}`, s2.session.id);
  const w = cases.getCase(adv, d.id);
  assert.deepEqual([w.device?.modelId, w.modelSource, w.device?.variant, w.variantSource], ["galaxy-s23-ultra", "phone", "256GB", "measured"]);
  assert.ok(!w.camera?.flags.some((f) => f.startsWith("Model:")), w.camera?.flags.join(" | "));
});

test("Apply: a phone whose code names nothing, joined on the IMEI's model, settles that model's storage from its own reading ('measured')", async () => {
  const c = fresh();
  const named = await cases.updateCase(adv, c.id, { imei: imeiOn("Oneplus 12") });
  assert.deepEqual([named.device?.modelId, named.modelSource], ["oneplus-12", "imei"]);
  const s = sessions.createTestSession(adv, { caseId: c.id });
  const j = joinWith(s.session.code, { brand: "OnePlus", manufacturer: "OnePlus", modelName: "CPH2581", osVersion: "14", totalDiskBytes: 256e9, isPhysicalDevice: true }, "0.9.0");
  assert.deepEqual([j.session.identity.match, j.session.identity.modelId, j.session.identity.variant], ["exact", "oneplus-12", "256GB"], "no picker: the Check app sends no pick");
  await runTests(`Ticket ${j.ticket}`, s.session.id);
  const v = cases.getCase(adv, c.id);
  assert.deepEqual([v.device?.modelId, v.modelSource, v.device?.variant, v.variantSource], ["oneplus-12", "imei", "256GB", "measured"]);
  assert.ok(!v.camera?.flags.some((f) => f.startsWith("Storage:") || f.startsWith("Model:")), v.camera?.flags.join(" | "));
});

test("a case with no IMEI joins exactly as 0.8.0: staff's model is not told to the phone, and a pick settles the measured storage", async () => {
  const vivo = { brand: "vivo", manufacturer: "vivo", modelName: "V2250", osVersion: "14", totalDiskBytes: 128e9, isPhysicalDevice: true };
  const c = fresh();
  await cases.updateCase(adv, c.id, { modelId: "vivo-v29", variant: "256GB" });
  const s = sessions.createTestSession(adv, { caseId: c.id });
  const j = joinWith(s.session.code, vivo, "0.9.0");
  assert.deepEqual([j.session.identity.match, j.session.identity.modelId], ["none", null], "the phone's own answer: the customer's picker");
  sessions.deviceDeclare(`Ticket ${j.ticket}`, { identityConfirmed: null, picked: { modelId: "vivo-v29", variant: null } });
  await runTests(`Ticket ${j.ticket}`, s.session.id);
  const v = cases.getCase(adv, c.id);
  assert.deepEqual([v.device?.modelId, v.device?.variant, v.variantSource], ["vivo-v29", "128GB", "measured"], "the phone's reading beats staff's 256GB");

  // No pick: staff's size stands, as before — the case's model is not used to settle storage.
  const d = fresh();
  await cases.updateCase(adv, d.id, { modelId: "vivo-v29", variant: "256GB" });
  const s2 = sessions.createTestSession(adv, { caseId: d.id });
  const j2 = joinWith(s2.session.code, vivo, "0.9.0");
  assert.equal(j2.session.identity.match, "none");
  await runTests(`Ticket ${j2.ticket}`, s2.session.id);
  const w = cases.getCase(adv, d.id);
  assert.deepEqual([w.device?.modelId, w.modelSource, w.device?.variant, w.variantSource], ["vivo-v29", "advisor", "256GB", "advisor"]);
});

/* ─────────────────────────── I3: POST /api/imei/read ─────────────────────────── */

const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
async function read(body: unknown, env: Record<string, string> = {}, u: U = adv) {
  const res = await withGiq(
    () => asUser(u, () => readRoute.POST(new Request("http://x/api/imei/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))),
    env
  );
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

test("/api/imei/read: GradeIQ's stateless reader (never a session's /ocr), with the key → {imei, imei2, valid}", async () => {
  const imei = imeiOn(S23U);
  fake.ocr = { imei, error: null };
  const before = fake.calls.length;
  assert.deepEqual(await read({ photo: PHOTO }), { status: 200, data: { imei, imei2: null, valid: true } });
  const call = fake.calls.slice(before);
  assert.deepEqual(call.map((x) => [x.method, x.path, x.keyOk, x.body]), [["POST", "/api/imei/ocr", true, { photo: PHOTO }]]);
  const bad = imei.slice(0, 14) + String((Number(imei[14]) + 1) % 10);
  fake.ocr = { imei: bad, imei2: imei, error: null };
  assert.deepEqual((await read({ photo: PHOTO })).data, { imei: bad, imei2: imei, valid: false }, "read, not trusted: the app asks to confirm");
  assert.ok(!fake.calls.some((x) => /\/api\/sessions\//.test(x.path)), "no GradeIQ session is touched");
});

test("/api/imei/read: nothing found → 422 not_found; the reader off, no key, slow or down → 503 reader_off; bad body → 400; staff only", async () => {
  fake.ocr = { imei: "", error: "not_found" };
  assert.deepEqual(await read({ photo: PHOTO }), { status: 422, data: { error: NO_IMEI_IN_PHOTO, reason: "not_found" } });
  assert.equal(NO_IMEI_IN_PHOTO, "No IMEI found in that photo — try again or type it.");
  fake.ocr = { imei: "", error: "bad_image" };
  assert.equal((await read({ photo: PHOTO })).status, 422);
  const off = { status: 503, data: { error: READER_OFF, reason: "reader_off" } };
  assert.equal(READER_OFF, "The screen reader is off — scan or type the IMEI.");
  for (const error of ["ai_quota", "ai_key", "ai_error", "ai_not_configured"]) {
    fake.ocr = { imei: "", error };
    assert.deepEqual(await read({ photo: PHOTO }), off, error);
  }
  const n = fake.calls.length;
  assert.deepEqual(await read({ photo: PHOTO }, { GRADEIQ_SERVER_KEY: "" }), off, "no key");
  assert.deepEqual(await read({ photo: PHOTO }, { GRADEIQ_ENABLED: "0" }), off, "GradeIQ off");
  assert.equal(fake.calls.length, n, "neither calls GradeIQ");
  fake.mode = "slow";
  try {
    assert.deepEqual(await read({ photo: PHOTO }, { GRADEIQ_IMEI_OCR_TIMEOUT_MS: "200" }), off, "slow");
    fake.mode = "down";
    assert.deepEqual(await read({ photo: PHOTO }), off, "down");
  } finally {
    fake.mode = "ok";
  }
  assert.equal((await read({ photo: "https://example.com/x.jpg" })).status, 400);
  assert.equal((await read({})).status, 400);
  assert.equal((await read({ photo: PHOTO }, {}, partner)).status, 403);
});

/* ─────────────────────────── SUP-35: the IMEI first on the desk ─────────────────────────── */

const casesRoute = await import("../../app/api/cases/route.ts");
const desk = await import("../../components/counter/imeiFirst.ts");

/** The desk's fetch (lib/client/api.ts), served by the REAL route handlers, as the advisor. */
const deskCall: import("../../components/counter/imeiFirst.ts").Call = async <T,>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> => {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const req = new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const id = /^\/api\/cases\/([^/]+)$/.exec(path)?.[1];
  const ctx = { params: Promise.resolve({ id: decodeURIComponent(id ?? "") }) };
  const res = await asUser(adv, () =>
    path === "/api/cases" && method === "POST"
      ? casesRoute.POST(req)
      : path === "/api/imei/read"
        ? readRoute.POST(req)
        : id && method === "PATCH"
          ? caseRoute.PATCH(req, ctx)
          : id
            ? caseRoute.GET(req, ctx)
            : Promise.reject(new Error(`no route for ${method} ${path}`))
  );
  const data = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
};
const sessionsFor = (caseId: string) => (db().prepare(`SELECT COUNT(*) AS n FROM test_sessions WHERE case_id = ?`).get(caseId) as { n: number }).n;

test("desk New trade-in: Read the screen → Start (POST /api/cases → the app's PATCH {imei, imei2}) → the case shows the IMEI's model and GSMA's word before any test", async () => {
  const [imei, imei2] = [imeiOn(S23U), imeiOn(S23U)];
  fake.infos.set(imei, { imei, brand: "Samsung", model: "Galaxy S23 Ultra", modelNumber: "SM-S918B", blacklist: "clean", source: "gsma" });
  fake.ocr = { imei, imei2, error: null };
  const read = desk.readImeiRead(await withGiq(() => deskCall("/api/imei/read", { body: { photo: PHOTO } })));
  assert.deepEqual(read, { imei, imei2, valid: true });
  const before = imeiCalls().length;
  const r = await withGiq(() => desk.startCase(deskCall, { customerName: "Meera Iyer", customerPhone: "9820012345", imei: { imei: read!.imei, imei2: read!.imei2 }, caseId: null }));
  assert.equal(r.error, null);
  const v = cases.getCase(adv, r.caseId!);
  assert.deepEqual([v.customer?.name, v.customer?.phone, v.imei, v.imei2, v.imeiCheck], ["Meera Iyer", "9820012345", imei, imei2, "valid"]);
  assert.deepEqual([v.device?.modelId, v.modelSource, v.device?.variant], ["galaxy-s23-ultra", "imei", null]);
  assert.deepEqual(desk.imeiFound(v), { line: "Galaxy S23 Ultra · not blacklisted (GSMA)", tone: "up", modelFromImei: true, warnings: [], stop: null });
  assert.equal(imeiCalls().length, before + 1, "one paid lookup, for IMEI 1");
  assert.equal(sessionsFor(r.caseId!), 0, "all of it before any test");
});

test("desk New trade-in: an IMEI already traded in is warned at once; a blacklisted one opens on the stop; a bad check digit is kept but never looked up (never paid for)", async () => {
  // Already on a trade-in: said the moment the desk's case opens.
  const imei = imeiOn(S23U);
  const a = fresh();
  await cases.updateCase(adv, a.id, { modelId: "galaxy-s23-ultra", variant: "256GB", imei, faults: ["screen_cracked"], condition: COND, upgradeDeviceId: S26U_256 });
  const locked = cases.lockTradeIn(adv, a.id, { customer: CUSTOMER, checks: CHECKS });
  const dup = await desk.startCase(deskCall, { customerName: "", customerPhone: null, imei: { imei, imei2: null }, caseId: null });
  assert.deepEqual(desk.imeiFound(cases.getCase(adv, dup.caseId!)).warnings, [`This IMEI is already on trade-in ${locked.ref}.`]);

  // GSMA says blacklisted: the case opens on the stop; no test can start.
  const stolen = imeiOn(S23U);
  fake.infos.set(stolen, { imei: stolen, brand: "Samsung", model: "Galaxy S23 Ultra", modelNumber: "SM-S918B", blacklist: "blacklisted", source: "gsma" });
  const s = await withGiq(() => desk.startCase(deskCall, { customerName: "", customerPhone: null, imei: { imei: stolen, imei2: null }, caseId: null }));
  const sv = cases.getCase(adv, s.caseId!);
  const found = desk.imeiFound(sv);
  assert.deepEqual([found.line, found.tone, found.stop], ["Galaxy S23 Ultra · reported lost or stolen (GSMA)", "bad", desk.STOP_GSMA]);
  assert.equal((await handle(() => sessions.createTestSession(adv, { caseId: s.caseId! }))).status, 409);

  // A check digit that fails: the form warns; recorded anyway it is saved as typed, never looked up.
  const good = imeiOn(S23U);
  const bad = good.slice(0, 14) + String((Number(good[14]) + 1) % 10);
  assert.deepEqual(desk.imeiEntry(bad), { imei: bad, warn: desk.BAD_CHECK_DIGIT, problem: desk.BAD_CHECK_START });
  const entry = desk.imeiEntry(bad, true);
  const n = fake.calls.length;
  const m = await withGiq(() => desk.startCase(deskCall, { customerName: "", customerPhone: null, imei: { imei: entry.imei!, imei2: null }, caseId: null }));
  const mv = cases.getCase(adv, m.caseId!);
  assert.deepEqual([mv.imei, mv.imeiCheck, mv.imeiLookup, mv.device], [bad, "invalid", null, null]);
  assert.equal(desk.imeiFound(mv).line, desk.NOT_LOOKED_UP);
  assert.equal(fake.calls.length, n, "a check-digit failure is never paid for");
});

test("desk New trade-in: a failed IMEI save keeps the case it opened; Start again saves the customer and the IMEI on it — never a second case", async () => {
  const count = () => (db().prepare(`SELECT COUNT(*) AS n FROM cases`).get() as { n: number }).n;
  const n0 = count();
  const twin = imeiOn(S23U);
  // IMEI 1 the same as IMEI 2: the server's 400, said on the form.
  const r = await desk.startCase(deskCall, { customerName: "Asha", customerPhone: null, imei: { imei: twin, imei2: twin }, caseId: null });
  assert.equal(r.error, "IMEI 2 can't be the same as IMEI 1.");
  assert.ok(r.caseId);
  assert.equal(count(), n0 + 1);
  const again = await desk.startCase(deskCall, { customerName: "Asha Rao", customerPhone: "9820012345", imei: { imei: twin, imei2: null }, caseId: r.caseId });
  assert.deepEqual(again, { caseId: r.caseId, error: null });
  assert.equal(count(), n0 + 1, "never a second case");
  const v = cases.getCase(adv, r.caseId!);
  assert.deepEqual([v.customer?.name, v.customer?.phone, v.imei, v.device?.modelId], ["Asha Rao", "9820012345", twin, "galaxy-s23-ultra"]);
});
