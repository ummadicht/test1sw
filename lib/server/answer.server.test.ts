/**
 * THE ANSWER and the SwapUp premium through the REAL server services on a throwaway database
 * (lib/domain/answer.ts, lib/domain/premium.ts): the lock pays the market price + the premium +
 * the bonus off the new phone and HOLDS the market price only; the partner's verdict charges back
 * against the market price, never the premium; the claims list carries the premium; the customer's
 * phone reads the same lines, read-only and leak-free; a browser and a native report of the same
 * phone give the same lines; the grade line agrees with the grading engine and is never better
 * than the report's after-repair grade; a per-grade rate card names its grade; and "All fine" is
 * the three taps in one.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/*.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "swapup-answer-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_") || k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_")) delete process.env[k];
// A stand-in PriceIQ that counts every call: the customer's phone polling must never reach it.
const { startFakePriceiq, S23U_256 } = await import("./testing/fakePriceiq.ts");
const fake = await startFakePriceiq({ "Galaxy S23 Ultra|256": S23U_256 });
const connectPriceiq = () => Object.assign(process.env, { PRICEIQ_BASE_URL: fake.url, PRICEIQ_API_KEY: fake.key });
const disconnectPriceiq = () => {
  delete process.env.PRICEIQ_BASE_URL;
  delete process.env.PRICEIQ_API_KEY;
};
connectPriceiq();

const origLog = console.log;
const origError = console.error;
console.log = () => {};
console.error = () => {};

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db, MIGRATIONS } = await import("./db.ts");
const cases = await import("./cases.ts");
const sessions = await import("./testSessions.ts");
const pickups = await import("./pickups.ts");
const gr = await import("./gradingReport.ts");
const { bonusClaims } = await import("./reports.ts");
const { storeEvents, storePolicy } = await import("./credit.ts");
const { getStore } = await import("./scope.ts");
const { uploadRateCard } = await import("./catalog.ts");
const { resetPriceiqState } = await import("./priceiq.ts");
const { exposure, position } = await import("../domain/credit.ts");
const { DEFAULT_PLAN } = await import("../domain/diagnostics.ts");
const { luhnCheckDigit } = await import("../domain/imei.ts");
const { DEFECT_DEDUCTIONS } = await import("../domain/ratecard.ts");
const { NEW_PHONE_TOO_CHEAP, PREMIUM_RULE_VERSION } = await import("../domain/premium.ts");
const { RULESET_VERSION } = await import("../domain/decision.ts");

after(async () => {
  console.log = origLog;
  console.error = origError;
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

type U = import("./auth.ts").SessionUser;
function who(id: string): U {
  const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE id = ?`).get(id) as { id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null };
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
}
const adv = who("usr_adv_and");
const mgr = who("usr_mgr_and");
const partner = who((db().prepare(`SELECT id FROM users WHERE username = 'partner'`).get() as { id: string }).id);
const S26U_256 = (db().prepare(`SELECT id FROM new_devices WHERE org_id = ? AND model = 'Galaxy S26 Ultra' AND variant = '256GB'`).get(adv.orgId) as { id: string }).id;
const A17 = (db().prepare(`SELECT id, price FROM new_devices WHERE org_id = ? ORDER BY price LIMIT 1`).get(adv.orgId) as { id: string; price: number });

let imeiSeq = 0;
/** Luhn-valid IMEIs whose last four digits are none of this file's amounts. */
const nextImei = () => {
  const body = `3539501${String(1000000 + ++imeiSeq * 7).slice(-7)}`;
  return body + String(luhnCheckDigit(body));
};
const CUSTOMER = { name: "Asha Rao", phone: "9820012345", idType: "aadhaar", idLast4: "1234" };
const CHECKS = { ownership: true, simRemoved: true, imeiMatches: true, noFinanceLock: true, kym: { status: "clear" as const, reference: "SS-1" } };
const COND = { powersOn: true, calls: true, screen: "cracked", body: "dented", issues: [] as string[], accessories: { charger: true, box: false, bill: false }, age: "gt11m" };

/**
 * The partner's one-row rate card F1 is priced from — its grade C (Fair) price ₹25,000, nothing taken
 * off — active only while `fn` prices, with PriceIQ away so the card answers (the price is always the
 * system's: no quote is typed in). Then put away, so later tests see no card.
 */
const ZERO = JSON.parse(JSON.stringify(DEFECT_DEDUCTIONS, (_k, v) => (typeof v === "number" ? 0 : v))) as typeof DEFECT_DEDUCTIONS;
async function withF1Card<T>(fn: () => Promise<T>): Promise<T> {
  disconnectPriceiq();
  uploadRateCard(partner, {
    label: "Week 41 (test)",
    effectiveFrom: "2026-10-05",
    quoteValidityDays: 3,
    csv: "model_id,variant,max_price,good_price,fair_price,best_value_price\ngalaxy-s23-ultra,256GB,40000,30000,25000,20000\n",
    deductions: ZERO,
    activate: true,
  });
  try {
    return await fn();
  } finally {
    db().prepare(`UPDATE rate_cards SET active = 0`).run();
    connectPriceiq();
  }
}

/** Fixture F1's case at the counter: S23 Ultra 256GB, cracked screen on a dented body, ₹25,000 off the partner's card at grade C, the S26 Ultra 256GB. */
async function f1Case() {
  const c = cases.createCase(adv, { customerName: CUSTOMER.name, customerPhone: CUSTOMER.phone });
  return withF1Card(() => cases.updateCase(adv, c.id, { modelId: "galaxy-s23-ultra", variant: "256GB", imei: nextImei(), faults: ["screen_cracked"], condition: COND, upgradeDeviceId: S26U_256 }));
}
const bonusOf = (v: { bonus: { amount: number; override: { amount: number } | null } | null }) => (v.bonus ? (v.bonus.override?.amount ?? v.bonus.amount) : 0);
const rowOf = (id: string) =>
  db().prepare(`SELECT trade_value, premium_value, premium_bp, premium_funded_by, bonus_value, payable, store_id FROM cases WHERE id = ?`).get(id) as {
    trade_value: number;
    premium_value: number | null;
    premium_bp: number | null;
    premium_funded_by: string | null;
    bonus_value: number;
    payable: number;
    store_id: string;
  };
const caseEvents = (storeId: string, caseId: string) => storeEvents(storeId).filter((e) => e.caseId === caseId);

/** A SwapUp Check run on an S23 Ultra 256GB through join → results → complete → Apply. */
async function testedCase(opts: { appVersion?: string; results?: Record<string, "pass" | "fail" | "skip"> } = {}) {
  const created = sessions.createTestSession(adv, { customerName: CUSTOMER.name, customerPhone: CUSTOMER.phone });
  const joined = sessions.joinByCode(
    {
      code: created.session.code,
      installId: `install-${Math.random().toString(36).slice(2, 12)}`,
      appVersion: opts.appVersion ?? "0.9.0",
      device: { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", totalDiskBytes: 256e9, isPhysicalDevice: true },
    },
    "127.0.0.1"
  );
  const ticket = `Ticket ${joined.ticket}`;
  const at = new Date().toISOString();
  const results = DEFAULT_PLAN.filter((p) => p.id !== "battery_health").map((p) => ({ testId: p.id, outcome: opts.results?.[p.id] ?? "pass", at, detail: null }));
  sessions.deviceResults(ticket, { results });
  sessions.deviceComplete(ticket);
  await sessions.applyTestSession(adv, created.session.id).catch(() => undefined); // auto-apply may have won the race
  return { caseId: created.session.caseId, ticket, sessionId: created.session.id };
}

/* ─────────────────────────── the lock (§C1, §C3 #1, #6) ─────────────────────────── */

let locked = "";
test("lock: we pay ₹25,000 + ₹1,000 premium + the bonus off the new phone; the line holds ₹25,000; the audit carries the premium", async () => {
  const v = await f1Case();
  const B = bonusOf(v);
  assert.ok(B > 0, "the seeded campaign gives a bonus");
  assert.deepEqual(v.lockBlockers, [], v.lockBlockers.join(" | "));
  // The credit check is on the MARKET price.
  const store = getStore(v.storeId)!;
  const before = position(storePolicy(store), storeEvents(store.id));
  assert.equal(v.creditCheck?.ok && v.creditCheck.availableAfter, store.credit_limit - before.exposure - 25_000);
  // The answer the customer will see, before the lock: decide() priced the swap exactly as the lock will.
  assert.equal(v.offer!.swap.wePay, 26_000);
  assert.equal(v.offer!.swap.customerPays, 1_54_999 - 26_000 - B);
  assert.equal(v.decision!.upgrade!.pays, v.offer!.swap.customerPays, "decide() and exchange() agree");
  assert.equal(v.decision!.version, RULESET_VERSION);

  const after = cases.lockTradeIn(adv, v.id, { customer: CUSTOMER, checks: CHECKS });
  locked = v.id;
  const r = rowOf(v.id);
  assert.deepEqual([r.trade_value, r.premium_value, r.premium_bp, r.bonus_value, r.payable], [25_000, 1_000, 400, B, 1_54_999 - 26_000 - B]);
  assert.equal(r.premium_funded_by, "SwapUp Experience Centers (demo)", "the programme pays the premium back");
  assert.equal(r.payable, v.decision!.upgrade!.pays, "§C3 #6: decide()'s customer-pays is what the lock charged");
  assert.deepEqual(caseEvents(r.store_id, v.id).map((e) => [e.kind, e.amount]), [["hold", 25_000]]);
  const a = db().prepare(`SELECT detail FROM audit WHERE action = 'case.lock' AND entity_id = ? ORDER BY id DESC LIMIT 1`).get(v.id) as { detail: string };
  const detail = JSON.parse(a.detail) as { tradeValue: number; premium: { amount: number; bp: number; rule: string }; wePay: number };
  assert.deepEqual([detail.tradeValue, detail.premium.amount, detail.premium.bp, detail.premium.rule, detail.wePay], [25_000, 1_000, 400, PREMIUM_RULE_VERSION, 26_000]);
  // The traded answer: the figures frozen at lock.
  assert.equal(after.premiumValue, 1_000);
  assert.equal(after.offer!.answer.headline, "Traded in");
  assert.deepEqual(
    after.offer!.answer.lines.map((l) => l.text),
    ["Current grade C", "Market price for grade C ₹25,000", "We paid you ₹26,000", `+ ₹${B.toLocaleString("en-IN")} bonus with the Galaxy S26 Ultra 256GB`]
  );
});

test("lock: a new phone cheaper than we pay + the bonus is refused — before the lock and at it — never floored", async () => {
  const v = await f1Case();
  const cheap = await cases.updateCase(adv, v.id, { upgradeDeviceId: A17.id });
  assert.ok(A17.price < 26_000 + bonusOf(cheap), `the cheapest phone (₹${A17.price}) is under we pay + bonus`);
  assert.ok(cheap.lockBlockers.includes(NEW_PHONE_TOO_CHEAP), cheap.lockBlockers.join(" | "));
  assert.equal(cheap.offer!.actions.swap, NEW_PHONE_TOO_CHEAP);
  assert.throws(() => cases.lockTradeIn(adv, v.id, { customer: CUSTOMER, checks: CHECKS }), (e: Error & { status?: number }) => e.status === 409);
});

/* ─────────────────────────── the verdict (§C3 #2) ─────────────────────────── */

test("verdict: cleared — no chargeback, exposure 0; regraded to ₹22,000 — a chargeback of ₹3,000 (market − accepted), never the premium", async () => {
  const second = await f1Case();
  cases.lockTradeIn(adv, second.id, { customer: CUSTOMER, checks: CHECKS });
  const p = pickups.requestPickup(mgr, { caseIds: [locked, second.id] });
  pickups.collectPickup(partner, p.id, { collectedCaseIds: [locked, second.id], collectorName: "Sunil", handoverBy: "Priya" });
  pickups.clearItem(partner, p.id, { caseId: locked, outcome: "cleared" });
  pickups.clearItem(partner, p.id, { caseId: second.id, outcome: "regraded", accepted: 22_000, reason: "Back has a deep scratch" });
  const store = rowOf(locked).store_id;
  const one = caseEvents(store, locked);
  assert.ok(!one.some((e) => e.kind === "chargeback"));
  assert.equal(exposure(one), 0);
  const two = caseEvents(store, second.id);
  assert.deepEqual(two.filter((e) => e.kind === "chargeback").map((e) => e.amount), [3_000]);
  assert.ok(two.every((e) => e.amount <= 25_000), "nothing on the line involves the premium");
  // The premium is still what was paid at the counter.
  assert.equal(rowOf(second.id).premium_value, 1_000);
});

/* ─────────────────────────── claims (§C3 #3) ─────────────────────────── */

test("claims: the premium is claimed beside the bonus, from the programme; a regrade shows what the partner accepted; cancelling drops both", async () => {
  const rows = bonusClaims(mgr, {});
  const mine = rows.find((r) => r.caseRef === cases.getCase(adv, locked).ref)!;
  assert.deepEqual([mine.premium, mine.premiumBp, mine.premiumFundedBy, mine.tradeValue, mine.accepted], [1_000, 400, "SwapUp Experience Centers (demo)", 25_000, null]);
  assert.ok(mine.bonus > 0);
  const regraded = rows.find((r) => r.status === "regraded")!;
  assert.deepEqual([regraded.premium, regraded.accepted], [1_000, 22_000], "never re-based on the regrade");
  // Cancel before pickup: both claims go, and the hold of the market price comes back.
  const v = await f1Case();
  cases.lockTradeIn(adv, v.id, { customer: CUSTOMER, checks: CHECKS });
  assert.ok(bonusClaims(mgr, {}).some((r) => r.caseRef === v.ref));
  cases.cancelTradeIn(mgr, v.id, "Customer changed their mind");
  assert.ok(!bonusClaims(mgr, {}).some((r) => r.caseRef === v.ref));
  assert.equal(exposure(caseEvents(rowOf(v.id).store_id, v.id)), 0);
});

/* ─────────────────────────── the partner (R9) ─────────────────────────── */

test("partner: the market price as 'trade-in', and nothing that would give the premium away — no premium, no payable, no new-phone price, no answer", () => {
  const seen = cases.getCase(partner, locked);
  assert.equal(seen.tradeValue, 25_000);
  assert.equal(seen.premiumValue, null);
  assert.equal(seen.payable, null);
  assert.equal(seen.upgrade?.price, null);
  assert.equal(seen.offer, null);
  assert.doesNotMatch(JSON.stringify(seen), /26,000|26000|"wePay"|SwapUp premium/i);
});

/* ─────────────────────────── migration 16 (§C3 #4) ─────────────────────────── */

test("migration 16: an older database's locked case keeps premium_value NULL — and its answer says we paid the market price", () => {
  // A database as 0.8.0 left it: schema 15, a case locked at ₹25,000.
  const file = join(dir, "old.db");
  const old = new Database(file);
  old.pragma("foreign_keys = OFF"); // one bare case row, no org or store
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const step of MIGRATIONS.slice(0, 15)) old.exec(step);
  old.prepare(`INSERT INTO cases (id, ref, org_id, store_id, advisor_id, status, faults, coverage, trade_value, bonus_value, payable, created_at, updated_at) VALUES ('c_old','SU-1','o','s','u','locked','[]','none',25000,6199,123800,'t','t')`).run();
  old.exec(MIGRATIONS[15]);
  const r = old.prepare(`SELECT trade_value, premium_value, premium_bp, premium_funded_by FROM cases WHERE id = 'c_old'`).get() as Record<string, unknown>;
  assert.deepEqual(r, { trade_value: 25000, premium_value: null, premium_bp: null, premium_funded_by: null });
  old.close();
  assert.equal(MIGRATIONS.length, 17, "16 + the IMEI-first columns (17)");
  assert.equal((db().prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value, "17");
  // The same case on this database: locked before premiums.
  const saved = rowOf(locked);
  db().prepare(`UPDATE cases SET premium_value = NULL, premium_bp = NULL, premium_funded_by = NULL WHERE id = ?`).run(locked);
  try {
    const v = cases.getCase(adv, locked);
    assert.equal(v.offer!.answer.wePay, v.tradeValue);
    assert.equal(v.offer!.answer.premium, null);
    assert.equal(v.offer!.answer.staffNotes.we_pay, null);
    assert.equal(v.offer!.answer.lines.find((l) => l.key === "we_pay")!.text, "We paid you ₹25,000");
  } finally {
    db().prepare(`UPDATE cases SET premium_value = ?, premium_bp = ?, premium_funded_by = ? WHERE id = ?`).run(saved.premium_value, saved.premium_bp, saved.premium_funded_by, locked);
  }
});

/* ─────────────────────────── the customer's phone (§E) ─────────────────────────── */

test("device status: applied but no partner price — one sentence ('confirming' a PriceIQ estimate, 'working out' while something may price it, plainly 'can't be priced' when nothing can)", async () => {
  connectPriceiq();
  resetPriceiqState();
  const t = await testedCase();
  const s = sessions.deviceStatus(t.ticket);
  assert.equal(s.status, "applied");
  assert.equal(cases.getCase(adv, t.caseId).quote?.source.kind, "priceiq");
  assert.deepEqual(s.answer, { ready: false, final: false, text: "The advisor is confirming your price.", test: true });
  // PriceIQ has no price for this phone and no card is active: PriceIQ may answer next time — working it out.
  const fold = await cases.updateCase(adv, t.caseId, { modelId: "galaxy-z-fold6", variant: "256GB", faults: [], condition: COND });
  assert.equal(fold.quote?.status, "unpriced");
  assert.deepEqual(sessions.deviceStatus(t.ticket).answer, { ready: false, final: false, text: "The advisor is working out your price.", test: true });
  // SUP-32: nothing can price it here — no card active with PriceIQ off, or a card that doesn't list it.
  const CANT = { ready: false, final: false, text: "This phone can't be priced for trade-in here yet — the advisor will explain.", test: true };
  disconnectPriceiq();
  resetPriceiqState();
  try {
    const n = await testedCase();
    assert.equal(cases.getCase(adv, n.caseId).quote?.reason, "No rate card is active yet.");
    assert.deepEqual(sessions.deviceStatus(n.ticket).answer, CANT);
  } finally {
    connectPriceiq();
  }
  await withF1Card(async () => {
    const off = await cases.updateCase(adv, t.caseId, { modelId: "galaxy-s23-ultra", variant: "512GB", faults: ["screen_cracked"], condition: COND });
    assert.equal(off.quote?.reason, "This phone isn't on the rate card yet.");
    assert.deepEqual(sessions.deviceStatus(t.ticket).answer, CANT);
    // Staff still see the why and the repair line; the card's size prices it, and the customer sees the lines.
    assert.ok(off.offer!.answer.lines.some((l) => l.key === "repair"), "the repair line stays");
    const on = await cases.updateCase(adv, t.caseId, { variant: "256GB" });
    assert.equal(on.quote?.status, "priced");
    assert.equal(sessions.deviceStatus(t.ticket).answer?.ready, true);
  });
});

test("device status: a defect with no fault recorded (no power, liquid, Wi-Fi) — never 'Nothing to repair'; the advisor quotes the repair; the price doesn't move (SUP-96)", async () => {
  const t = await testedCase();
  await withF1Card(async () => {
    const defects: [Record<string, unknown>, string | null][] = [
      [{ powersOn: false }, "no_power"],
      [{ issues: ["liquid"] }, "water_damage"],
      [{ calls: false }, "no_network"],
      [{ issues: ["wifi_bt"] }, null],
    ];
    for (const [over, fault] of defects) {
      const condition = { ...COND, screen: "flawless", body: "flawless", accessories: { charger: true, box: true, bill: true }, age: "lt3m", ...over };
      const v = await cases.updateCase(adv, t.caseId, { modelId: "galaxy-s23-ultra", variant: "256GB", faults: [], condition, upgradeDeviceId: S26U_256 });
      const at = JSON.stringify(over);
      assert.deepEqual(v.faults, [], at);
      assert.equal(v.quote?.status, "priced", at);
      // decide() was told there is a repair to weigh: no quote for it yet, so no verdict.
      assert.equal(v.decision!.recommendation, "cannot_say", at);
      assert.equal(v.offer!.repair.nothingToRepair, false, at);
      assert.equal(v.offer!.repair.why, v.refurbEconomics!.repairCost.why, "the answer and the staff refurb panel say the same");
      assert.match(v.offer!.repair.why ?? "", /^No fault recorded \(.+\) — record it to price the repair\.$/, at);
      const a = sessions.deviceStatus(t.ticket).answer!;
      assert.ok(a.ready, at);
      if (!a.ready) continue;
      assert.equal(a.headline, "Your offer", at);
      assert.equal(a.lines.find((l) => l.key === "repair")?.text, "or repair it — the advisor will quote the price", at);
      assert.ok(!JSON.stringify(a).includes("Nothing to repair"), at);
      // The trade-in reads the condition only: recording the fault changes the repair side, never the price.
      if (!fault) continue;
      const recorded = await cases.updateCase(adv, t.caseId, { faults: [fault], condition });
      assert.equal(recorded.quote?.amount, v.quote?.amount, at);
      assert.equal(recorded.offer!.answer.wePay, v.offer!.answer.wePay, at);
    }
  });
});

test("device status: priced, then locked — the same lines as the desk, read only (no PriceIQ call, no write), and nothing leaks", async () => {
  const t = await testedCase();
  const imei = nextImei();
  const v = await withF1Card(() => cases.updateCase(adv, t.caseId, { imei, faults: ["screen_cracked"], condition: COND, upgradeDeviceId: S26U_256 }));
  assert.equal(v.quote?.source.kind, "partner_ratecard");
  const s1 = sessions.deviceStatus(t.ticket);
  assert.ok(s1.answer && s1.answer.ready, JSON.stringify(s1.answer));
  if (!s1.answer?.ready) return;
  assert.deepEqual(s1.answer.lines, v.offer!.answer.lines, "the phone prints the desk's lines");
  assert.equal(s1.answer.headline, v.offer!.answer.headline);
  assert.equal(s1.answer.final, false);
  assert.equal(s1.answer.test, true, "a test programme says so");

  // Polling is read only: no PriceIQ call, no partner call, no write.
  const calls = fake.calls.length;
  const stamp = (db().prepare(`SELECT updated_at FROM cases WHERE id = ?`).get(t.caseId) as { updated_at: string }).updated_at;
  for (let i = 0; i < 5; i++) sessions.deviceStatus(t.ticket);
  assert.equal(fake.calls.length, calls);
  assert.equal((db().prepare(`SELECT updated_at FROM cases WHERE id = ?`).get(t.caseId) as { updated_at: string }).updated_at, stamp);

  cases.lockTradeIn(adv, t.caseId, { customer: CUSTOMER, checks: CHECKS });
  const s2 = sessions.deviceStatus(t.ticket);
  assert.ok(s2.answer?.ready && s2.answer.final);
  if (!s2.answer?.ready) return;
  assert.equal(s2.answer.headline, "Traded in");
  assert.ok(!s2.answer.lines.some((l) => l.key === "repair"));

  // Never leaks: no partner, IMEI, customer, store margin, premium, source or new-phone price.
  for (const s of [s1, s2]) {
    const json = JSON.stringify(s);
    for (const bad of ["Buyback Partner (demo)", "Week 41 (test)", "PriceIQ", imei, imei.slice(-4), CUSTOMER.name, CUSTOMER.phone, "refurb", "marketSell", "listing", "markdown", "fundedBy", "Repair-to-upgrade bonus", "premium", "source", "asks", "154999", "1,54,999"])
      assert.ok(!json.toLowerCase().includes(bad.toLowerCase()), `device status carries "${bad}"`);
    const keys = new Set<string>();
    const walk = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") for (const [k, val] of Object.entries(x)) (keys.add(k.toLowerCase()), walk(val));
    };
    walk(s);
    for (const k of ["refurbcost", "refurb_cost", "marketsell", "margin", "premium", "bp", "staffnotes", "source", "partner", "imei"]) assert.ok(![...keys].some((x) => x.includes(k)), `key ${k}`);
  }
});

/* ─────────────────────────── browser parity (R4) ─────────────────────────── */

test("parity: the same phone through the browser (the customer's 'no' on beeps, buzz, light, multi-touch, side buttons, Bluetooth) and the native app (skips) — identical lines", async () => {
  // The native app measures beeps, buzz and light and skips when it can't tell; it doesn't run
  // multi-touch or the side buttons (not in its automatic run) and reads Bluetooth off the phone's
  // feature list — never a fail. In the browser each of those is a customer's tap.
  const judged = ["speaker", "vibration", "flash", "multitouch", "buttons", "bluetooth"] as const;
  const native = await testedCase({ appVersion: "0.9.0", results: Object.fromEntries(judged.map((id) => [id, "skip" as const])) });
  const web = await testedCase({ appVersion: "web-0.9.0", results: Object.fromEntries(judged.map((id) => [id, "fail" as const])) });
  // Both priced the same way — the partner's card, asked again — then the same new phone.
  const priceOf = async (id: string) => {
    await withF1Card(() => cases.reprice(adv, id, { requote: true }));
    return cases.updateCase(adv, id, { upgradeDeviceId: S26U_256 });
  };
  const n = await priceOf(native.caseId);
  const w = await priceOf(web.caseId);
  assert.equal(n.quote?.source.kind, "partner_ratecard");
  assert.deepEqual(w.faults, n.faults, "no speaker, touch or buttons fault from a customer's tap");
  assert.deepEqual(w.faults, []);
  assert.deepEqual(w.condition?.issues, n.condition?.issues, "no vibration or Wi-Fi/Bluetooth issue from a customer's 'no'");
  assert.equal(w.quote?.amount, n.quote?.amount, "the same price");
  assert.deepEqual(w.offer!.answer.lines, n.offer!.answer.lines);
  assert.ok(!w.offer!.answer.lines.some((l) => l.key === "repair"), "no repair line from a customer's tap");
  assert.deepEqual(sessions.deviceStatus(web.ticket).answer, sessions.deviceStatus(native.ticket).answer);
  const stored = JSON.parse((db().prepare(`SELECT results FROM test_sessions WHERE id = ?`).get(web.sessionId) as { results: string }).results);
  for (const id of judged) {
    assert.equal(stored[id].outcome, "skip", id);
    assert.equal(stored[id].detail.reason, "Not measured in the browser", id);
  }
});

/* ─────────────────────────── the grade line (§C3 #5, R5) ─────────────────────────── */

test("grade: on a graded phone the answer's grade is the grading engine's; on one that needs repair it IS the report's after-repair grade — one grade", async () => {
  const t = await testedCase();
  const base = cases.getCase(adv, t.caseId).condition!;
  let graded = 0;
  let needsRepair = 0;
  for (const [screen, body] of [["flawless", "flawless"], ["scratched", "flawless"], ["flawless", "scuffed"], ["flawless", "dented"], ["flawless", "bent"]] as const) {
    const v = await cases.updateCase(adv, t.caseId, { condition: { ...base, screen, body } });
    if (v.grading?.status !== "graded") continue;
    graded += 1;
    assert.equal(v.offer!.answer.grade?.word, v.grading.grade, `${screen}/${body}`);
  }
  assert.equal(graded, 5, "every look above is graded");
  for (const [faults, screen, body] of [[["back_cracked"], "flawless", "back_cracked"], [["screen_cracked"], "cracked", "scuffed"], [["screen_cracked", "back_cracked"], "cracked", "back_cracked"]] as const) {
    const v = await cases.updateCase(adv, t.caseId, { faults: [...faults], condition: { ...base, screen, body } });
    const after = gr.gradingReportFor(adv, t.caseId).issued?.body.grade.afterRepair ?? null;
    if (!after) continue;
    needsRepair += 1;
    assert.equal(v.offer!.answer.grade?.word, after, `${faults.join("+")}: shown ${v.offer!.answer.grade?.word}, after repair ${after}`);
  }
  assert.ok(needsRepair >= 2, `the report gave an after-repair grade (${needsRepair})`);
  const back = cases.getCase(adv, t.caseId);
  assert.equal(back.offer!.answer.lines[0].text, "Current grade A", "a cracked back reads as its look — the grade it is priced at and comes out at");
});

/* ─────────────────────────── the per-grade rate card (R13) ─────────────────────────── */

test("rate card by grade: the market price is the card's price at the phone's grade, named on the line — and shown to the customer", async () => {
  disconnectPriceiq();
  resetPriceiqState();
  try {
    uploadRateCard(partner, {
      label: "Week 42",
      effectiveFrom: "2026-10-12",
      quoteValidityDays: 3,
      csv: "model_id,variant,max_price,good_price,fair_price,best_value_price\ngalaxy-s23-ultra,256GB,34960,33574,32255,30672\n",
      deductions: DEFECT_DEDUCTIONS,
      activate: true,
    });
    const c = cases.createCase(adv, {});
    // Nothing taken off (all accessories, under 3 months): the price IS the card's grade C price, named.
    const v = await cases.updateCase(adv, c.id, { modelId: "galaxy-s23-ultra", variant: "256GB", faults: [], condition: { ...COND, screen: "flawless", body: "dented", accessories: { charger: true, box: true, bill: true }, age: "lt3m" }, upgradeDeviceId: S26U_256 });
    assert.equal(v.quote?.source.kind, "partner_ratecard");
    assert.equal(v.quote?.grade, "Fair");
    assert.equal(v.quote?.lines[0].label, "Market price grade C · Week 42");
    assert.equal(v.quote?.amount, 32_255);
    const named = v.offer!.answer.lines.find((l) => l.key === "market")!;
    assert.deepEqual([named.text, named.note], ["Market price for grade C ₹32,255", null]);
    assert.equal(v.offer!.answer.ready, true, "the partner's own card is the market price the customer sees");
    // The same phone over 11 months old: the card takes age off grade C's price — the line still
    // names grade C, and its note works the figure out from grade C's price.
    const old = await cases.updateCase(adv, c.id, { condition: { ...COND, screen: "flawless", body: "dented", accessories: { charger: true, box: true, bill: true }, age: "gt11m" } });
    const m = old.offer!.answer.lines.find((l) => l.key === "market")!;
    const M = old.quote!.amount!;
    assert.ok(M < 32_255);
    assert.deepEqual(
      [m.text, m.note],
      [`Market price for grade C ₹${M.toLocaleString("en-IN")}`, `₹32,255 less ₹${(32_255 - M).toLocaleString("en-IN")} for age over 11 months`],
    );
    assert.equal(old.offer!.answer.staffNotes.market, null);
  } finally {
    connectPriceiq();
  }
});

test("rate card by grade: a cracked back is grade A, priced off grade A less the back glass — the customer's lines say both, and add up", async () => {
  disconnectPriceiq();
  resetPriceiqState();
  try {
    uploadRateCard(partner, {
      label: "Week 43",
      effectiveFrom: "2026-10-19",
      quoteValidityDays: 3,
      csv: "model_id,variant,max_price,good_price,fair_price,best_value_price\ngalaxy-s23-ultra,256GB,40000,30000,25000,20000\n",
      deductions: DEFECT_DEDUCTIONS,
      activate: true,
    });
    const t = await testedCase();
    const v = await cases.updateCase(adv, t.caseId, {
      modelId: "galaxy-s23-ultra",
      variant: "256GB",
      faults: ["back_cracked"],
      condition: { ...COND, screen: "flawless", body: "back_cracked", accessories: { charger: true, box: true, bill: true }, age: "lt3m" },
    });
    assert.equal(v.quote?.source.kind, "partner_ratecard");
    assert.deepEqual([v.quote?.amount, v.quote?.grade, v.quote?.lines[0].label], [34_000, "Superb", "Market price grade A · Week 43"]);
    const staff = v.offer!.answer;
    assert.equal(staff.staffNotes.market, null);
    const s = sessions.deviceStatus(t.ticket).answer;
    assert.ok(s?.ready, JSON.stringify(s));
    if (!s?.ready) return;
    assert.deepEqual(s.lines, staff.lines, "the phone prints the desk's lines");
    const [grade, market, wePay] = s.lines;
    assert.deepEqual([grade.text, grade.note], ["Current grade A", "back glass cracked"]);
    assert.equal(market.text, "Market price for grade A ₹34,000");
    assert.equal(market.note, "₹40,000 less ₹6,000 for back glass cracked");
    assert.equal(wePay.text, "We pay you ₹35,020");
    assert.deepEqual(s.market, { amount: 34_000, letter: "A", word: "Superb" });
  } finally {
    connectPriceiq();
  }
});

/* ─────────────────────────── one-tap "All fine" (R14) ─────────────────────────── */

test("All fine: screen OK, body like new, liquid indicator 'Can't see' — by name, exactly as the three taps", async () => {
  const one = await testedCase();
  const three = await testedCase();
  const a = await cases.certifyCase(adv, one.caseId, { allFine: true });
  for (const [row, value] of [["screen", "ok"], ["body", "like_new"], ["liquid", "cant_see"]] as const) await cases.certifyCase(adv, three.caseId, { row, value });
  const b = cases.getCase(adv, three.caseId);
  const shape = (v: typeof a) => Object.fromEntries(Object.entries(v.certification).map(([k, r]) => [k, [r!.value, r!.label, r!.by, r!.withColours]]));
  assert.deepEqual(shape(a), { screen: ["ok", "OK", adv.name, false], body: ["like_new", "Like new", adv.name, false], liquid: ["cant_see", "Can't see", adv.name, false] });
  assert.deepEqual(shape(a), shape(b));
  assert.deepEqual([a.faults, a.condition?.screen, a.condition?.body], [b.faults, b.condition?.screen, b.condition?.body]);
  assert.equal(a.quote?.amount, b.quote?.amount, "the same price");
  assert.deepEqual(a.offer!.answer.lines, b.offer!.answer.lines, "the same answer");
  const audits = db().prepare(`SELECT detail FROM audit WHERE action = 'case.certify' AND entity_id = ? ORDER BY id`).all(one.caseId) as { detail: string }[];
  assert.deepEqual(audits.map((x) => [JSON.parse(x.detail).row, JSON.parse(x.detail).allFine]), [["screen", true], ["body", true], ["liquid", true]]);
  // Past the counter, refused like any tap.
  await assert.rejects(cases.certifyCase(adv, locked, { allFine: true }), (e: Error & { status?: number }) => e.status === 404 || e.status === 409);
});

test("All fine: never over a row already tapped — a liquid 'Tripped' from SwapUp Store keeps its water damage and its lower price", async () => {
  const clean = await testedCase();
  const desk = await testedCase();
  const store = await testedCase();
  const before = cases.getCase(adv, clean.caseId);
  assert.deepEqual(before.certify?.needed, ["screen", "body", "liquid"], "no camera: the card asks all three");
  // SwapUp Store: the advisor sees the indicator tripped. The screen and body are still untapped,
  // so the desk shows "All fine" — and someone taps it.
  const tripped = await cases.certifyCase(adv, desk.caseId, { row: "liquid", value: "tripped" });
  assert.ok(tripped.faults.includes("water_damage"));
  assert.ok(tripped.quote!.amount! < before.quote!.amount!, "water damage lowers the price");
  const a = await cases.certifyCase(adv, desk.caseId, { allFine: true });
  assert.equal(a.certification.liquid?.value, "tripped", "the liquid row keeps its tap");
  assert.deepEqual([a.certification.screen?.value, a.certification.body?.value], ["ok", "like_new"], "the untapped rows are filled in");
  assert.ok(a.faults.includes("water_damage"), "the water damage stays on the case");
  assert.ok(a.condition?.issues.includes("liquid"), "and its issue");
  assert.ok(a.quote!.amount! < before.quote!.amount!, "the lower price stands");
  // The same phone worked on SwapUp Store tap by tap: the same faults, price and answer.
  for (const [row, value] of [["liquid", "tripped"], ["screen", "ok"], ["body", "like_new"]] as const) await cases.certifyCase(adv, store.caseId, { row, value });
  const s = cases.getCase(adv, store.caseId);
  assert.deepEqual([a.faults, a.condition?.issues, a.quote?.amount], [s.faults, s.condition?.issues, s.quote?.amount]);
  assert.deepEqual(a.offer!.answer.lines, s.offer!.answer.lines);
  // Its audit: only the two rows it tapped.
  const audits = db().prepare(`SELECT detail FROM audit WHERE action = 'case.certify' AND entity_id = ? ORDER BY id`).all(desk.caseId) as { detail: string }[];
  assert.deepEqual(audits.map((x) => [JSON.parse(x.detail).row, JSON.parse(x.detail).value, JSON.parse(x.detail).allFine ?? false]), [["liquid", "tripped", false], ["screen", "ok", true], ["body", "like_new", true]]);
  // Every row tapped: "All fine" again changes nothing.
  const again = await cases.certifyCase(adv, desk.caseId, { allFine: true });
  assert.deepEqual([again.faults, again.certification.liquid?.value, again.quote?.amount], [a.faults, "tripped", a.quote?.amount]);
  // A screen the advisor already called cracked stays cracked.
  const cracked = await testedCase();
  await cases.certifyCase(adv, cracked.caseId, { row: "screen", value: "cracked" });
  const c = await cases.certifyCase(adv, cracked.caseId, { allFine: true });
  assert.deepEqual([c.certification.screen?.value, c.certification.body?.value, c.certification.liquid?.value], ["cracked", "like_new", "cant_see"]);
  assert.ok(c.faults.includes("screen_cracked"));
});

test("All fine: the liquid indicator only where the card asks for it", () => {
  const at = new Date().toISOString();
  const graded = { by: "GradeIQ", state: "ready", final: true, conclusive: true, needsHumanReview: false, suggested: [], lcd: { cameraChecked: true, verdict: "pass", reason: null } };
  const caseRow = (camera: Record<string, unknown>, certification: Record<string, unknown> | null = null) => ({
    status: "quoted",
    camera_check: JSON.stringify({ testSessionId: null, at, ...camera }),
    certification: certification ? JSON.stringify(certification) : null,
    faults: "[]",
  });
  const taps = (c: ReturnType<typeof caseRow>) => cases.allFineTaps(c, null).map((t) => `${t.row}:${t.value}`);
  // The camera graded it all: the card asks nothing, so not the liquid row either.
  assert.deepEqual(cases.certifyBlock(caseRow(graded), null).block.needed, []);
  assert.deepEqual(taps(caseRow(graded)), ["screen:ok", "body:like_new"]);
  // The sweep didn't check the screen: the card asks the screen and the liquid indicator.
  const noSweep = caseRow({ ...graded, lcd: { cameraChecked: false, verdict: null, reason: null } });
  assert.deepEqual(cases.certifyBlock(noSweep, null).block.needed, ["screen", "liquid"]);
  assert.deepEqual(taps(noSweep), ["screen:ok", "body:like_new", "liquid:cant_see"]);
  // A liquid row already tapped keeps its tap.
  const seen = caseRow({ ...graded, lcd: { cameraChecked: false, verdict: null, reason: null } }, { liquid: { value: "clean", by: "Asha", at } });
  assert.deepEqual(taps(seen), ["screen:ok", "body:like_new"]);
});

/* ─────────────────────────── the refurb decision, staff only (SUP-92) ─────────────────────────── */

test("refurb decision: staff get the five lines off the card the trade-in came from, the answer's own offer, the real price book — never the partner or the customer", async () => {
  disconnectPriceiq();
  resetPriceiqState();
  // Week 42 with SwapUp's % per defect, charger / box / bill / age at 0.
  const deductions = { ...DEFECT_DEDUCTIONS, noChargerBp: 0, noBoxBp: 0, noBillBp: 0, age: { lt3m: 0, "3to11m": 0, gt11m: 0 } };
  const upload = (label: string, row: string) =>
    uploadRateCard(partner, {
      label,
      effectiveFrom: "2026-10-12",
      quoteValidityDays: 3,
      csv: `model_id,variant,max_price,good_price,fair_price,best_value_price\n${row}\n`,
      deductions,
      activate: true,
    });
  try {
    upload("Week 42", "galaxy-s23-ultra,256GB,34960,33574,32255,30672");
    const t = await testedCase();
    const cracked = { ...COND, screen: "cracked", body: "flawless" };
    const v = await cases.updateCase(adv, t.caseId, { modelId: "galaxy-s23-ultra", variant: "256GB", faults: ["screen_cracked"], condition: cracked, upgradeDeviceId: S26U_256 });
    const e = v.refurbEconomics!;
    assert.deepEqual([e.preRefurb.amount, e.preRefurb.grade, e.preRefurb.source], [20_970, "A", "Market price — priced at grade A ₹34,960, less 40% screen cracked"]);
    // The seeded Samsung price book and the programme's repair policy: display ₹28,470 + tier S labour ₹425 + 18% GST.
    assert.deepEqual([e.repairCost.amount, e.repairCost.basis, e.repairCost.source], [34_096, "estimate", "SwapUp's repair estimate: display assembly ₹28,470 + labour ₹425 + GST ₹5,201"]);
    assert.equal(e.repairCost.amount, v.offer!.repair.amount, "the estimate the customer's repair line uses");
    assert.deepEqual([e.postRepair.amount, e.postRepair.grade], [34_960, "A"]);
    assert.deepEqual([e.uplift.amount, e.uplift.verdict, e.uplift.text], [-20_106, "as_is", "Send as-is — repairing costs ₹20,106 more than it adds"]);
    // Each number once: the offer is the answer's.
    const answer = v.offer!.answer;
    assert.equal(e.preRefurb.amount, answer.market?.amount);
    assert.equal(e.offer.amount, answer.wePay);
    assert.equal(e.offer.bonus, answer.bonus?.amount ?? null);
    assert.ok(e.offer.bonus && e.offer.source === `As on the answer · + ₹${e.offer.bonus.toLocaleString("en-IN")} bonus with the Galaxy S26 Ultra 256GB`, e.offer.source ?? "");

    // A cracked back (SUP-92 (a)): priced at grade A less 15%; repaired, the 15% comes back at grade A.
    const back = await cases.updateCase(adv, t.caseId, { faults: ["back_cracked"], condition: { ...COND, screen: "flawless", body: "back_cracked" } });
    const b = back.refurbEconomics!;
    assert.deepEqual([b.preRefurb.amount, b.repairCost.amount, b.postRepair.amount, b.postRepair.grade, b.uplift.amount], [29_710, 4_596, 34_960, "A", 654]);
    assert.equal(b.uplift.text, "Repair before pickup: +₹654");
    assert.equal(b.offer.amount, 30_898);
    // The store's own repair cost wins over the estimate.
    const own = await cases.updateCase(adv, t.caseId, { refurbCost: { amount: 2_000 } });
    assert.deepEqual([own.refurbEconomics!.repairCost.basis, own.refurbEconomics!.uplift.text], ["store", "Repair before pickup: +₹3,250"]);
    assert.match(own.refurbEconomics!.repairCost.source!, /^The store's own figure, entered by /);

    // A newer card goes live: the quote stands, and so does the card it was read off.
    upload("Week 43", "galaxy-s23-ultra,256GB,30000,29000,28000,27000");
    assert.equal(cases.getCase(adv, t.caseId).refurbEconomics!.postRepair.amount, 34_960, "the SAME card as the trade-in");

    // Never the partner's, never the customer's.
    assert.equal(cases.forViewer(partner, own).refurbEconomics, null);
    const s = JSON.stringify(sessions.deviceStatus(t.ticket));
    for (const bad of ["refurbEconomics", "Pre-refurb", "post-repair", "Repair before pickup", "Send as-is", "store's own"]) assert.ok(!s.includes(bad), `${bad} reached the customer`);

    // Not on the card: no trade-in price, so nothing to decide — no panel; the answer's Swap up side says why, once.
    const off = await testedCase();
    const n = await cases.updateCase(adv, off.caseId, { modelId: "galaxy-s23-ultra", variant: "512GB", faults: ["screen_cracked"], condition: cracked });
    assert.equal(n.offer!.swap.tradeIn, null);
    assert.equal(n.offer!.swap.why, "This phone isn't on the rate card yet.");
    assert.equal(n.refurbEconomics, null);

    // Traded in: the decision stays, read off the figures frozen at lock, until the partner's pickup.
    await cases.updateCase(adv, t.caseId, { imei: nextImei() });
    const lockedView = cases.lockTradeIn(adv, t.caseId, { customer: CUSTOMER, checks: CHECKS });
    assert.equal(lockedView.status, "locked");
    const l = lockedView.refurbEconomics!;
    assert.deepEqual([l.preRefurb.amount, l.repairCost.amount, l.postRepair.amount, l.uplift.text, l.offer.amount], [29_710, 2_000, 34_960, "Repair before pickup: +₹3,250", 30_898]);
    assert.equal(l.offer.amount, lockedView.offer!.answer.wePay, "the answer's we pay, frozen at lock");
    assert.equal(cases.forViewer(partner, lockedView).refurbEconomics, null);
    for (const status of ["in_pickup", "collected", "cancelled"] as const) {
      db().prepare(`UPDATE cases SET status = ? WHERE id = ?`).run(status, t.caseId);
      assert.equal(cases.getCase(adv, t.caseId).refurbEconomics !== null, status === "in_pickup", status);
    }

    // No trade-in to decide on: the customer chose the repair, or walked away.
    for (const close of [(id: string) => cases.chooseRepair(adv, id), (id: string) => cases.walkAway(adv, id)]) {
      const w = await testedCase();
      const open = await cases.updateCase(adv, w.caseId, { modelId: "galaxy-s23-ultra", variant: "256GB", faults: ["back_cracked"], condition: { ...COND, screen: "flawless", body: "back_cracked" } });
      assert.ok(open.refurbEconomics?.uplift.text, "at the counter, the decision is there");
      const closed = close(w.caseId);
      assert.ok(["repair_chosen", "walked_away"].includes(closed.status), closed.status);
      assert.equal(closed.refurbEconomics, null, closed.status);
    }
  } finally {
    db().prepare(`UPDATE rate_cards SET active = 0`).run();
    connectPriceiq();
  }
});

test("SUP-9: an old typed quote (partner_manual, history only) — GET labels it a typed price; nothing about a grade or the card", async () => {
  const v = await f1Case();
  const locked = cases.lockTradeIn(adv, v.id, { customer: CUSTOMER, checks: CHECKS });
  assert.equal(locked.status, "locked");
  assert.match(locked.partner!.why, /rate card|No rate card/, "a card quote: the line describes the card");
  // What 0.9.0 left on SU-AND-00020: a typed ₹18,888 with a reference, locked. History: never re-priced.
  const typed = { ...locked.quote!, source: { kind: "partner_manual", label: "Partner quote" }, amount: 18_888, lines: [{ label: "Partner quote · ref PQ-20", amount: 18_888 }], partnerRef: "PQ-20" };
  delete (typed as { grade?: string }).grade;
  db().prepare(`UPDATE cases SET quote = ?, condition = ?, trade_value = 18888 WHERE id = ?`).run(JSON.stringify(typed), JSON.stringify({ ...COND, screen: "cracked", body: "back_cracked" }), v.id);
  const g = cases.getCase(adv, v.id);
  assert.equal(g.quote?.source.kind, "partner_manual");
  assert.equal(g.offer!.answer.staffNotes.market, "A price typed in by an older build.");
  assert.equal(g.partner!.why, "A price typed in by an older build.");
  for (const said of [g.offer!.answer.staffNotes.market, g.partner!.why]) assert.doesNotMatch(said ?? "", /grade|card/i);
  assert.equal(g.offer!.answer.lines.find((l) => l.key === "market")!.text, "Market price ₹18,888");
});
