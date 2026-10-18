/**
 * The grading report and Phonecheck, through the REAL server services on a
 * throwaway database (docs/GRADING.md): SwapUp Check → Apply → report v1;
 * versioning; the public link and its hash; a Phonecheck JSON upload merged
 * worse-of; the IMEI-mismatch override; the AI reader (a stand-in Gemini);
 * the pull (a stand-in Phonecheck); the webhook; lock → the frozen version;
 * what the partner sees (no money, no live grade); pickups; the customer's link.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/*.test.ts
 * (lib/server/testing/register.mjs lets node load the server modules.)
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

/* ─────────────────────────── a throwaway server ─────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), "swapup-grading-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
for (const k of Object.keys(process.env)) if (k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_") || k.startsWith("PRICEIQ_")) delete process.env[k];
// The trade-in is priced by PriceIQ: a stand-in on 127.0.0.1 with the S23 Ultra's refurbished market prices.
const { startFakePriceiq, S23U_256 } = await import("./testing/fakePriceiq.ts");
const fakePriceiq = await startFakePriceiq({ "Galaxy S23 Ultra|256": S23U_256, "Galaxy S23 Ultra|512": { grades: [{ grade: "Good", low: 58_599 }], ageDays: 3 } });
Object.assign(process.env, { PRICEIQ_BASE_URL: fakePriceiq.url, PRICEIQ_API_KEY: fakePriceiq.key });

const errors: string[] = [];
const logs: string[] = [];
const origError = console.error;
const origLog = console.log;
console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const { issueToken } = await import("./auth.ts");
const cases = await import("./cases.ts");
const sessions = await import("./testSessions.ts");
const pc = await import("./phonecheck.ts");
const gr = await import("./gradingReport.ts");
const pickups = await import("./pickups.ts");
const { canonicalJson } = await import("../domain/gradingReport.ts");
const { luhnCheckDigit } = await import("../domain/imei.ts");
const { DEFAULT_PLAN } = await import("../domain/diagnostics.ts");
const caseRoute = await import("../../app/api/cases/[id]/route.ts");
const reportRoute = await import("../../app/api/cases/[id]/grading-report/route.ts");
const pcRoute = await import("../../app/api/cases/[id]/phonecheck/route.ts");
const webhookRoute = await import("../../app/api/phonecheck/webhook/route.ts");
const publicRoute = await import("../../app/api/r/[token]/route.ts");
const photoRoute = await import("../../app/api/r/[token]/photo/[n]/route.ts");
const stationRoute = await import("../../app/api/stores/[id]/phonecheck/route.ts");

type U = import("./auth.ts").SessionUser;
function who(id: string): U {
  const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE id = ?`).get(id) as { id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null };
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
}
const adv = who("usr_adv_and");
const mgr = who("usr_mgr_and");
const partner = who((db().prepare(`SELECT id FROM users WHERE username = 'partner'`).get() as { id: string }).id);
const otherAdv = who("usr_adv_kor");

const imeiOf = (body14: string) => body14 + String(luhnCheckDigit(body14));
const IMEI_A = imeiOf("35395011234567");
const IMEI_A2 = imeiOf("35395011234568");
const IMEI_B = imeiOf("35290611765432");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MONEY = /amount|price|quote|tradeValue|bonus|payable|refurbCost|marketSell|offer|margin|₹/i;

/** Call a route handler as a signed-in user (the Bearer token the store app sends). */
async function asUser<T>(u: U | null, fn: () => Promise<T>): Promise<T> {
  (globalThis as { __swapupTestHeaders?: Record<string, string> }).__swapupTestHeaders = u ? { authorization: `Bearer ${issueToken(u)}` } : {};
  try {
    return await fn();
  } finally {
    (globalThis as { __swapupTestHeaders?: Record<string, string> }).__swapupTestHeaders = {};
  }
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

/** A Phonecheck record with DeNovo's real field names (synthetic, Luhn-valid IMEIs). */
function pcRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    IMEI: IMEI_A,
    IMEI2: IMEI_A2,
    Serial: "R5CW12ABCDE",
    Make: "Samsung",
    Model: "Galaxy S23 Ultra",
    ModelNo: "SM-S918B",
    Memory: "256GB",
    Color: "Phantom Black",
    Carrier: "Unlocked",
    Grade: "B",
    Working: "No",
    Passed: "Digitizer N Pattern, LCD, Loud Speaker, Front Camera, Rear Camera, Battery Drain, Battery Drain, WiFi, Bluetooth, Device Lock",
    Failed: "Microphone",
    Pending: "",
    BatteryHealthPercentage: "91",
    BatteryCycle: "312",
    DeviceLock: "Off",
    MDM: "Off",
    Knox: "Off",
    Rooted: "Off",
    Erased: "No",
    Parts: JSON.stringify({ Remarks: "Genuine", Data: [] }),
    StationID: "Teja-D04",
    TesterName: "Teja",
    DeviceUpdatedDate: "2026-10-17 13:51:00",
    UpdatedTimeStamp: "2026-10-17T17:51:00.00+04:00",
    A4Reports: "512345678",
    A4ReportLink: "https://cloudportal.phonecheck.com/cloud/reporting/A4-certificate/abc123",
    erasureReportLink: "https://cloudportal.phonecheck.com/cloud/reporting/erasure-report/abc123",
    dhr_link: "https://historyreport.phonecheck.com/report-qr/abc123",
    ...over,
  };
}

/** A stand-in HTTP server for Phonecheck / Gemini / GradeIQ photos. */
async function stub(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void) {
  const seen: { url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** A SwapUp Check run on an S23 Ultra through join → results → complete → Apply. */
async function testedCase(opts: { results?: Record<string, "pass" | "fail" | "skip">; physical?: boolean } = {}): Promise<{ caseId: string; ticket: string; sessionId: string }> {
  const created = sessions.createTestSession(adv, { customerName: "Asha Rao", customerPhone: "9820012345" });
  const joined = sessions.joinByCode(
    {
      code: created.session.code,
      installId: `install-${Math.random().toString(36).slice(2, 12)}`,
      appVersion: "0.6.0",
      device: { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", totalDiskBytes: 256e9, isPhysicalDevice: opts.physical ?? true },
    },
    "127.0.0.1"
  );
  const ticket = `Ticket ${joined.ticket}`;
  const at = new Date().toISOString();
  const results = DEFAULT_PLAN.filter((p) => p.id !== "battery_health").map((p) => ({ testId: p.id, outcome: opts.results?.[p.id] ?? "pass", at, detail: null }));
  sessions.deviceResults(ticket, { results });
  sessions.deviceComplete(ticket);
  await sessions.applyTestSession(adv, created.session.id);
  return { caseId: created.session.caseId, ticket, sessionId: created.session.id };
}

const versions = (caseId: string) => db().prepare(`SELECT version, reason, final, label, sha256, body FROM grading_reports WHERE case_id = ? ORDER BY version`).all(caseId) as { version: number; reason: string; final: number; label: string; sha256: string; body: string }[];

after(async () => {
  console.error = origError;
  console.log = origLog;
  await fakePriceiq.close();
  rmSync(dir, { recursive: true, force: true });
});

/* ─────────────────────────── migration 13 ─────────────────────────── */

test("migration 13: report_token, grading_reports, phonecheck_records", () => {
  const cols = (db().prepare(`PRAGMA table_info(cases)`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes("report_token"));
  for (const t of ["grading_reports", "phonecheck_records"]) assert.ok(db().prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t), t);
  assert.throws(() => db().prepare(`INSERT INTO phonecheck_records (id, record_key, source, record, raw, received_at, updated_at) VALUES ('x','k','email','{}','{}','t','t')`).run());
});

/* ─────────────────────────── switched off ─────────────────────────── */

test("Phonecheck ships switched off: everything works with PHONECHECK_* unset, and the pull says why", async () => {
  assert.deepEqual(pc.phonecheckConfigured().ok, false);
  assert.match(pc.phonecheckConfigured().why, /Phonecheck is off here/);
  const c = cases.createCase(adv, {});
  await cases.updateCase(adv, c.id, { imei: IMEI_B });
  const v = cases.getCase(adv, c.id);
  assert.equal(v.grading?.phonecheck?.canPull, false);
  assert.match(v.grading!.phonecheck!.why!, /Phonecheck is off here/);
  await assert.rejects(pc.pullForCase(adv, c.id), (e: Error & { status?: number }) => e.status === 409 && /Phonecheck is off here/.test(e.message));
  process.env.PHONECHECK_API_KEY = "pc-test-key";
  assert.match(pc.phonecheckConfigured().why, /contract is confirmed/);
  delete process.env.PHONECHECK_API_KEY;
  // Untested: no report is issued, and the line says so.
  assert.equal(v.grading?.status, "not_tested");
  assert.equal(v.grading?.label, "Not tested");
  assert.equal(v.grading?.report, null);
  assert.equal(versions(c.id).length, 0);
});

/* ─────────────────────────── SwapUp Check → Apply → v1 ─────────────────────────── */

let main: { caseId: string; ticket: string; sessionId: string };

test("SwapUp Check through Apply issues v1 with grade + letter + reasons; the public link's hash recomputes", async () => {
  main = await testedCase();
  const v = cases.getCase(adv, main.caseId);
  assert.equal(v.grading?.status, "graded");
  assert.equal(v.grading?.grade, "Superb");
  assert.equal(v.grading?.letter, "A");
  // Not camera-graded (GradeIQ off) and no battery reading → provisional, and the label says both scales.
  assert.equal(v.grading?.label, "Superb (A) · provisional");
  assert.equal(v.grading?.report?.version, 1);
  const vs = versions(main.caseId);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].reason, "swapup_check");

  const r = gr.gradingReportFor(adv, main.caseId);
  assert.ok(r.live && r.issued && r.staff);
  assert.deepEqual(r.live.provisional.map((x) => x.code).sort(), ["PV1", "PV5"]);
  assert.equal(r.issued.body.grade.letterScale, "A = Superb, B = Good, C = Fair, D = Best Value — not CTIA.");
  assert.equal(r.staff.imei, null);
  assert.equal(r.staff.afterRefurb?.label, "Superb (A)");
  assert.equal(r.staff.outOfDate, false);

  // The public link: the same envelope, a hash anyone can recompute, nothing that prices.
  const token = r.path!.split("/").pop()!;
  const res = await publicRoute.GET(new Request(`http://x/api/r/${token}`), params({ token }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const env = (await res.json()) as { sha256: string; body: unknown; version: number };
  assert.equal(env.version, 1);
  assert.equal(sha(canonicalJson(env.body)), env.sha256);
  assert.doesNotMatch(JSON.stringify(env.body), MONEY);
  assert.doesNotMatch(JSON.stringify(env.body), /9820012345|Asha/);
  // Bad token / version → 404.
  assert.equal((await publicRoute.GET(new Request(`http://x/api/r/nope`), params({ token: "nope" }))).status, 404);
  assert.equal((await publicRoute.GET(new Request(`http://x/api/r/${token}?v=9`), params({ token }))).status, 404);
});

test("the customer's phone gets its report link and the grade on both scales once the session is applied", () => {
  const s = sessions.deviceStatus(main.ticket);
  assert.equal(s.status, "applied");
  assert.match(String(s.reportPath), /^\/r\/[A-Za-z0-9_-]{22}$/);
  // The grade the link opens on (the latest issued version): the SwapUp grade, its letter, nothing else.
  assert.deepEqual(s.grading, { status: "graded", label: "Superb (A) · provisional", grade: "Superb", letter: "A", final: false });
  assert.doesNotMatch(JSON.stringify(s), MONEY);
  // Before Apply there is neither.
  const fresh = sessions.createTestSession(adv, {});
  const j = sessions.joinByCode(
    { code: fresh.session.code, installId: "install-status-check", appVersion: "0.6.0", device: { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", isPhysicalDevice: true } },
    "127.0.0.1"
  );
  const before = sessions.deviceStatus(`Ticket ${j.ticket}`);
  assert.equal(before.reportPath, null);
  assert.equal(before.grading, null);
  assert.equal(sessions.deviceStatus("Ticket nope-nope-nope-nope-nope-nope").grading, null);
});

test("versioning: an edit that moves the grade is v2; the same edit again is still v2", async () => {
  const before = cases.getCase(adv, main.caseId).condition!;
  await cases.updateCase(adv, main.caseId, { condition: { ...before, screen: "scratched" } });
  let v = cases.getCase(adv, main.caseId);
  assert.equal(v.grading?.grade, "Good");
  assert.equal(v.grading?.label, "Good (B) · provisional");
  assert.equal(versions(main.caseId).length, 2);
  await cases.updateCase(adv, main.caseId, { condition: { ...before, screen: "scratched" } });
  v = cases.getCase(adv, main.caseId);
  assert.equal(versions(main.caseId).length, 2);
  assert.equal(v.grading?.report?.version, 2);
  // An edit that changes nothing graded (the refurb cost) issues nothing either.
  await cases.updateCase(adv, main.caseId, { refurbCost: { amount: 4200 } });
  assert.equal(versions(main.caseId).length, 2);
});

/* ─────────────────────────── Phonecheck JSON upload ─────────────────────────── */

test("a Phonecheck JSON upload merges worse-of: the mic failure makes it Needs repair, fault source phonecheck, PV7", async () => {
  const out = await pc.uploadForCase(adv, main.caseId, pcRecord());
  assert.equal(out.outcome, "attached");
  assert.equal(out.record?.source, "upload");
  assert.equal(out.record?.testerGrade, "B");
  const v = out.case;
  assert.equal(v.imei, IMEI_A); // the case had none: Phonecheck read it by cable
  assert.equal(v.imei2, IMEI_A2);
  assert.ok(v.faults.includes("mic"));
  assert.deepEqual(v.faultSources.mic, ["phonecheck"]);
  assert.equal(v.grading?.status, "needs_repair");
  assert.equal(v.grading?.letter, null);
  assert.equal(v.grading?.label, "Needs repair");
  const vs = versions(main.caseId);
  assert.equal(vs.at(-1)?.reason, "phonecheck");
  const r = gr.gradingReportFor(adv, main.caseId);
  const mic = r.live!.tests.find((t) => t.id === "mic")!;
  assert.equal(mic.result, "failed");
  assert.deepEqual(mic.sources.map((s) => [s.source, s.outcome]), [["swapup_check", "pass"], ["phonecheck_upload", "fail"]]);
  assert.ok(r.live!.provisional.some((p) => p.code === "PV7"));
  assert.equal(r.live!.battery.pct, 91);
  assert.equal(r.issued!.body.phonecheck?.reportNo, "512345678");
  assert.equal(r.issued!.body.phonecheck?.uploaded, true);
  // Staff see Phonecheck's links; the public body never does.
  assert.match(r.staff!.phonecheck!.links.a4!, /^https:\/\/cloudportal/);
  assert.doesNotMatch(JSON.stringify(r.issued!.body), /cloudportal|historyreport/);
  assert.doesNotMatch(JSON.stringify(r.issued!.body), new RegExp(IMEI_A));
});

test("re-uploading the same check is stale and changes nothing; a fetched copy wins over an upload", async () => {
  const n = versions(main.caseId).length;
  const again = await pc.uploadForCase(adv, main.caseId, pcRecord());
  assert.equal(again.outcome, "attached");
  assert.equal(versions(main.caseId).length, n);
  assert.equal((db().prepare(`SELECT COUNT(*) n FROM phonecheck_records WHERE record_key = 'a4:512345678'`).get() as { n: number }).n, 1);
  // The same check arriving from Phonecheck itself replaces the upload (same key).
  const rec = (await import("../domain/phonecheck.ts")).readPhonecheck(pcRecord(), {});
  assert.ok(rec.ok);
  const stored = pc.storeRecord(rec.record, pcRecord(), "webhook", null);
  assert.equal(stored.outcome, "replace");
  // …and an upload of a check already fetched keeps the fetched copy.
  assert.equal(pc.storeRecord(rec.record, pcRecord(), "upload", null).outcome, "fetched_copy");
});

/* ─────────────────────────── IMEI mismatch ─────────────────────────── */

test("IMEI mismatch: 409 naming both numbers; an advisor can't override; a manager can, with a reason (PV8)", async () => {
  const t = await testedCase();
  await cases.updateCase(adv, t.caseId, { imei: IMEI_B });
  const other = pcRecord({ IMEI: imeiOf("35000011111111"), IMEI2: "", A4Reports: "600000001", Failed: "" });
  // Through the route: 409 with the record, so a manager can attach it.
  const res = await asUser(adv, () =>
    pcRoute.POST(new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "upload", record: other }) }), params({ id: t.caseId }))
  );
  assert.equal(res.status, 409);
  const j = (await res.json()) as { error: string; outcome: string; record: { id: string } };
  assert.equal(j.outcome, "mismatch");
  assert.ok(j.error.includes(IMEI_B) && j.error.includes(String(other.IMEI)));
  await assert.rejects(pc.attachForCase(adv, t.caseId, j.record.id, { confirmMismatch: true, reason: "checked by hand" }), (e: Error & { status?: number }) => e.status === 403);
  await assert.rejects(pc.attachForCase(mgr, t.caseId, j.record.id, { confirmMismatch: true, reason: "ok" }), (e: Error & { status?: number }) => e.status === 400);
  const done = await pc.attachForCase(mgr, t.caseId, j.record.id, { confirmMismatch: true, reason: "IMEI 2 on the box label matches" });
  assert.equal(done.outcome, "attached");
  assert.equal(done.case.imei, IMEI_B); // the case keeps its own number
  const r = gr.gradingReportFor(mgr, t.caseId);
  assert.ok(r.live!.provisional.some((p) => p.code === "PV8" && /box label/.test(p.text)));
  // Another store can't see or take it.
  await assert.rejects(pc.attachForCase(otherAdv, t.caseId, j.record.id, {}), (e: Error & { status?: number }) => e.status === 404);
});

test("a failed Wi-Fi test is priced: Apply puts the Wi-Fi / Bluetooth issue on the condition, and the trade-in deducts it", async () => {
  const t = await testedCase({ results: { connectivity: "fail" } });
  const v = cases.getCase(adv, t.caseId);
  assert.ok(v.condition?.issues.includes("wifi_bt"), JSON.stringify(v.condition));
  assert.ok(v.quote?.lines.some((l) => /Wi-Fi/.test(l.label)), JSON.stringify(v.quote?.lines));
  const r = gr.gradingReportFor(adv, t.caseId);
  assert.ok(!r.live!.provisional.some((p) => p.code === "PV6" && /Wi-Fi/.test(p.text)), "no longer a note to confirm by hand");
});

test("upload limits hold for a chunked body with no Content-Length: cut off at the limit with a 413, never read in full", async () => {
  const t = await testedCase();
  let pulled = 0;
  const chunk = new Uint8Array(1024 * 1024);
  // 64 MB that never says how big it is.
  const endless = () =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= 64) return c.close();
        pulled++;
        c.enqueue(chunk);
      },
    });
  const multipart = await asUser(adv, () =>
    pcRoute.POST(new Request("http://x", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body: endless(), duplex: "half" } as RequestInit), params({ id: t.caseId }))
  );
  assert.equal(multipart.status, 413);
  assert.ok(pulled < 16, `stopped after ${pulled} MB`);
  pulled = 0;
  const json = await asUser(adv, () =>
    pcRoute.POST(new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: endless(), duplex: "half" } as RequestInit), params({ id: t.caseId }))
  );
  assert.equal(json.status, 413);
  assert.ok(pulled < 16, `stopped after ${pulled} MB`);
  pulled = 0;
  process.env.PHONECHECK_WEBHOOK_SECRET = "a-webhook-secret-of-32-characters!!";
  try {
    const hook = await webhookRoute.POST(
      new Request("http://x", { method: "POST", headers: { "content-type": "application/json", "x-pc-secret": "a-webhook-secret-of-32-characters!!" }, body: endless(), duplex: "half" } as RequestInit)
    );
    assert.equal(hook.status, 413);
    assert.ok(pulled < 4, `stopped after ${pulled} MB`);
  } finally {
    delete process.env.PHONECHECK_WEBHOOK_SECRET;
  }
});

/* ─────────────────────────── the AI reader ─────────────────────────── */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);

test("an uploaded report image is read by AI into the same record — key in a header, PV7 + PV12, extracted fields returned", async () => {
  const KEY = "gemini-test-key-0123456789";
  const extraction = {
    IMEI: IMEI_A,
    IMEI2: null,
    Make: "Samsung",
    Model: "Galaxy S23 Ultra",
    ModelNo: "SM-S918B",
    Memory: "256GB",
    Grade: "A",
    Working: "Yes",
    Passed: ["Microphone", "LCD", "Loud Speaker", "Front Camera", "Rear Camera"],
    Failed: [],
    Pending: null,
    BatteryHealthPercentage: 88,
    DeviceLock: "Off",
    A4Reports: "700000002",
    UpdatedTimeStamp: "2026-10-17T18:30:00+04:00",
    StationID: "N/A",
  };
  let mode: "ok" | "other" | "402" = "ok";
  const g = await stub((_req, _body, res) => {
    if (mode === "402") {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Your prepayment credits are depleted. key=${KEY}` } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    const read = mode === "other" ? { ...extraction, IMEI: IMEI_B, A4Reports: "700000009" } : extraction;
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(read) }] }, finishReason: "STOP" }] }));
  });
  try {
    const t = await testedCase();
    // No key → 503 with a clear message; the JSON upload still works.
    await assert.rejects(pc.uploadFileForCase(adv, t.caseId, { bytes: PNG, mime: "image/png", name: "report.png" }), (e: Error & { status?: number }) => e.status === 503 && /AI reader not set up/.test(e.message));
    // …and the case's Phonecheck GET says so up front, so the desk greys the button before anything is chosen.
    const off = pc.phonecheckForCase(adv, t.caseId).aiReader;
    assert.equal(off.ok, false);
    assert.match(off.why, /AI reader not set up/);
    process.env.GEMINI_API_KEY = KEY;
    process.env.GEMINI_API_BASE = `${g.base}/v1beta`;
    const on = pc.phonecheckForCase(adv, t.caseId).aiReader;
    assert.equal(on.ok, true);
    assert.ok(!JSON.stringify(on).includes(KEY), "the key never reaches a client");
    // Wrong type, too big.
    await assert.rejects(pc.uploadFileForCase(adv, t.caseId, { bytes: new TextEncoder().encode("hello"), mime: "text/plain", name: null }), (e: Error & { status?: number }) => e.status === 400);
    const out = await asUser(adv, async () => {
      const fd = new FormData();
      fd.set("file", new Blob([PNG], { type: "image/png" }), "report.png");
      return pcRoute.POST(new Request("http://x", { method: "POST", body: fd }), params({ id: t.caseId }));
    });
    assert.equal(out.status, 200, await out.clone().text());
    const j = (await out.json()) as { outcome: string; extracted: Record<string, unknown>; record: { aiRead: boolean; source: string; station: string | null } };
    assert.equal(j.outcome, "attached");
    assert.equal(j.record.aiRead, true);
    assert.equal(j.record.source, "upload");
    assert.equal(j.record.station, null); // "N/A" is a placeholder, dropped — never invented
    assert.equal(j.extracted.IMEI, IMEI_A);
    assert.equal(j.extracted.BatteryHealthPercentage, "88");
    // The key went in the x-goog-api-key header, never the URL; the model is GradeIQ's default.
    const call = g.seen.at(-1)!;
    assert.equal(call.headers["x-goog-api-key"], KEY);
    assert.ok(!call.url.includes(KEY));
    assert.match(call.url, /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
    assert.equal(JSON.parse(call.body).contents[0].parts[1].inline_data.mime_type, "image/png");
    const r = gr.gradingReportFor(adv, t.caseId);
    const codes = r.live!.provisional.map((p) => p.code);
    assert.ok(codes.includes("PV7") && codes.includes("PV12"));
    assert.equal(r.issued!.body.phonecheck?.aiRead, true);
    // A second read of the same case within 10 s is refused (each read is a paid call).
    await assert.rejects(pc.uploadFileForCase(adv, t.caseId, { bytes: PNG, mime: "image/png", name: null }), (e: Error & { status?: number }) => e.status === 429);
    // The same file as a data URL (clients without multipart), on another case: the same
    // Phonecheck report can't be on two open cases…
    const t3 = await testedCase();
    const dataUrl = () =>
      asUser(adv, () =>
        pcRoute.POST(
          new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "upload_file", file: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`, name: "r.png" }) }),
          params({ id: t3.caseId })
        )
      );
    const dup = await dataUrl();
    assert.equal(dup.status, 409);
    assert.match(((await dup.json()) as { error: string }).error, /already on case SU-/);
    // …another phone's report attaches.
    mode = "other";
    await new Promise((res) => setTimeout(res, 10_050)); // one AI read per case per 10 s
    const viaJson = await dataUrl();
    assert.equal(viaJson.status, 200, await viaJson.clone().text());
    // An AI reading is not a cable read: the case's empty IMEI stays empty, and staff are told to enter it.
    const vj = (await viaJson.json()) as { case: { imei: string | null }; note: string };
    assert.equal(vj.case.imei, null);
    assert.match(vj.note, /^Read by AI — check the figures\. Enter the IMEI yourself\.$/);
    // Google out of credit → a clear 503 that never carries the key.
    mode = "402";
    const t2 = await testedCase();
    await assert.rejects(pc.uploadFileForCase(adv, t2.caseId, { bytes: PNG, mime: "image/png", name: null }), (e: Error & { status?: number }) => e.status === 503 && /out of credit/.test(e.message) && !e.message.includes(KEY));
    // …and from then on the reader says it is off, up front, and makes no paid call to learn it again.
    const outage = pc.phonecheckForCase(adv, t2.caseId).aiReader;
    assert.deepEqual(outage, { ok: false, why: "AI reader off — out of credit; upload the Phonecheck JSON." });
    const calls = g.seen.length;
    const t4 = await testedCase();
    await assert.rejects(pc.uploadFileForCase(adv, t4.caseId, { bytes: PNG, mime: "image/png", name: null }), (e: Error & { status?: number }) => e.status === 503 && e.message === outage.why);
    assert.equal(g.seen.length, calls, "no call to Google while the reader is off");
    // A different key (the account fixed) is tried at once.
    process.env.GEMINI_API_KEY = `${KEY}-topped-up`;
    assert.equal(pc.phonecheckForCase(adv, t4.caseId).aiReader.ok, true);
    assert.ok(![...errors, ...logs].some((l) => l.includes(KEY)), "the key is never logged");
  } finally {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_BASE;
    await g.close();
  }
});

test("an AI reading never fills storage, model or IMEI; Phonecheck's own JSON of the same check replaces it", async () => {
  const KEY = "gemini-test-key-ai-vs-json-0001";
  const extraction = {
    IMEI: IMEI_A,
    Make: "Samsung",
    Model: "Galaxy S23 Ultra",
    ModelNo: "SM-S918B",
    Memory: "512GB", // misread: the phone is 256GB
    Working: "Yes",
    Passed: ["Microphone", "LCD", "Loud Speaker", "Front Camera", "Rear Camera"],
    Failed: [],
    BatteryHealthPercentage: 98, // misread: Phonecheck's JSON says 78
    A4Reports: "700000077",
    UpdatedTimeStamp: "2026-10-17T18:30:00+04:00",
  };
  const g = await stub((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(extraction) }] }, finishReason: "STOP" }] }));
  });
  try {
    process.env.GEMINI_API_KEY = KEY;
    process.env.GEMINI_API_BASE = `${g.base}/v1beta`;
    const t = await testedCase();
    await cases.updateCase(adv, t.caseId, { variant: null });
    const before = cases.getCase(adv, t.caseId);
    assert.equal(before.device?.variant ?? null, null);
    const ai = await pc.uploadFileForCase(adv, t.caseId, { bytes: PNG, mime: "image/png", name: "report.png" });
    assert.equal(ai.record?.aiRead, true);
    assert.equal(ai.case.device?.variant ?? null, null, "the AI's 512GB is not written on the case");
    assert.equal(ai.case.variantSource, null);
    assert.equal(ai.case.imei, null, "nor its IMEI");
    assert.match(ai.note!, /Enter the storage and IMEI yourself\.$/);
    // Phonecheck's exact JSON for the same check (same report number, same time) replaces the AI copy.
    const json = pcRecord({ IMEI: IMEI_A, A4Reports: "700000077", Failed: "", Working: "Yes", BatteryHealthPercentage: "78", UpdatedTimeStamp: "2026-10-17T18:30:00+04:00" });
    const up = await pc.uploadForCase(adv, t.caseId, json);
    assert.equal(up.record?.aiRead, false);
    assert.equal(up.record?.batteryHealthPct, 78);
    assert.equal(up.note, null);
    const r = gr.gradingReportFor(adv, t.caseId);
    assert.equal(r.live!.battery.pct, 78);
    assert.ok(r.live!.reasons.some((x) => x.code === "NR6"), "the JSON's 78 % is what grades");
    assert.ok(!r.live!.provisional.some((x) => x.code === "PV12"), "no longer an AI reading");
    // An AI reading of a check Phonecheck's JSON already gave is not used — and staff are told.
    await new Promise((res) => setTimeout(res, 10_050)); // one AI read per case per 10 s
    const again = await pc.uploadFileForCase(adv, t.caseId, { bytes: PNG, mime: "image/png", name: "report.png" });
    assert.equal(again.record?.aiRead, false);
    assert.equal(again.note, "Not used: this check is already on file.");
    // …and re-uploading the same JSON says so too.
    const same = await pc.uploadForCase(adv, t.caseId, json);
    assert.equal(same.note, "Not used: this check is already on file.");
  } finally {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_BASE;
    await g.close();
  }
});

/* ─────────────────────────── the pull ─────────────────────────── */

test("the pull: form-encoded GetDeviceInfo with the store's station; not found; 401; throttled", async () => {
  const p = await stub((req, body, res) => {
    const f = new URLSearchParams(body);
    if (f.get("username") === "master") {
      res.writeHead(401).end(JSON.stringify({ msg: "Unauthorized" }));
      return;
    }
    if (f.get("imei") !== IMEI_B) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ status: 0, msg: "No Data Found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([pcRecord({ IMEI: IMEI_B, IMEI2: "", A4Reports: "800000003", Failed: "", Working: "Yes", Passed: "Microphone, LCD, Loud Speaker, Front Camera, Rear Camera, Digitizer N Pattern" })]));
  });
  process.env.PHONECHECK_API_BASE = `${p.base}/cloud/cloudDB`;
  process.env.PHONECHECK_API_KEY = "pc-secret-api-key";
  process.env.PHONECHECK_CONTRACT_CONFIRMED = "1";
  try {
    const t = await testedCase();
    await cases.updateCase(adv, t.caseId, { imei: IMEI_B });
    // No station yet.
    assert.match(cases.getCase(adv, t.caseId).grading!.phonecheck!.why!, /station/);
    // The store's station, through its route (store manager only).
    const put = await asUser(mgr, () => stationRoute.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ station: "Teja-D04" }) }), params({ id: "st_and" })));
    assert.equal(put.status, 200);
    assert.equal(((await put.json()) as { station: string }).station, "Teja-D04");
    assert.equal((await asUser(adv, () => stationRoute.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ station: "x" }) }), params({ id: "st_and" })))).status, 403);
    assert.equal(cases.getCase(adv, t.caseId).grading?.phonecheck?.canPull, true);

    const out = await pc.pullForCase(adv, t.caseId);
    assert.equal(out.outcome, "attached");
    assert.equal(out.record?.source, "pull");
    const call = p.seen.at(-1)!;
    assert.equal(call.url, "/cloud/cloudDB/GetDeviceInfo");
    assert.equal(call.headers["content-type"], "application/x-www-form-urlencoded");
    const f = new URLSearchParams(call.body);
    assert.deepEqual([f.get("apiKey"), f.get("username"), f.get("imei"), f.get("IMEI")], ["pc-secret-api-key", "Teja-D04", IMEI_B, IMEI_B]);
    const r = gr.gradingReportFor(adv, t.caseId);
    assert.ok(!r.live!.provisional.some((x) => x.code === "PV7"), "a fetched record is not an upload");
    assert.equal(versions(t.caseId).at(-1)?.reason, "phonecheck");
    // Throttled: one pull per case per 15 s.
    await assert.rejects(pc.pullForCase(adv, t.caseId), (e: Error & { status?: number }) => e.status === 429);

    // Not found on this account → not_found, nothing attached.
    const t2 = await testedCase();
    await cases.updateCase(adv, t2.caseId, { imei: IMEI_A });
    const nf = await pc.pullForCase(adv, t2.caseId);
    assert.equal(nf.outcome, "not_found");
    // The master name is refused → 502 with Phonecheck's meaning, never the key.
    pc.setStorePhonecheck(mgr, "st_and", { station: "master" });
    const t3 = await testedCase();
    await cases.updateCase(adv, t3.caseId, { imei: IMEI_B });
    await assert.rejects(pc.pullForCase(adv, t3.caseId), (e: Error & { status?: number }) => e.status === 502 && /master account/.test(e.message) && !e.message.includes("pc-secret-api-key"));
  } finally {
    pc.setStorePhonecheck(mgr, "st_and", { station: null });
    delete process.env.PHONECHECK_API_BASE;
    delete process.env.PHONECHECK_API_KEY;
    delete process.env.PHONECHECK_CONTRACT_CONFIRMED;
    await p.close();
  }
});

/* ─────────────────────────── the webhook ─────────────────────────── */

test("the webhook: 503 with no secret, 401 wrong, stored when right, stale on replay, never attached", async () => {
  const post = (body: string, headers: Record<string, string>) => webhookRoute.POST(new Request("http://x/api/phonecheck/webhook", { method: "POST", body, headers }));
  const rec = JSON.stringify({ devices: [pcRecord({ IMEI: imeiOf("35111111111111"), IMEI2: "", A4Reports: "900000004" }), { IMEI: "12345678" }] });
  assert.equal((await post(rec, { "content-type": "application/json", "x-pc-secret": "anything" })).status, 503);
  process.env.PHONECHECK_WEBHOOK_SECRET = "short";
  assert.equal((await post(rec, { "content-type": "application/json", "x-pc-secret": "short" })).status, 503, "a secret under 24 characters counts as unset");
  process.env.PHONECHECK_WEBHOOK_SECRET = "a-webhook-secret-of-thirty-chars";
  try {
    assert.equal((await post(rec, { "content-type": "application/json", "x-pc-secret": "wrong" })).status, 401);
    const ok = await post(rec, { "content-type": "application/json", authorization: "Bearer a-webhook-secret-of-thirty-chars" });
    assert.equal(ok.status, 200);
    const j = (await ok.json()) as { received: number; stored: number; stale: number; rejected: { reason: string }[] };
    assert.deepEqual([j.received, j.stored, j.stale, j.rejected.length], [2, 1, 0, 1]);
    assert.match(j.rejected[0].reason, /8 digits, not 15/);
    const replay = (await (await post(rec, { "content-type": "application/json", "x-pc-secret": "a-webhook-secret-of-thirty-chars" })).json()) as { stored: number; stale: number };
    assert.deepEqual([replay.stored, replay.stale], [0, 1]);
    const row = db().prepare(`SELECT case_id, source FROM phonecheck_records WHERE record_key = 'a4:900000004'`).get() as { case_id: string | null; source: string };
    assert.deepEqual(row, { case_id: null, source: "webhook" });
    // Form-encoded, with the JSON in a field.
    const form = new URLSearchParams({ deviceInfo: JSON.stringify(pcRecord({ IMEI: imeiOf("35222222222222"), IMEI2: "", A4Reports: "900000005" })) }).toString();
    const f = (await (await post(form, { "content-type": "application/x-www-form-urlencoded", "x-pc-secret": "a-webhook-secret-of-thirty-chars" })).json()) as { stored: number };
    assert.equal(f.stored, 1);
    const health = (await (await webhookRoute.GET()).json()) as { secured: boolean };
    assert.equal(health.secured, true);
    // A newer copy of a check already attached to an open case re-issues that case's report
    // (the grade reads the attached record live) — still without attaching anything new.
    const n = versions(main.caseId).length;
    const newer = JSON.stringify(pcRecord({ UpdatedTimeStamp: "2026-10-17T19:00:00.00+04:00" }));
    const u = (await (await post(newer, { "content-type": "application/json", "x-pc-secret": "a-webhook-secret-of-thirty-chars" })).json()) as { stored: number };
    assert.equal(u.stored, 1);
    const vs = versions(main.caseId);
    assert.equal(vs.length, n + 1);
    assert.equal(vs.at(-1)?.reason, "phonecheck");
    assert.ok(!gr.gradingReportFor(adv, main.caseId).live!.provisional.some((p) => p.code === "PV7"), "Phonecheck's own copy is not an upload");
  } finally {
    delete process.env.PHONECHECK_WEBHOOK_SECRET;
  }
});

/* ─────────────────────────── lock, the partner, pickups ─────────────────────────── */

test("lock freezes the report (final, with the IMEI-register result); nothing re-issues after it", async () => {
  // Partner before lock: not found, like the case itself.
  await assert.rejects(async () => gr.gradingReportFor(partner, main.caseId), (e: Error & { status?: number }) => e.status === 404);
  const v0 = cases.getCase(adv, main.caseId);
  assert.deepEqual(v0.lockBlockers, []);
  cases.lockTradeIn(adv, main.caseId, {
    customer: { name: "Asha Rao", phone: "9820012345", idType: "aadhaar", idLast4: "1234" },
    checks: { ownership: true, simRemoved: true, imeiMatches: true, noFinanceLock: true, kym: { status: "clear", reference: "SS-1" } },
  });
  const vs = versions(main.caseId);
  const last = vs.at(-1)!;
  assert.equal(last.reason, "traded_in");
  assert.equal(last.final, 1);
  const body = JSON.parse(last.body) as { phone: { kym: { status: string } | null; imei: string } };
  assert.equal(body.phone.kym?.status, "clear");
  assert.ok(body.phone.imei.includes("•"));
  // After lock nothing re-issues.
  assert.equal(gr.issueIfChanged(main.caseId, "edited", adv.id)?.version, last.version);
  assert.equal(versions(main.caseId).length, vs.length);
  // Staff's grade line on the locked case is the frozen version, linked to exactly it (the store app's traded-in card).
  const g = cases.getCase(adv, main.caseId).grading!;
  assert.equal(g.label, last.label);
  assert.equal(g.report?.version, last.version);
  assert.equal(g.report?.final, true);
  assert.match(g.report!.path, new RegExp(`\\?v=${last.version}$`));
  assert.equal(g.phonecheck?.canPull, false);
});

test("the partner sees no refurb cost, no answer, no SELL price, and only the frozen report (no live grade)", async () => {
  const res = await asUser(partner, () => caseRoute.GET(new Request("http://x"), params({ id: main.caseId })));
  assert.equal(res.status, 200);
  const v = (await res.json()) as import("./cases.ts").CaseView;
  assert.equal(v.refurbCost, null);
  assert.equal(v.offer, null);
  assert.equal(v.marketSell.amount, null);
  assert.equal(v.marketSell.why, "Not shown to the partner.");
  assert.equal(v.grading?.phonecheck, null);
  assert.equal(v.grading?.report?.final, true);
  assert.match(v.grading!.report!.path, /\?v=\d+$/);
  // Staff still see their own figures.
  const staff = cases.getCase(adv, main.caseId);
  assert.equal(staff.refurbCost?.amount, 4200);

  const rr = await asUser(partner, () => reportRoute.GET(new Request("http://x"), params({ id: main.caseId })));
  const r = (await rr.json()) as { live: unknown; issued: { final: boolean; body: unknown }; versions: unknown[]; staff: unknown };
  assert.equal(r.live, null);
  assert.equal(r.staff, null);
  assert.equal(r.versions.length, 1);
  assert.equal(r.issued.final, true);
  assert.doesNotMatch(JSON.stringify(r), MONEY);
});

test("the partner never gets the store camera's own GradeIQ letter, range or flags — staff still do", async () => {
  const { blankCameraCheck } = await import("../domain/gradeiqMap.ts");
  const saved = (db().prepare(`SELECT camera_check FROM cases WHERE id = ?`).get(main.caseId) as { camera_check: string | null }).camera_check;
  const cam = { ...blankCameraCheck(new Date().toISOString()), state: "ready", grade: "B", gradeRange: { best: "B", worst: "C" }, flags: ["screen glare"], faults: [{ id: "screen_cracked", because: "crack seen", photoIndex: null, confidence: 0.9 }] };
  db().prepare(`UPDATE cases SET camera_check = ? WHERE id = ?`).run(JSON.stringify(cam), main.caseId);
  try {
    const res = await asUser(partner, () => caseRoute.GET(new Request("http://x"), params({ id: main.caseId })));
    const v = (await res.json()) as import("./cases.ts").CaseView;
    assert.equal(v.camera?.grade, null);
    assert.equal(v.camera?.gradeRange, null);
    assert.deepEqual(v.camera?.flags, []);
    assert.equal(v.camera?.faults.length, 1, "the camera's faults are on the case — they stay");
    const staff = cases.getCase(adv, main.caseId);
    assert.equal(staff.camera?.grade, "B");
    assert.deepEqual(staff.camera?.flags, ["screen glare"]);
  } finally {
    db().prepare(`UPDATE cases SET camera_check = ? WHERE id = ?`).run(saved, main.caseId);
  }
});

test("pickups carry the frozen counter grade beside each phone", () => {
  const p = pickups.requestPickup(mgr, { caseIds: [main.caseId] });
  const item = p.items.find((i) => i.id === main.caseId)!;
  assert.equal(item.grading?.label, "Needs repair");
  assert.equal(item.grading?.final, true);
  assert.match(item.grading!.path, /^\/r\/[A-Za-z0-9_-]+\?v=\d+$/);
  const seen = pickups.getPickup(partner, p.id).items.find((i) => i.id === main.caseId)!;
  assert.equal(seen.grading?.version, item.grading?.version);
});

/* ─────────────────────────── backfill, photos ─────────────────────────── */

test("a case tested before reports existed gets v1 'backfill' on first read; an untested one gets none", async () => {
  const t = await testedCase();
  db().prepare(`DELETE FROM grading_reports WHERE case_id = ?`).run(t.caseId);
  const v = cases.getCase(adv, t.caseId);
  assert.equal(v.grading?.report?.version, 1);
  assert.equal(versions(t.caseId)[0].reason, "backfill");
  const untested = cases.createCase(adv, {});
  assert.equal(cases.getCase(adv, untested.id).grading?.report, null);
  assert.equal(gr.gradingReportFor(adv, untested.id).issued, null);
  assert.equal(versions(untested.id).length, 0);
});

test("photos are proxied by index from the version's own list — never a redirect, nothing else", async () => {
  const g = await stub((req, _b, res) => {
    if (req.url === "/api/uploads/abc-1.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      return;
    }
    if (req.url === "/api/uploads/page.html") {
      res.writeHead(200, { "content-type": "text/html" }).end("<html>");
      return;
    }
    res.writeHead(404).end();
  });
  process.env.GRADEIQ_BASE_URL = g.base;
  try {
    const token = (db().prepare(`SELECT report_token FROM cases WHERE id = ?`).get(main.caseId) as { report_token: string }).report_token;
    const top = (db().prepare(`SELECT MAX(version) v FROM grading_reports WHERE case_id = ?`).get(main.caseId) as { v: number }).v;
    db().prepare(`UPDATE grading_reports SET photo_sources = ? WHERE case_id = ? AND version = ?`).run(JSON.stringify(["https://gradeiq.example/api/uploads/abc-1.jpg", "https://gradeiq.example/api/uploads/page.html", "https://evil.example/other"]), main.caseId, top);
    const get = (n: string) => photoRoute.GET(new Request(`http://x/api/r/${token}/photo/${n}`), params({ token, n }));
    const ok = await get("0");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/jpeg");
    assert.equal(g.seen.at(-1)?.url, "/api/uploads/abc-1.jpg");
    assert.equal((await get("1")).status, 502, "not a photo");
    assert.equal((await get("2")).status, 404, "not an upload path");
    assert.equal((await get("7")).status, 404, "not on the list");
  } finally {
    delete process.env.GRADEIQ_BASE_URL;
    await g.close();
  }
});

test("emulator runs can't be graded; nothing failed to issue along the way", async () => {
  const t = await testedCase({ physical: false });
  assert.equal(cases.getCase(adv, t.caseId).grading?.status, "cannot_grade");
  assert.ok(!errors.some((e) => /grading report not issued/.test(e)), errors.join("\n"));
});

/* ─────────────────────────── the store camera when its AI is down ─────────────────────────── */

test("a camera grade that failed (GradeIQ's AI out of credit → its offline stub) never holds Apply; the wait is capped at 180 s", async () => {
  const bridge = await import("./gradeiqBridge.ts");
  const { finality } = await import("../domain/gradeiqMap.ts");
  const was = process.env.GRADEIQ_ENABLED;
  process.env.GRADEIQ_ENABLED = "1";
  try {
    const t = Date.now();
    const ago = (ms: number) => new Date(t - ms).toISOString();
    const row = (snap: object, photosAgo = 20_000) =>
      ({
        gradeiq_state: "ready",
        gradeiq_id: "00000000-0000-4000-8000-000000000000",
        gradeiq_cosmetic_done_at: ago(photosAgo),
        gradeiq_screen: JSON.stringify({ handoffAt: ago(photosAgo - 10_000) }),
        gradeiq_snapshot: JSON.stringify(snap),
        gradeiq_synced_at: ago(1_000),
      }) as unknown as import("./gradeiqBridge.ts").GiqRow;
    // GradeIQ's display check when its AI call fails: a verdict of "unknown", not a missing one.
    const lcd = { verdict: "unknown", confidence: 0, findings: [], note: "Display validation unavailable (AI call failed) — check the screen manually.", source: "stub", patterns: [] };
    const working = { tierUsed: null, cosmeticGrade: null, refining: true, displayCheck: lcd };
    assert.equal(bridge.cameraGradePending(row(working)), true, "a grade still being worked out is waited for");
    assert.equal(bridge.cameraGradePending(row(working, 200_000)), false, "…but never past the 180 s window");
    const stub = { tierUsed: "stub", cosmeticGrade: null, refining: false, displayCheck: lcd };
    assert.equal(finality(stub as never).status, "failed");
    assert.equal(bridge.cameraGradePending(row(stub)), false, "a failed camera grade goes ahead at once — the grade is then provisional (PV1)");
  } finally {
    if (was === undefined) delete process.env.GRADEIQ_ENABLED;
    else process.env.GRADEIQ_ENABLED = was;
  }
});
