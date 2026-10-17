import { db, tx, nowIso, newId, todayIso } from "./db";
import { hashPassword, orgSettingsDefaults, type SessionUser, type Role } from "./auth";
import seedData from "./seed-data.json";
import type { RateCard } from "../domain/ratecard";
import type { Campaign } from "../domain/bonus";

/**
 * First-boot data. Two kinds, kept apart:
 *
 *   REFERENCE  Samsung India list prices for spare parts and new phones, read
 *              from samsung.com/in on 2026-10-15 and labelled as such (see
 *              scripts/build-seed-data.py and the two research CSVs beside it).
 *   DEMO       the clients, stores, people, campaign, a SAMPLE trade-in rate
 *              card and a handful of example cases, all flagged demo. The
 *              sample card is never a Cashify price, and a non-demo client
 *              cannot lock a trade-in priced from it.
 */

type SeedData = {
  observedAt: string;
  tradeModels: {
    id: string;
    brand: string;
    model: string;
    series: string | null;
    releaseYear: number;
    supportEndYear: number | null;
    variants: string[];
    serviceTier: string;
    carePlusFee: number | null;
    modelCodes?: string[];
    source: unknown;
  }[];
  repairBook: { modelId: string; part: string; price: number; source: unknown }[];
  sampleRateCard: { modelId: string; variant: string; maxPrice: number }[];
  newDevices: { brand: string; model: string; series: string; variant: string; price: number; supportEndYear: number | null; sort: number; source: unknown }[];
};

const DATA = seedData as SeedData;

type G = typeof globalThis & { __swapup_seed?: Promise<void> };
const g = globalThis as G;

export function ensureSeeded(): Promise<void> {
  if (!g.__swapup_seed) {
    g.__swapup_seed = (async () => {
      const has = db().prepare(`SELECT COUNT(*) n FROM orgs`).get() as { n: number };
      if (has.n === 0) seedBase();
      backfillModelCodes();
      renameDemoCentres();
      const demoDone = db().prepare(`SELECT value FROM meta WHERE key = 'demo_cases'`).get();
      if (!demoDone && process.env.SWAPUP_DEMO_CASES !== "0") {
        try {
          await seedDemoCases();
        } catch (e) {
          console.error("[swapup] demo cases failed (base data is fine):", e);
        }
        db().prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('demo_cases', ?)`).run(nowIso());
      }
    })();
  }
  return g.__swapup_seed;
}

/**
 * Databases seeded before model codes existed (production) get them from the
 * seed data: SwapUp Check matches a phone on the code it reports (SM-S901E).
 * Only fills rows that have none, so a code an admin edited is never overwritten.
 */
function backfillModelCodes(): void {
  const empty = db().prepare(`SELECT id FROM trade_models WHERE model_codes = '[]' OR model_codes IS NULL`).all() as { id: string }[];
  if (!empty.length) return;
  const byId = new Map(DATA.tradeModels.map((m) => [m.id, m.modelCodes ?? []]));
  const upd = db().prepare(`UPDATE trade_models SET model_codes = ? WHERE id = ?`);
  db().transaction(() => {
    for (const r of empty) {
      const codes = byId.get(r.id);
      if (codes && codes.length) upd.run(JSON.stringify(codes), r.id);
    }
  })();
}

/**
 * Owner, 2026-10-17: "instead of Samsung service center — SwapUp Experience
 * Center". Databases seeded before that (production) keep the old demo names;
 * rename them once. Demo programme only, and only names still exactly as seeded,
 * so nothing a client typed is touched.
 */
function renameDemoCentres(): void {
  const d = db();
  if (d.prepare(`SELECT 1 FROM meta WHERE key = 'renamed_experience_centers'`).get()) return;
  d.transaction(() => {
    d.prepare(`UPDATE orgs SET name = 'SwapUp Experience Centers (demo)' WHERE id = 'org_samsung_svc' AND demo = 1 AND name = 'Samsung Service Centres (demo)'`).run();
    const st = d.prepare(`UPDATE stores SET name = ? WHERE id = ? AND org_id = 'org_samsung_svc' AND name = ?`);
    st.run("Andheri West Experience Center", "st_and", "Andheri West Service Centre");
    st.run("Koramangala Experience Center", "st_kor", "Koramangala Service Centre");
    d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('renamed_experience_centers', ?)`).run(nowIso());
  })();
}

export const SAMPLE_DEDUCTIONS: RateCard["deductions"] = {
  deadBp: 7500,
  callsBp: 2000,
  screen: { flawless: 0, scratched: 600, lines_or_spots: 3500, cracked: 4000, not_working: 6500 },
  body: { flawless: 0, scuffed: 300, dented: 1200, back_cracked: 1500, bent: 3500 },
  issues: {
    touch: 3000,
    battery: 900,
    charging: 1200,
    rear_camera: 1800,
    front_camera: 1000,
    speaker: 700,
    mic: 700,
    wifi_bt: 1500,
    fingerprint: 800,
    buttons: 600,
    vibration: 300,
    liquid: 4500,
  },
  noChargerBp: 300,
  noBoxBp: 200,
  noBillBp: 300,
  age: { lt3m: 0, "3to11m": 400, gt11m: 800 },
};

function demoPassword(): string {
  return process.env.SWAPUP_DEMO_PASSWORD || "swapup2026";
}

function seedBase(): void {
  const now = nowIso();
  const pw = hashPassword(demoPassword());
  tx(() => {
    const d = db();
    const org = d.prepare(`INSERT INTO orgs (id, name, kind, client_type, target_brand, partner_id, settings, demo, created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    org.run("org_platform", "SwapUp", "platform", null, null, null, "{}", 0, now);
    org.run("ptn_cashify", "Cashify", "partner", null, null, null, "{}", 0, now);
    const s1 = { ...orgSettingsDefaults(), releaseOn: "collected" };
    const s2 = { ...orgSettingsDefaults(), releaseOn: "cleared", maxAgeDays: 5 };
    org.run("org_samsung_svc", "SwapUp Experience Centers (demo)", "client", "oem_service", "Samsung", "ptn_cashify", JSON.stringify(s1), 1, now);
    org.run("org_xc", "Any Client — Experience Centres (demo)", "client", "experience_center", "Samsung", "ptn_cashify", JSON.stringify(s2), 1, now);

    const store = d.prepare(`INSERT INTO stores (id, org_id, name, kind, city, code, credit_limit, created_at) VALUES (?,?,?,?,?,?,?,?)`);
    store.run("st_and", "org_samsung_svc", "Andheri West Experience Center", "service_center", "Mumbai", "AND", 300_000, now);
    store.run("st_kor", "org_samsung_svc", "Koramangala Experience Center", "service_center", "Bengaluru", "KOR", 95_000, now);
    store.run("st_cpx", "org_xc", "Connaught Place Experience Centre", "experience_center", "New Delhi", "CPX", 500_000, now);

    const user = d.prepare(`INSERT INTO users (id, org_id, store_id, username, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?,?)`);
    const users: [string, string, string | null, string, string, Role][] = [
      ["usr_platform", "org_platform", null, "platform", "SwapUp Ops", "platform"],
      ["usr_cashify", "ptn_cashify", null, "cashify", "Cashify Ops (demo)", "partner"],
      ["usr_samsung", "org_samsung_svc", null, "samsung", "Programme Admin (demo)", "org_admin"],
      ["usr_mgr_and", "org_samsung_svc", "st_and", "manager", "Priya Nair", "store_manager"],
      ["usr_adv_and", "org_samsung_svc", "st_and", "advisor", "Rahul Desai", "advisor"],
      ["usr_mgr_kor", "org_samsung_svc", "st_kor", "manager.kor", "Kiran Rao", "store_manager"],
      ["usr_adv_kor", "org_samsung_svc", "st_kor", "advisor.kor", "Divya Shetty", "advisor"],
      ["usr_xc_admin", "org_xc", null, "xc.admin", "Experience Admin (demo)", "org_admin"],
      ["usr_xc_mgr", "org_xc", "st_cpx", "xc.manager", "Arjun Mehta", "store_manager"],
      ["usr_xc_adv", "org_xc", "st_cpx", "xc.advisor", "Sana Qureshi", "advisor"],
    ];
    for (const u of users) user.run(...u, pw, now);

    const tm = d.prepare(
      `INSERT INTO trade_models (id, brand, model, series, release_year, support_end_year, variants, service_tier, care_plus_fee, model_codes, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const m of DATA.tradeModels)
      tm.run(m.id, m.brand, m.model, m.series, m.releaseYear, m.supportEndYear, JSON.stringify(m.variants), m.serviceTier, m.carePlusFee, JSON.stringify(m.modelCodes ?? []), JSON.stringify(m.source));

    const rb = d.prepare(`INSERT INTO repair_book (org_id, model_id, part, price, source) VALUES (?,?,?,?,?)`);
    const nd = d.prepare(`INSERT INTO new_devices (id, org_id, brand, model, series, variant, price, support_end_year, active, sort, source) VALUES (?,?,?,?,?,?,?,?,1,?,?)`);
    for (const orgId of ["org_samsung_svc", "org_xc"]) {
      for (const r of DATA.repairBook) rb.run(orgId, r.modelId, r.part, r.price, JSON.stringify(r.source));
      for (const n of DATA.newDevices) nd.run(newId("nd"), orgId, n.brand, n.model, n.series, n.variant, n.price, n.supportEndYear, n.sort, JSON.stringify(n.source));
    }

    const card: RateCard = {
      id: "rc_sample",
      partner: "Cashify",
      source: {
        kind: "sample",
        label: "SAMPLE rate card — illustrative values, not Cashify prices",
        effectiveFrom: DATA.observedAt,
        note: "Replace by uploading the partner's own rate card on /partner/rate-cards, or connect the live API.",
      },
      quoteValidityDays: 3,
      roundTo: 10,
      maxDeductionBp: 8500,
      floorBp: 600,
      deductions: SAMPLE_DEDUCTIONS,
      entries: DATA.sampleRateCard,
    };
    d.prepare(`INSERT INTO rate_cards (id, partner_id, data, active, created_by, created_at) VALUES (?,?,?,1,?,?)`).run("rc_sample", "ptn_cashify", JSON.stringify(card), "usr_platform", now);

    const start = todayIso().slice(0, 8) + "01";
    const c1: Campaign = {
      id: "cmp_svc_repair_to_upgrade",
      name: "Repair-to-upgrade bonus",
      basis: "new_price",
      minBp: 200,
      maxBp: 500,
      capRupees: 7500,
      fundedBy: "Brand (claimed monthly)",
      startsOn: start,
      endsOn: null,
      rules: [
        { id: "base", label: "Upgrade bonus — base rate", bp: 200, when: { kind: "always" } },
        { id: "flagship", label: "Upgrading to a Galaxy S or Z", bp: 100, when: { kind: "target_series", series: ["S", "Z"] } },
        { id: "repair", label: "Repair would cost half the phone's value or more", bp: 100, when: { kind: "repair_ratio_gte", ratio: 0.5 } },
        { id: "old", label: "Old phone is 4+ years old", bp: 50, when: { kind: "old_age_years_gte", years: 4 } },
        { id: "conquest", label: "Switching from another brand", bp: 100, when: { kind: "old_brand", brands: ["Apple", "OnePlus", "Xiaomi", "Vivo", "Oppo", "Google"] } },
      ],
    };
    const c2: Campaign = {
      ...c1,
      id: "cmp_xc_upgrade",
      name: "Experience Centre upgrade bonus",
      maxBp: 400,
      capRupees: 6000,
      rules: c1.rules.filter((r) => r.id !== "repair"),
    };
    const camp = d.prepare(`INSERT INTO campaigns (id, org_id, data, active, created_at) VALUES (?,?,?,1,?)`);
    camp.run(c1.id, "org_samsung_svc", JSON.stringify(c1), now);
    camp.run(c2.id, "org_xc", JSON.stringify(c2), now);
  });
}

/* ── demo cases, driven through the real services so the ledger is real ── */

function sessionFor(userId: string): SessionUser {
  const u = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE id = ?`).get(userId) as {
    id: string;
    username: string;
    name: string;
    role: Role;
    org_id: string;
    store_id: string | null;
  };
  return { id: u.id, username: u.username, name: u.name, role: u.role, orgId: u.org_id, storeId: u.store_id, exp: Date.now() + 3_600_000 };
}

function deviceId(orgId: string, model: string, variant: string): string {
  const r = db().prepare(`SELECT id FROM new_devices WHERE org_id = ? AND model = ? AND variant = ?`).get(orgId, model, variant) as { id: string } | undefined;
  if (!r) throw new Error(`demo seed: no new device ${model} ${variant}`);
  return r.id;
}

const CHECKS = {
  ownership: true,
  simRemoved: true,
  imeiMatches: true,
  noFinanceLock: true,
  kym: { status: "clear" as const, reference: "KYM SMS reply (demo)" },
};

function backdate(caseId: string, days: number): void {
  const at = new Date(Date.now() - days * 86_400_000).toISOString();
  db().prepare(`UPDATE cases SET created_at = ?, locked_at = CASE WHEN locked_at IS NULL THEN NULL ELSE ? END, updated_at = ? WHERE id = ?`).run(at, at, at, caseId);
  db().prepare(`UPDATE credit_ledger SET at = ? WHERE case_id = ? AND kind = 'hold'`).run(at, caseId);
}

async function seedDemoCases(): Promise<void> {
  const cases = await import("./cases");
  const pickups = await import("./pickups");
  const adv = sessionFor("usr_adv_and");
  const mgr = sessionFor("usr_mgr_and");
  const ptn = sessionFor("usr_cashify");
  const acc = (charger: boolean, box: boolean, bill: boolean, age: "lt3m" | "3to11m" | "gt11m") => ({ accessories: { charger, box, bill }, age });

  type Spec = {
    who: SessionUser;
    name: string;
    phone: string;
    model: string;
    variant: string;
    imei: string;
    faults: string[];
    coverage?: "none" | "warranty" | "care_plus";
    extra?: { body?: string; issues?: string[] };
    accessories: ReturnType<typeof acc>;
    upgrade?: [string, string];
  };
  const make = async (s: Spec) => {
    const c = cases.createCase(s.who, { customerName: s.name, customerPhone: s.phone, demo: true });
    await cases.updateCase(s.who, c.id, { modelId: s.model, variant: s.variant, imei: s.imei, faults: s.faults, coverage: s.coverage ?? "none" });
    const v1 = await cases.updateCase(s.who, c.id, { conditionFromFaults: true });
    const cond = { ...v1.condition!, ...acc(s.accessories.accessories.charger, s.accessories.accessories.box, s.accessories.accessories.bill, s.accessories.age) };
    if (s.extra?.body) cond.body = s.extra.body as typeof cond.body;
    if (s.extra?.issues) cond.issues = [...new Set([...cond.issues, ...s.extra.issues])].sort() as typeof cond.issues;
    await cases.updateCase(s.who, c.id, { condition: cond });
    if (s.upgrade) await cases.updateCase(s.who, c.id, { upgradeDeviceId: deviceId(s.who.orgId, s.upgrade[0], s.upgrade[1]) });
    return c.id;
  };
  const lock = (who: SessionUser, id: string, name: string, phone: string, idType = "aadhaar", last4 = "4821") =>
    cases.lockTradeIn(who, id, { customer: { name, phone, idType, idLast4: last4 }, checks: CHECKS });
  // The customer reset the phone after accepting; the store saw the setup screen.
  const cleared = (who: SessionUser, id: string) =>
    cases.recordDataClear(who, id, { accountsSignedOut: true, resetDone: true, setupScreenSeen: true, noPreviousAccount: true });

  // Andheri — the full journey.
  const a1 = await make({ who: adv, name: "Meera Iyer", phone: "9820012345", model: "galaxy-s22", variant: "128GB", imei: "35278912345678", faults: ["screen_cracked", "battery_drain"], accessories: acc(true, false, true, "gt11m"), upgrade: ["Galaxy S25", "256GB"] });
  lock(adv, a1, "Meera Iyer", "9820012345");
  cleared(adv, a1);
  backdate(a1, 6);

  const a2 = await make({ who: adv, name: "Vikram Joshi", phone: "9867012345", model: "galaxy-a54-5g", variant: "128GB", imei: "35412309876543", faults: ["battery_drain"], accessories: acc(true, true, true, "gt11m"), upgrade: ["Galaxy A56 5G", "8GB+256GB"] });
  cases.chooseRepair(adv, a2);

  const a3 = await make({ who: adv, name: "Farhan Shaikh", phone: "9930012345", model: "galaxy-s21-fe", variant: "128GB", imei: "35999912345670", faults: ["back_cracked"], extra: { body: "back_cracked" }, accessories: acc(false, false, false, "gt11m"), upgrade: ["Galaxy S25 FE", "256GB"] });
  lock(adv, a3, "Farhan Shaikh", "9930012345", "pan", "123F");
  backdate(a3, 4);

  const a4 = await make({ who: adv, name: "Ananya Kulkarni", phone: "9769012345", model: "iphone-13", variant: "128GB", imei: "35345612345678", faults: [], extra: { body: "scuffed" }, accessories: acc(true, true, true, "gt11m"), upgrade: ["Galaxy S26", "256GB"] });
  lock(adv, a4, "Ananya Kulkarni", "9769012345");
  const a5 = await make({ who: adv, name: "Rohan Pillai", phone: "9821012345", model: "galaxy-z-flip5", variant: "256GB", imei: "35123498765432", faults: ["display_lines"], accessories: acc(true, true, false, "gt11m"), upgrade: ["Galaxy Z Flip7", "256GB"] });
  lock(adv, a5, "Rohan Pillai", "9821012345", "driving_licence", "0042");
  cleared(adv, a4);
  cleared(adv, a5);
  backdate(a4, 12);
  backdate(a5, 11);

  // A completed pickup: requested → scheduled → collected → verified (one regrade) → settled.
  const p1 = pickups.requestPickup(mgr, { caseIds: [a4, a5], demo: true });
  pickups.schedulePickup(ptn, p1.id, { scheduledFor: new Date(Date.now() - 9 * 86_400_000).toISOString(), collectorName: "Sunil (Cashify)" });
  pickups.collectPickup(ptn, p1.id, { collectedCaseIds: [a4, a5], collectorName: "Sunil (Cashify)", handoverBy: "Priya Nair" });
  pickups.clearItem(ptn, p1.id, { caseId: a4, outcome: "cleared" });
  const a5v = cases.getCase(mgr, a5);
  pickups.clearItem(ptn, p1.id, { caseId: a5, outcome: "regraded", accepted: Math.floor(((a5v.tradeValue ?? 0) * 0.8) / 10) * 10, reason: "Hinge creaks and a pressure mark on the inner display not declared at the counter" });
  pickups.settlePickup(ptn, p1.id, { reference: "UTR-DEMO-0001" });
  db().prepare(`UPDATE pickups SET requested_at = ?, collected_at = ?, reconciled_at = ?, settled_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 10 * 86_400_000).toISOString(),
    new Date(Date.now() - 9 * 86_400_000).toISOString(),
    new Date(Date.now() - 7 * 86_400_000).toISOString(),
    new Date(Date.now() - 5 * 86_400_000).toISOString(),
    p1.id
  );
  // Keep each phone's own timeline in step with the backdated pickup: verdicts on
  // the verification day, payment on the settlement day (not "now", after both).
  db().prepare(`UPDATE cases SET clearance = json_set(clearance, '$.at', ?), closed_at = ?, settled_at = ? WHERE pickup_id = ?`).run(
    new Date(Date.now() - 7 * 86_400_000).toISOString(),
    new Date(Date.now() - 7 * 86_400_000).toISOString(),
    new Date(Date.now() - 5 * 86_400_000).toISOString(),
    p1.id
  );

  // In progress at the counter right now.
  await make({ who: adv, name: "Sneha Patil", phone: "9819012345", model: "galaxy-s23", variant: "128GB", imei: "35000011112222", faults: ["screen_cracked"], accessories: acc(true, false, true, "gt11m") });
  const w = await make({ who: adv, name: "Imran Khan", phone: "9833012345", model: "galaxy-m32", variant: "128GB", imei: "35987600011122", faults: ["charging_issue"], accessories: acc(true, false, false, "gt11m") });
  cases.walkAway(adv, w, "Wanted to think about it");

  // Koramangala — a line close to its limit, so the warning shows.
  const advK = sessionFor("usr_adv_kor");
  for (const [name, phone, model, variant, imei, faults, up] of [
    ["Lakshmi Narayan", "9845012345", "galaxy-s23-ultra", "256GB", "35201911112223", ["screen_cracked"], ["Galaxy S26 Ultra", "256GB"]],
    ["Deepak Hegde", "9880012345", "galaxy-z-fold5", "256GB", "35201911112231", ["display_lines"], ["Galaxy Z Fold7", "256GB"]],
    ["Pooja Reddy", "9886012345", "galaxy-s24", "128GB", "35201911112249", [], ["Galaxy S26", "256GB"]],
  ] as [string, string, string, string, string, string[], [string, string]][]) {
    const id = await make({ who: advK, name, phone, model, variant, imei, faults, accessories: acc(true, true, true, "gt11m"), upgrade: up });
    try {
      lock(advK, id, name, phone);
      backdate(id, 3);
    } catch {
      /* a demo device that would breach the line just stays quoted — which is the point of the line */
    }
  }

  // Connaught Place — any-brand experience centre.
  const advX = sessionFor("usr_xc_adv");
  const x1 = await make({ who: advX, name: "Kabir Malhotra", phone: "9811012345", model: "oneplus-11", variant: "256GB", imei: "35776611223344", faults: [], extra: { body: "scuffed" }, accessories: acc(true, true, true, "gt11m"), upgrade: ["Galaxy S25 Ultra", "256GB"] });
  lock(advX, x1, "Kabir Malhotra", "9811012345", "voter_id", "7731");
  backdate(x1, 2);
}
