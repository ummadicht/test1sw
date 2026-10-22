/**
 * ONE GRADE, EVERY SCREEN, EVERY CHANGE (owner, 2026-10-22: the partner quote systematic, as the
 * buyback partner's own grading is — "auto grade ...grade match and also if I change condition re
 * grade n price change in all in scenarios").
 *
 * Through the REAL routes the desk and SwapUp Store call (PATCH /api/cases/<id>, POST …/action
 * certify), on a throwaway database with the partner's per-grade rate card active, every way a
 * condition can change — the condition saved whole (the desk's Condition step, the store app's
 * Change condition), the advisor's taps on Check the phone, the storage, the storage unknown — and
 * after EVERY change, on every surface that prints it:
 *
 *   1. the grade is THE SwapUp grade (marketSell.ts tradeInGrade) — the answer's grade line, the
 *      market line, the customer's phone, and the report's grade / after-repair grade all say it;
 *   2. the price is the card's price at THAT grade, less what the condition takes off — exactly what
 *      a fresh priceFromCard says for the case as it now stands (never a stale quote);
 *   3. the market line's sum adds up: grade price less what was taken off = M; we pay = M + premium;
 *   4. the storage chips, when the size is unknown, are each that size's fresh price.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/oneGrade.server.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "swapup-onegrade-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
// No PriceIQ: the partner's card is the price, as it is for every customer-facing answer.
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_") || k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_")) delete process.env[k];

const origLog = console.log;
const origError = console.error;
console.log = () => {};
console.error = () => {};

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const { issueToken } = await import("./auth.ts");
const cases = await import("./cases.ts");
const sessions = await import("./testSessions.ts");
const gr = await import("./gradingReport.ts");
const { uploadRateCard } = await import("./catalog.ts");
const { activeRateCard } = await import("./buyback.ts");
const { orgPartnerId } = await import("./scope.ts");
const { DEFAULT_PLAN } = await import("../domain/diagnostics.ts");
const { luhnCheckDigit } = await import("../domain/imei.ts");
const { DEFECT_DEDUCTIONS, priceFromCard } = await import("../domain/ratecard.ts");
const { MARKET_GRADE_LETTER, tradeInGrade } = await import("../domain/marketSell.ts");
const { premiumOn } = await import("../domain/premium.ts");
const { inr } = await import("../domain/money.ts");
const caseRoute = await import("../../app/api/cases/[id]/route.ts");
const actionRoute = await import("../../app/api/cases/[id]/action/route.ts");

after(() => {
  console.log = origLog;
  console.error = origError;
  rmSync(dir, { recursive: true, force: true });
});

type U = import("./auth.ts").SessionUser;
type View = Awaited<ReturnType<typeof cases.getCase>>;
type Cond = NonNullable<View["condition"]>;
function who(id: string): U {
  const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE id = ?`).get(id) as { id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null };
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
}
const adv = who("usr_adv_and");
const partner = who((db().prepare(`SELECT id FROM users WHERE username = 'partner'`).get() as { id: string }).id);
const S26U_256 = (db().prepare(`SELECT id FROM new_devices WHERE org_id = ? AND model = 'Galaxy S26 Ultra' AND variant = '256GB'`).get(adv.orgId) as { id: string }).id;
const MODEL = "galaxy-s23-ultra";
const SIZES = JSON.parse((db().prepare(`SELECT variants FROM trade_models WHERE id = ?`).get(MODEL) as { variants: string }).variants) as string[];

/* ─────────────────────────── the doors the desk and SwapUp Store use ─────────────────────────── */

const H = globalThis as { __swapupTestHeaders?: Record<string, string> };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function call(res: Promise<Response>): Promise<View> {
  const r = await res;
  const data = (await r.json()) as View & { error?: string };
  assert.equal(r.status, 200, data.error ?? JSON.stringify(data).slice(0, 300));
  return data;
}
async function as<T>(fn: () => Promise<T>): Promise<T> {
  H.__swapupTestHeaders = { authorization: `Bearer ${issueToken(adv)}` };
  try {
    return await fn();
  } finally {
    H.__swapupTestHeaders = {};
  }
}
/** PATCH /api/cases/<id> — the desk's Condition step and the store app's Change condition. */
const patch = (id: string, body: Record<string, unknown>) =>
  as(() => call(caseRoute.PATCH(new Request(`http://x/api/cases/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params(id))));
/** POST /api/cases/<id>/action certify — a tap on Check the phone (desk and store app). */
const tap = (id: string, row: string, value: string) =>
  as(() =>
    call(actionRoute.POST(new Request(`http://x/api/cases/${id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "certify", row, value }) }), params(id))),
  );

/* ─────────────────────────── the partner's card: W42's grade ladder, SwapUp's % table ─────────────────────────── */

const CSV = [
  "model_id,variant,max_price,good_price,fair_price,best_value_price",
  `${MODEL},${SIZES[0]},34960,33574,32255,30672`,
  ...SIZES.slice(1).map((v, i) => `${MODEL},${v},${39_960 + i * 5_000},${38_400 + i * 5_000},${36_900 + i * 5_000},${35_100 + i * 5_000}`),
].join("\n");
uploadRateCard(partner, { label: "Week 42 (test)", effectiveFrom: "2026-10-12", quoteValidityDays: 3, csv: `${CSV}\n`, deductions: DEFECT_DEDUCTIONS, activate: true });
const CARD = activeRateCard(orgPartnerId(adv.orgId))!;
assert.ok(CARD, "the card is active");

let imeiSeq = 0;
const nextImei = () => {
  const body = `3539502${String(2000000 + ++imeiSeq * 13).slice(-7)}`;
  return body + String(luhnCheckDigit(body));
};

/** A case the customer's phone tested (every test passed), so the phone has a status to poll. */
async function testedCase(): Promise<{ id: string; ticket: string }> {
  const created = sessions.createTestSession(adv, { customerName: "Asha Rao", customerPhone: "9820012345" });
  const joined = sessions.joinByCode(
    {
      code: created.session.code,
      installId: `install-${created.session.id.slice(-10)}`,
      appVersion: "0.9.1",
      device: { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", totalDiskBytes: 256e9, isPhysicalDevice: true },
    },
    "127.0.0.1",
  );
  const ticket = `Ticket ${joined.ticket}`;
  const at = new Date().toISOString();
  sessions.deviceResults(ticket, { results: DEFAULT_PLAN.filter((p) => p.id !== "battery_health").map((p) => ({ testId: p.id, outcome: "pass", at, detail: null })) });
  sessions.deviceComplete(ticket);
  await sessions.applyTestSession(adv, created.session.id).catch(() => undefined);
  return { id: created.session.caseId, ticket };
}

/* ─────────────────────────── the invariants, after every change ─────────────────────────── */

const n = (s: string) => Number(s.replace(/,/g, ""));
let checked = 0;

/** Everything a screen shows for this case agrees with ONE grade and a fresh price. */
function holds(v: View, ticket: string | null, where: string) {
  checked += 1;
  const c = v.condition as Cond;
  assert.ok(c, `${where}: a condition`);
  const grade = tradeInGrade(c)!;
  const letter = MARKET_GRADE_LETTER[grade];
  const a = v.offer!.answer;

  // 1. One grade: the answer's grade line, its market line, the report.
  assert.equal(a.grade?.word, grade, `${where}: the grade line is the SwapUp grade`);
  assert.match(a.lines[0].text, new RegExp(`^Current grade ${letter}\\b`), where);
  const report = gr.gradingReportFor(adv, v.id).issued?.body.grade ?? null;
  if (report?.status === "graded") assert.equal(report.grade, grade, `${where}: the report's grade`);
  if (report?.afterRepair) assert.equal(report.afterRepair, grade, `${where}: the report's after-repair grade`);

  const variant = v.device?.variant ?? null;
  if (!variant) {
    // 4. Storage unknown: no price on the case; each chip is that size's fresh price.
    assert.equal(v.quote, null, `${where}: no size, no quote`);
    // The chips the answer asks with (desk storage chips, the store app's sizes): "256GB · ₹18,800".
    const ask = v.offer!.asks.find((x) => x.kind === "storage");
    const chips = ask && "options" in ask ? ask.options : [];
    assert.deepEqual(chips.map((s) => s.variant), SIZES, where);
    for (const s of chips) {
      const want = priceFromCard(CARD, MODEL, s.variant, c);
      assert.equal(s.tradeIn, want.status === "priced" ? want.amount : null, `${where}: the ${s.variant} chip`);
    }
    return;
  }

  // 2. The price: the card's price at THIS grade, less what the condition takes off — fresh.
  const want = priceFromCard(CARD, MODEL, variant, c);
  assert.ok(want.status === "priced", where);
  if (want.status !== "priced") return;
  assert.equal(want.grade, grade, `${where}: the card is read at the SwapUp grade`);
  assert.equal(v.quote?.source.kind, "partner_ratecard", where);
  assert.equal(v.quote?.grade, grade, `${where}: the quote is for the grade shown`);
  assert.equal(v.quote?.amount, want.amount, `${where}: the price is the fresh one (₹${v.quote?.amount} stored, ₹${want.amount} now)`);

  // 3. The lines add up.
  const M = want.amount;
  const m = a.lines.find((l) => l.key === "market")!;
  assert.equal(m.text, `Market price for grade ${letter} ${inr(M)}`, `${where}: the grade priced is the grade shown`);
  const gradePrice = want.lines[0].amount;
  if (M < gradePrice) {
    const sum = /^₹([\d,]+) less ₹([\d,]+)(?: for (.+))?$/.exec(m.note ?? "");
    assert.ok(sum, `${where}: the note works it out (${m.note})`);
    assert.equal(n(sum![1]), gradePrice, `${where}: from grade ${letter}'s own price`);
    assert.equal(n(sum![1]) - n(sum![2]), M, `${where}: the sum adds up`);
  } else assert.equal(m.note, null, `${where}: nothing taken off, nothing to work out`);
  const W = M + (premiumOn(M)?.amount ?? 0);
  assert.equal(a.wePay, W, `${where}: we pay = M + premium`);
  assert.equal(a.lines.find((l) => l.key === "we_pay")?.text, `We pay you ${inr(W)}`, where);

  // The customer's phone prints the desk's lines, word for word.
  if (!ticket) return;
  const phone = sessions.deviceStatus(ticket).answer;
  assert.ok(phone?.ready, `${where}: the customer's phone has the answer`);
  if (phone?.ready) assert.deepEqual(phone.lines, a.lines, `${where}: the phone's lines are the desk's`);
}

/* ─────────────────────────── the scenarios ─────────────────────────── */

const SCREENS = ["flawless", "scratched", "lines_or_spots", "cracked", "not_working"] as const;
const BODIES = ["flawless", "scuffed", "dented", "back_cracked", "bent"] as const;
const ALL_THERE = { charger: true, box: true, bill: true };

test("Change condition (desk Condition step / SwapUp Store): every screen × body, then defects, accessories and age — re-graded and re-priced every time", async () => {
  const t = await testedCase();
  const base = (await patch(t.id, { modelId: MODEL, variant: SIZES[0], imei: nextImei(), upgradeDeviceId: S26U_256 })).condition as Cond;
  const start = { ...base, accessories: ALL_THERE, age: "lt3m" as const };
  for (const screen of SCREENS)
    for (const body of BODIES) {
      const v = await patch(t.id, { faults: [], condition: { ...start, screen, body } });
      holds(v, t.ticket, `${screen}/${body}`);
    }
  for (const over of [
    { issues: ["liquid"] },
    { issues: ["battery", "rear_camera", "speaker"] },
    { calls: false },
    { powersOn: false, screen: "cracked" },
    { accessories: { charger: false, box: false, bill: false } },
    { age: "gt11m" },
    { body: "back_cracked", accessories: { charger: false, box: true, bill: true }, age: "3to11m" },
  ] as const) {
    const v = await patch(t.id, { faults: [], condition: { ...start, ...over } });
    holds(v, t.ticket, JSON.stringify(over));
  }
});

test("there and back: A → B → A gives A's grade and price again — never a quote left over from B", async () => {
  const t = await testedCase();
  const base = (await patch(t.id, { modelId: MODEL, variant: SIZES[0], imei: nextImei() })).condition as Cond;
  const A = { ...base, screen: "flawless", body: "scuffed", accessories: ALL_THERE, age: "lt3m" };
  const B = { ...base, screen: "cracked", body: "back_cracked", issues: ["liquid"], accessories: ALL_THERE, age: "gt11m" };
  const a1 = await patch(t.id, { faults: [], condition: A });
  holds(a1, t.ticket, "A");
  const b = await patch(t.id, { faults: [], condition: B });
  holds(b, t.ticket, "B");
  assert.notEqual(b.quote?.amount, a1.quote?.amount);
  const a2 = await patch(t.id, { faults: [], condition: A });
  holds(a2, t.ticket, "A again");
  assert.equal(a2.quote?.amount, a1.quote?.amount);
  assert.deepEqual(a2.offer!.answer.lines, a1.offer!.answer.lines);
});

test("Check the phone taps (desk and SwapUp Store): each tap re-grades and re-prices — cracked back reads grade A, priced at A", async () => {
  const t = await testedCase();
  const v0 = await patch(t.id, { modelId: MODEL, variant: SIZES[0], imei: nextImei(), upgradeDeviceId: S26U_256 });
  holds(v0, t.ticket, "tested, every test passed");
  const taps: [string, string][] = [
    ["body", "back_cracked"],
    ["screen", "cracked"],
    ["screen", "scratches"],
    ["body", "dents"],
    ["screen", "lines"],
    ["body", "bent"],
    ["screen", "ok"],
    ["body", "scuffs"],
    ["liquid", "tripped"],
    ["liquid", "clean"],
    ["body", "like_new"],
  ];
  let prev = v0.quote?.amount ?? null;
  for (const [row, value] of taps) {
    const v = await tap(t.id, row, value);
    holds(v, t.ticket, `tap ${row}=${value}`);
    if (row === "body" && value === "back_cracked") {
      assert.deepEqual([v.offer!.answer.lines[0].text, v.offer!.answer.lines[0].note], ["Current grade A", "back glass cracked"]);
      assert.match(v.offer!.answer.lines[1].text, /^Market price for grade A ₹/);
    }
    if (value !== "clean") assert.notEqual(v.quote?.amount, prev, `tap ${row}=${value}: the price moved`);
    prev = v.quote?.amount ?? null;
  }
});

test("storage: changing the size re-prices at the same grade; an unknown size shows each size's fresh price, and a condition change re-prices the chips", async () => {
  // A case typed at the desk (no tested phone): the size is only ever what staff choose, so it can be unknown.
  const t = { id: cases.createCase(adv, { customerName: "Asha Rao", customerPhone: "9820012345" }).id, ticket: null };
  await patch(t.id, { modelId: MODEL, variant: SIZES[0], imei: nextImei() });
  const cracked = { powersOn: true, calls: true, screen: "cracked", body: "dented", issues: [], accessories: ALL_THERE, age: "lt3m" };
  holds(await patch(t.id, { faults: [], condition: cracked }), t.ticket, `${SIZES[0]}, cracked/dented`);
  for (const size of SIZES.slice(1)) holds(await patch(t.id, { variant: size }), t.ticket, `${size}, cracked/dented`);
  const unknown = await patch(t.id, { variant: null });
  holds(unknown, t.ticket, "size unknown, cracked/dented");
  holds(await patch(t.id, { faults: [], condition: { ...cracked, screen: "flawless", body: "flawless" } }), t.ticket, "size unknown, like new");
  holds(await patch(t.id, { variant: SIZES[SIZES.length - 1] }), t.ticket, "a size chosen again");
});

test(`the matrix ran: every change above was checked on every surface`, () => {
  assert.ok(checked >= 25 + 7 + 3 + 12 + (SIZES.length + 3), `${checked} changes checked`);
});
