/**
 * Review 0.9.4 — the model from the IMEI, the cases the review found wrong (SUP-258 follow-up), through
 * the REAL server services on a throwaway database against a stand-in GradeIQ on 127.0.0.1 (no real
 * network, its IMEI route only):
 *
 *   - a TAC name that names no phone (a brand alone — "Samsung" on 9,559 TACs — or a series) is "no
 *     model", never "not on SwapUp's list": the phone's own code prices it;
 *   - a plain TAC name whose 5G phone is on the list (A16) and "Galaxy S26 Pro" are ambiguous, and a
 *     type-code name alone never overrules the phone's exact maker code; GSMA's own name still does;
 *   - a phone whose code disagrees with the IMEI never settles the IMEI model's storage;
 *   - with an IMEI on the case and a model already on it, the customer is never asked "Which phone is
 *     this?" — the store's model is told; an unconfirmed family code never overwrites it at Apply;
 *   - GSMA's name (Phonecheck) wins over the type code and both are said; GradeIQ's made-up "stub"
 *     answers and its own TAC fallback are never read as GSMA's.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/imeiReview.server.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const dir = mkdtempSync(join(tmpdir(), "swapup-imeireview-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
process.env.SWAPUP_CHECK_MIN_VERSION = "off";
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_") || k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_") || k.startsWith("GRADEIQ_IMEI")) delete process.env[k];
delete process.env.GRADEIQ_SERVER_KEY;

/* ─────────────────────────── a stand-in GradeIQ (GET /api/imei/<imei> only) ─────────────────────────── */

const KEY = "giq_server_test_key_review_00000000000";
const infos = new Map<string, Record<string, unknown>>();
const server = createServer((req, res) => {
  const m = /^\/api\/imei\/(\d{15})$/.exec((req.url || "").split("?")[0]);
  const ok = req.headers["x-gradeiq-server-key"] === KEY;
  res.writeHead(ok && m ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify(ok && m ? (infos.get(m[1]) ?? { brand: "", model: `Unknown device (TAC ${m[1].slice(0, 8)})`, blacklist: "unknown", source: "stub" }) : { error: "no" }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.GRADEIQ_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function withGiq<T>(fn: () => Promise<T>): Promise<T> {
  Object.assign(process.env, { GRADEIQ_ENABLED: "1", GRADEIQ_SERVER_KEY: KEY });
  try {
    return await fn();
  } finally {
    process.env.GRADEIQ_ENABLED = "0";
    delete process.env.GRADEIQ_SERVER_KEY;
  }
}

const origLog = console.log;
const origError = console.error;
console.log = () => {};
console.error = () => {};

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const cases = await import("./cases.ts");
const sessions = await import("./testSessions.ts");
const { IMEI_NAMES_NO_MODEL, imeiUnlistedSentence } = await import("./imeiResolve.ts");
const { CANT_PRICE } = await import("../domain/answer.ts");
const { DEFAULT_PLAN } = await import("../domain/diagnostics.ts");
const { luhnCheckDigit } = await import("../domain/imei.ts");

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
{
  const { uploadRateCard } = await import("./catalog.ts");
  const { DEFECT_DEDUCTIONS } = await import("../domain/ratecard.ts");
  uploadRateCard(partner, {
    label: "Week 43 (review)",
    effectiveFrom: "2026-10-19",
    quoteValidityDays: 3,
    csv: "model_id,variant,max_price\ngalaxy-s23-ultra,256GB,40000\ngalaxy-s23-plus,256GB,30000\ngalaxy-a16-5g,128GB,12000\ngalaxy-s26-plus,256GB,60000\niphone-13,128GB,30000\n",
    deductions: DEFECT_DEDUCTIONS,
    activate: true,
  });
}

/* IMEIs on real TACs (the offline list's first TAC for each name), each one new. */
const TACS = JSON.parse(readFileSync(new URL("../domain/tacdb.json", import.meta.url), "utf8")) as Record<string, string>;
const tacFor = (name: string) => Object.keys(TACS).find((t) => TACS[t] === name)!;
let seq = 0;
const imeiOnTac = (tac: string) => {
  const body = `${tac}${String(300000 + ++seq).slice(-6)}`;
  return body + String(luhnCheckDigit(body));
};
const imeiOn = (name: string) => imeiOnTac(tacFor(name));

const fresh = () => cases.createCase(adv, { customerName: "Review", customerPhone: "9820012345" });
const joinWith = (code: string, device: Record<string, unknown>, appVersion: string) =>
  sessions.joinByCode({ code, installId: `install-${Math.random().toString(36).slice(2, 12)}`, appVersion, device }, "127.0.0.1");
async function runTests(ticket: string, sessionId: string) {
  const at = new Date().toISOString();
  sessions.deviceResults(ticket, { results: DEFAULT_PLAN.filter((p) => p.id !== "battery_health").map((p) => ({ testId: p.id, outcome: "pass", at, detail: null })) });
  sessions.deviceComplete(ticket);
  await sessions.applyTestSession(adv, sessionId).catch(() => undefined);
}
const customerText = (caseId: string) => {
  const a = cases.deviceAnswer(caseId);
  return a && !a.ready ? a.text : null;
};
const stored = (caseId: string) => {
  const r = db().prepare(`SELECT imei, imei_lookup FROM cases WHERE id = ?`).get(caseId) as { imei: string; imei_lookup: string };
  return (JSON.parse(r.imei_lookup) as Record<string, unknown>[]).find((l) => l.imei === r.imei)!;
};
const samsung = (code: string, bytes: number) => ({ brand: "samsung", manufacturer: "samsung", modelName: code, modelCode: code, osVersion: "16", totalDiskBytes: bytes, isPhysicalDevice: true });
const IPHONE_BROWSER = { brand: "Apple", manufacturer: "Apple", modelName: "iPhone", modelCode: null, osVersion: "18.6", isPhysicalDevice: true };
const modelFlags = (c: { camera?: { flags: string[] } | null }) => (c.camera?.flags ?? []).filter((f) => f.startsWith("Model"));

/* ─────────────────────────── a name that names no phone ─────────────────────────── */

test("review 0.9.4 (brand-only): a bare \"Samsung\" TAC, GradeIQ off, a native SM-S918B 256 GB — the S23 Ultra, measured, priced; no 'not on SwapUp's list'", async () => {
  assert.equal(TACS["35004426"], "Samsung");
  const c = fresh();
  const v = await cases.updateCase(adv, c.id, { imei: imeiOnTac("35004426") });
  assert.equal(v.device, null);
  assert.deepEqual(v.imeiWarnings, [IMEI_NAMES_NO_MODEL]);
  assert.notEqual(customerText(c.id), CANT_PRICE);
  const s = sessions.createTestSession(adv, { caseId: c.id });
  const j = joinWith(s.session.code, samsung("SM-S918B", 256e9), "0.9.3");
  assert.deepEqual([j.session.identity.match, j.session.identity.modelId], ["exact", "galaxy-s23-ultra"], "the phone's own code");
  await runTests(`Ticket ${j.ticket}`, s.session.id);
  const a = cases.getCase(adv, c.id);
  assert.deepEqual([a.device?.modelId, a.device?.variant, a.variantSource, a.modelSource], ["galaxy-s23-ultra", "256GB", "measured", "phone"]);
  assert.equal(a.offer?.swap.tradeIn, 34800, "priced as base 4647c0b priced it");
  assert.deepEqual(modelFlags(a), []);
  assert.deepEqual(a.imeiWarnings, []);
  assert.notEqual(customerText(c.id), CANT_PRICE);
});

test("review 0.9.4 (brand-only): GradeIQ's own TAC fallback {Samsung, Samsung, source tac} is not GSMA — the same; a phone code set first then that IMEI: no false warnings", async () => {
  const imei = imeiOnTac("35004426");
  infos.set(imei, { brand: "Samsung", model: "Samsung", modelNumber: null, blacklist: "unknown", source: "tac" });
  const c = fresh();
  const v = await withGiq(() => cases.updateCase(adv, c.id, { imei }));
  assert.deepEqual([v.device, v.imeiWarnings], [null, [IMEI_NAMES_NO_MODEL]]);
  assert.equal(stored(c.id).modelKind, "none");
  const s = sessions.createTestSession(adv, { caseId: c.id });
  const j = joinWith(s.session.code, samsung("SM-S918B", 256e9), "0.9.3");
  await runTests(`Ticket ${j.ticket}`, s.session.id);
  assert.equal(cases.getCase(adv, c.id).offer?.swap.tradeIn, 34800);

  // The phone's code set the S23 Ultra first (a case with no IMEI), the bare-"Samsung" IMEI saved after.
  const d = fresh();
  const s2 = sessions.createTestSession(adv, { caseId: d.id });
  const j2 = joinWith(s2.session.code, samsung("SM-S918B", 256e9), "0.9.3");
  await runTests(`Ticket ${j2.ticket}`, s2.session.id);
  const w = await cases.updateCase(adv, d.id, { imei: imeiOnTac("35004426") });
  assert.deepEqual([w.device?.modelId, w.imeiWarnings], ["galaxy-s23-ultra", []]);
});

test("review 0.9.4 (brand-only): an iPhone on a bare \"Apple\" TAC in the browser — 'Your phone' (no picker), never CANT_PRICE; the advisor chooses", async () => {
  const c = fresh();
  const v = await cases.updateCase(adv, c.id, { imei: imeiOn("Apple") });
  assert.deepEqual([v.device, v.imeiWarnings], [null, [IMEI_NAMES_NO_MODEL]]);
  const s = sessions.createTestSession(adv, { caseId: c.id });
  const j = joinWith(s.session.code, IPHONE_BROWSER, "web-0.9.3");
  assert.deepEqual([j.session.identity.match, j.session.identity.modelId, j.session.identity.label], ["exact", null, "Your phone"]);
  await runTests(`Ticket ${j.ticket}`, s.session.id);
  assert.notEqual(customerText(c.id), CANT_PRICE);
  assert.deepEqual(cases.getCase(adv, c.id).offer?.asks.map((a) => a.kind), ["model"], "the advisor's one question");
});

/* ─────────────────────────── a TAC name alone never overrules the phone's exact code ─────────────────────────── */

test("review 0.9.4 (TAC-only): a Galaxy A16 5G (SM-A166P) on a plain 'Samsung Galaxy A16' TAC — ambiguous, the phone's code decides, priced", async () => {
  const c = fresh();
  const v = await cases.updateCase(adv, c.id, { imei: imeiOn("Samsung Galaxy A16") });
  assert.deepEqual([v.device, v.imeiWarnings], [null, [IMEI_NAMES_NO_MODEL]], "never 'not on SwapUp's list'");
  const s = sessions.createTestSession(adv, { caseId: c.id });
  const j = joinWith(s.session.code, samsung("SM-A166P", 128e9), "0.9.3");
  assert.deepEqual([j.session.identity.match, j.session.identity.modelId], ["exact", "galaxy-a16-5g"]);
  await runTests(`Ticket ${j.ticket}`, s.session.id);
  const a = cases.getCase(adv, c.id);
  assert.deepEqual([a.device?.modelId, a.device?.variant], ["galaxy-a16-5g", "128GB"]);
  assert.ok(a.offer?.swap.tradeIn && a.offer.swap.tradeIn > 0, String(a.offer?.swap.tradeIn));
  assert.deepEqual(modelFlags(a), []);
});

test("review 0.9.4 (TAC-only): an S26+ (SM-S947B) whose TAC says 'Galaxy S26 Pro' — ambiguous until the owner decides; the code prices it", async () => {
  const c = fresh();
  const v = await cases.updateCase(adv, c.id, { imei: imeiOn("Samsung Galaxy S26 Pro") });
  assert.deepEqual([v.device, v.imeiWarnings], [null, [IMEI_NAMES_NO_MODEL]]);
  const s = sessions.createTestSession(adv, { caseId: c.id });
  const j = joinWith(s.session.code, samsung("SM-S947B", 256e9), "0.9.3");
  await runTests(`Ticket ${j.ticket}`, s.session.id);
  const a = cases.getCase(adv, c.id);
  assert.deepEqual([a.device?.modelId, a.device?.variant], ["galaxy-s26-plus", "256GB"]);
  assert.ok(a.offer?.swap.tradeIn && a.offer.swap.tradeIn > 0);
  assert.notEqual(customerText(c.id), CANT_PRICE);
});

test("review 0.9.4 (TAC-only): a type-code name of a phone SwapUp doesn't list never overrules an EXACT code — the code is used and flagged; GSMA naming it does overrule (the owner's rule)", async () => {
  // The offline list alone: the phone's maker code wins.
  const c = fresh();
  await cases.updateCase(adv, c.id, { imei: imeiOn("Samsung Galaxy S10") });
  const s = sessions.createTestSession(adv, { caseId: c.id });
  const j = joinWith(s.session.code, samsung("SM-S918B", 256e9), "0.9.3");
  assert.deepEqual([j.session.identity.match, j.session.identity.modelId], ["exact", "galaxy-s23-ultra"], "the phone's own answer, not 'Samsung Galaxy S10, can't be priced'");
  await runTests(`Ticket ${j.ticket}`, s.session.id);
  const a = cases.getCase(adv, c.id);
  assert.deepEqual([a.device?.modelId, a.modelSource, a.device?.variant], ["galaxy-s23-ultra", "phone", "256GB"]);
  assert.deepEqual(modelFlags(a), ["Model: the IMEI's type code says Samsung Galaxy S10, not on SwapUp's list; the phone's code says Samsung Galaxy S23 Ultra — the code is used."]);
  assert.deepEqual(a.imeiWarnings, ["The IMEI says Samsung Galaxy S10, which isn't on SwapUp's list; the case has Samsung Galaxy S23 Ultra — check Settings › About phone."]);
  assert.equal(a.offer?.swap.tradeIn, 34800);
  // An iPhone in the browser has no code: the type code's name stands — exact, no model, CANT_PRICE.
  const i = fresh();
  await cases.updateCase(adv, i.id, { imei: imeiOn("Apple Iphone 13 Mini") });
  const si = sessions.createTestSession(adv, { caseId: i.id });
  const ji = joinWith(si.session.code, IPHONE_BROWSER, "web-0.9.3");
  assert.deepEqual([ji.session.identity.match, ji.session.identity.modelId, ji.session.identity.label], ["exact", null, "Apple iPhone 13 Mini"]);

  // GSMA (Phonecheck) named the phone: it decides, over the code.
  const imei = imeiOn("Samsung Galaxy S10");
  infos.set(imei, { brand: "Samsung", model: "Galaxy S10", modelNumber: null, blacklist: "clean", source: "gsma" });
  const d = fresh();
  await withGiq(() => cases.updateCase(adv, d.id, { imei }));
  const s2 = sessions.createTestSession(adv, { caseId: d.id });
  const j2 = joinWith(s2.session.code, samsung("SM-S918B", 256e9), "0.9.3");
  assert.deepEqual([j2.session.identity.match, j2.session.identity.modelId, j2.session.identity.label], ["exact", null, "Samsung Galaxy S10"]);
  await runTests(`Ticket ${j2.ticket}`, s2.session.id);
  const b = cases.getCase(adv, d.id);
  assert.equal(b.device, null);
  assert.equal(customerText(d.id), CANT_PRICE);
  assert.deepEqual(modelFlags(b), ["Model: phone code says Samsung Galaxy S23 Ultra; the IMEI says Samsung Galaxy S10, not on SwapUp's list — not used."]);
});

/* ─────────────────────────── a disagreeing code never settles the IMEI model's storage ─────────────────────────── */

test("review 0.9.4 (storage): an S23 Ultra IMEI and an S23+ (SM-S916B) measuring 256 GB — a size the Ultra has too: the storage is NOT settled from that phone", async () => {
  const c = fresh();
  await cases.updateCase(adv, c.id, { imei: imeiOn("Samsung Galaxy S23 Ultra") });
  const s = sessions.createTestSession(adv, { caseId: c.id });
  const j = joinWith(s.session.code, samsung("SM-S916B", 256e9), "0.9.3");
  await runTests(`Ticket ${j.ticket}`, s.session.id);
  const a = cases.getCase(adv, c.id);
  assert.deepEqual([a.device?.modelId, a.modelSource], ["galaxy-s23-ultra", "imei"]);
  assert.deepEqual([a.device?.variant, a.variantSource, a.offer?.swap.tradeIn], [null, null, null], "the advisor settles it — never an S23 Ultra 256GB price from an S23+'s reading");
  assert.deepEqual(modelFlags(a), ["Model: phone code says Samsung Galaxy S23+; the IMEI says Samsung Galaxy S23 Ultra — check Settings › About phone."]);
});

/* ─────────────────────────── no picker while the store has the IMEI ─────────────────────────── */

test("review 0.9.4 (no picker): an iPhone in Safari on a case with an IMEI and the advisor's model — told the store's model, exact; whether the IMEI names nothing, disagrees, or the model is Phonecheck's", async () => {
  // (A) The IMEI names no model; the advisor chose the iPhone 13, as the case told them to.
  const a = fresh();
  const va = await cases.updateCase(adv, a.id, { imei: "352099001761481" });
  assert.deepEqual(va.imeiWarnings, [IMEI_NAMES_NO_MODEL]);
  await cases.updateCase(adv, a.id, { modelId: "iphone-13" });
  const sa = sessions.createTestSession(adv, { caseId: a.id });
  const ja = joinWith(sa.session.code, IPHONE_BROWSER, "web-0.9.3");
  assert.deepEqual([ja.session.identity.match, ja.session.identity.modelId, ja.session.identity.label], ["exact", "iphone-13", "Apple iPhone 13"]);
  assert.equal(ja.session.identity.reason, "The store has this phone as the iPhone 13.");
  // (A2) The advisor's model and a listed IMEI model disagree: the advisor's stands (a warning says so), told as the store's.
  const b = fresh();
  await cases.updateCase(adv, b.id, { modelId: "iphone-13", variant: "128GB" });
  const vb = await cases.updateCase(adv, b.id, { imei: imeiOn("Apple Iphone 17 Pro Max") });
  assert.deepEqual([vb.device?.modelId, vb.imeiWarnings], ["iphone-13", ["The IMEI says Apple iPhone 17 Pro Max; the case has Apple iPhone 13 — check Settings › About phone."]]);
  const jb = joinWith(sessions.createTestSession(adv, { caseId: b.id }).session.code, IPHONE_BROWSER, "web-0.9.3");
  assert.deepEqual([jb.session.identity.match, jb.session.identity.modelId, jb.session.identity.variant], ["exact", "iphone-13", "128GB"]);
  // (A3) The model came from a Phonecheck report.
  const p = fresh();
  await cases.updateCase(adv, p.id, { modelId: "iphone-13" }, { modelSource: "phonecheck" });
  await cases.updateCase(adv, p.id, { imei: "352099001761499" });
  assert.equal(cases.getCase(adv, p.id).modelSource, "phonecheck");
  const jp = joinWith(sessions.createTestSession(adv, { caseId: p.id }).session.code, IPHONE_BROWSER, "web-0.9.3");
  assert.deepEqual([jp.session.identity.match, jp.session.identity.modelId], ["exact", "iphone-13"]);
  // No IMEI on the case: exactly as before — the phone's own answer (the picker)…
  const n = fresh();
  await cases.updateCase(adv, n.id, { modelId: "iphone-13" });
  const sn = sessions.createTestSession(adv, { caseId: n.id });
  const jn = joinWith(sn.session.code, IPHONE_BROWSER, "web-0.9.3");
  assert.equal(jn.session.identity.match, "none");
  // …and a pick of another model than the case's is said at Apply, never dropped without a word.
  sessions.deviceDeclare(`Ticket ${jn.ticket}`, { identityConfirmed: null, picked: { modelId: "iphone-15-pro", variant: null } });
  await runTests(`Ticket ${jn.ticket}`, sn.session.id);
  const an = cases.getCase(adv, n.id);
  assert.equal(an.device?.modelId, "iphone-13");
  assert.ok(modelFlags(an).includes("Model: customer picked Apple iPhone 15 Pro; the case has Apple iPhone 13 — the pick is not used."), modelFlags(an).join(" | "));
});

test("review 0.9.4 (no picker): a family code (SM-S918U) beside the store's own model — told the store's model; Apply never lets the unconfirmed family match overwrite it (flagged)", async () => {
  // The family match agrees with the store's model: exact, no "Is this your phone?".
  const c = fresh();
  await cases.updateCase(adv, c.id, { modelId: "galaxy-s23-ultra" });
  await cases.updateCase(adv, c.id, { imei: "352099001761507" });
  const j = joinWith(sessions.createTestSession(adv, { caseId: c.id }).session.code, samsung("SM-S918U", 256e9), "0.9.3");
  assert.deepEqual([j.session.identity.match, j.session.identity.modelId], ["exact", "galaxy-s23-ultra"]);
  // It names another model than the store's: the store's is told, and kept at Apply.
  const d = fresh();
  await cases.updateCase(adv, d.id, { modelId: "galaxy-s23-plus" });
  await cases.updateCase(adv, d.id, { imei: "352099001761515" });
  const s2 = sessions.createTestSession(adv, { caseId: d.id });
  const j2 = joinWith(s2.session.code, samsung("SM-S918U", 256e9), "0.9.3");
  assert.deepEqual([j2.session.identity.match, j2.session.identity.modelId], ["exact", "galaxy-s23-plus"]);
  await runTests(`Ticket ${j2.ticket}`, s2.session.id);
  const a = cases.getCase(adv, d.id);
  assert.deepEqual([a.device?.modelId, a.modelSource], ["galaxy-s23-plus", "advisor"]);
  assert.ok(modelFlags(a).includes("Model: phone code looks like Samsung Galaxy S23 Ultra; the case has Samsung Galaxy S23+ — check Settings › About phone."), modelFlags(a).join(" | "));
});

/* ─────────────────────────── GSMA's name wins over the type code; a stub is never GSMA ─────────────────────────── */

test("review 0.9.4 (GSMA): TAC 'Apple Iphone 15 Pro', GSMA says the 15 Pro Max — the case is the 15 Pro Max (Phonecheck's), and staff are told the two disagree", async () => {
  assert.equal(TACS["35976028"], "Apple Iphone 15 Pro");
  const imei = imeiOnTac("35976028");
  infos.set(imei, { brand: "Apple", model: "Apple iPhone 15 Pro Max (A3106)", modelNumber: null, blacklist: "clean", source: "gsma" });
  const c = fresh();
  const v = await withGiq(() => cases.updateCase(adv, c.id, { imei }));
  assert.deepEqual([v.device?.modelId, v.modelSource], ["iphone-15-pro-max", "imei"]);
  assert.deepEqual([v.imeiLookup?.brand, v.imeiLookup?.model, v.imeiLookup?.source], ["Apple", "iPhone 15 Pro Max", "gsma"]);
  assert.deepEqual(v.imeiWarnings, ["The IMEI's type code says Apple iPhone 15 Pro; GSMA says Apple iPhone 15 Pro Max — check Settings › About phone."]);
  const rec = stored(c.id);
  assert.deepEqual([rec.modelId, rec.gsmaName, rec.tacName, rec.modelWhy], [
    "iphone-15-pro-max",
    "Apple iPhone 15 Pro Max",
    "Apple Iphone 15 Pro",
    "GSMA: Apple iPhone 15 Pro Max (the type code says Apple iPhone 15 Pro).",
  ]);
  // GSMA names a phone NOT on the list where the type code names one that is: neither is used, both are said.
  const mini = imeiOn("Apple Iphone 13");
  infos.set(mini, { brand: "Apple", model: "Apple iPhone 13 mini (A2628)", modelNumber: null, blacklist: "clean", source: "gsma" });
  const d = fresh();
  const w = await withGiq(() => cases.updateCase(adv, d.id, { imei: mini }));
  assert.equal(w.device, null);
  assert.deepEqual(w.imeiWarnings, ["The IMEI's type code says Apple iPhone 13; GSMA says Apple iPhone 13 mini — check Settings › About phone."]);
  assert.equal(stored(d.id).modelKind, "ambiguous");
  assert.equal(joinWith(sessions.createTestSession(adv, { caseId: d.id }).session.code, IPHONE_BROWSER, "web-0.9.3").session.identity.label, "Your phone");
});

test("review 0.9.4 (stub): GradeIQ's made-up seed answer (source 'stub', a TAC not on the list) names nothing — no model, no name on the IMEI card, never 'GSMA'", async () => {
  for (const [tac, brand, model] of [["35316609", "Samsung", "Galaxy S21 5G"], ["35480108", "OnePlus", "11 5G"]]) {
    assert.equal(TACS[tac], undefined, `${tac} isn't on the offline list`);
    const imei = imeiOnTac(tac);
    infos.set(imei, { brand, model, modelNumber: null, blacklist: "unknown", source: "stub" });
    const c = fresh();
    const v = await withGiq(() => cases.updateCase(adv, c.id, { imei }));
    assert.equal(v.device, null, tac);
    assert.deepEqual([v.imeiLookup?.brand, v.imeiLookup?.model, v.imeiLookup?.source], [null, null, "stub"], tac);
    assert.deepEqual(v.imeiWarnings, [IMEI_NAMES_NO_MODEL]);
    const rec = stored(c.id);
    assert.deepEqual([rec.modelId, rec.modelKind, rec.gsmaName], [null, "none", null]);
    assert.ok(!String(rec.modelWhy).startsWith("GSMA"), String(rec.modelWhy));
  }
});

test("review 0.9.4 (kept answers): an answer kept by 0.9.3 (no tacName, a stub name) is read with today's rules — the offline list's name, never the stub's", async () => {
  // 0.9.3 kept {brand, model} as GradeIQ answered; a stub on a TAC the offline list names.
  const c = fresh();
  const imei = imeiOn("Apple Iphone 13");
  db()
    .prepare(`UPDATE cases SET imei = ?, imei_lookup = ? WHERE id = ?`)
    .run(imei, JSON.stringify([{ imei, brand: "Samsung", model: "Galaxy S22 Ultra", modelNumber: null, blacklist: "unknown", source: "stub", at: new Date().toISOString(), modelId: null, modelWhy: "" }]), c.id);
  const v = cases.getCase(adv, c.id);
  assert.deepEqual(v.imeiWarnings, [], "no model on the case, and the list's name is a listed one: nothing to warn");
  const j = joinWith(sessions.createTestSession(adv, { caseId: c.id }).session.code, IPHONE_BROWSER, "web-0.9.3");
  assert.deepEqual([j.session.identity.modelId, j.session.identity.match], ["iphone-13", "exact"], "the offline list's iPhone 13, never the stub's S22 Ultra");
  assert.equal(imeiUnlistedSentence("X"), "The IMEI says X — not on SwapUp's list, so it can't be priced here yet.");
});
