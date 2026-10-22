/**
 * First boot and the clean-ups that run on every boot (lib/server/seed.ts), on a throwaway database.
 *
 * Owner, 2026-10-18 — "Remove sample data": a new database gets the test programmes (orgs, stores,
 * people, logins, campaigns) and the buyback partner, but no rate card of SwapUp's own and no
 * example cases. A database seeded before that loses its example cases once — exactly the ones the
 * old first boot made, never a case staff or a test opened. And the partner's former brand is
 * renamed out of the data, read from the partner's own row, never spelled in the code.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/*.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { namesBrand } from "../domain/testing/brand.ts";

const dir = mkdtempSync(join(tmpdir(), "swapup-seed-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
delete process.env.SWAPUP_DEMO_PASSWORD;
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_")) delete process.env[k];

const origLog = console.log;
console.log = () => {};
const { ensureSeeded, renameDemoPartner, renameDemoPartnerIds, removeExampleCases, retireOldQuotes, rewordQuoteTexts, RETIRED_QUOTE_CANCEL_REASON, demoPartnerId, DEMO_PARTNER, SEEDED_EXAMPLE_CASES } = await import("./seed.ts");
const { quoteSourceLabel, retiredSource, NOT_ON_CARD, RETIRED_QUOTE_LABEL } = await import("../domain/ratecard.ts");
const { NO_MARKET_PRICE } = await import("../domain/offer.ts");
const { checkLedger } = await import("../domain/credit.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const { authenticate } = await import("./auth.ts");
const { partnerMode } = await import("./buyback.ts");
const cases = await import("./cases.ts");

after(() => {
  console.log = origLog;
  rmSync(dir, { recursive: true, force: true });
});

const one = <T>(sql: string, ...args: unknown[]) => db().prepare(sql).get(...args) as T;
const count = (sql: string, ...args: unknown[]) => one<{ n: number }>(sql, ...args).n;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

type U = import("./auth.ts").SessionUser;
const userNamed = (username: string): U => {
  const r = one<{ id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null }>(`SELECT id, username, name, role, org_id, store_id FROM users WHERE username = ?`, username);
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
};

test("a new database: the test programmes and their logins — no rate card of SwapUp's own, no example cases, no pickups", () => {
  assert.deepEqual(
    (db().prepare(`SELECT id, demo FROM orgs WHERE kind = 'client' ORDER BY id`).all() as { id: string; demo: number }[]).map((o) => [o.id, o.demo]),
    [
      ["org_samsung_svc", 1],
      ["org_xc", 1],
    ]
  );
  assert.equal(count(`SELECT COUNT(*) n FROM stores`), 3);
  for (const login of ["advisor", "manager", "samsung", "partner", "platform", "advisor.kor", "xc.advisor"]) assert.ok(authenticate(login, "swapup2026"), login);
  assert.equal(demoPartnerId(), DEMO_PARTNER.orgId);
  assert.equal(one<{ name: string }>(`SELECT name FROM orgs WHERE id = ?`, DEMO_PARTNER.orgId).name, "Buyback Partner (demo)");
  assert.equal(count(`SELECT COUNT(*) n FROM rate_cards`), 0, "no SAMPLE card: prices come from PriceIQ or the partner's card");
  assert.equal(count(`SELECT COUNT(*) n FROM cases`), 0, "no example cases");
  assert.equal(count(`SELECT COUNT(*) n FROM pickups`), 0);
  assert.equal(count(`SELECT COUNT(*) n FROM credit_ledger`), 0);
  assert.equal(count(`SELECT COUNT(*) n FROM campaigns`), 2, "the bonus campaigns stay");
  assert.equal(count(`SELECT COUNT(*) n FROM trade_models WHERE json_extract(source, '$.kind') NOT IN ('oem_public', 'approximate')`), 0);
  const mode = partnerMode(DEMO_PARTNER.orgId);
  assert.equal(mode.kind, "none");
  assert.ok(!namesBrand(`${mode.label} ${mode.why}`));
});

test("a database seeded under the partner's former name: renamed once — read from the partner's own row, only SwapUp's own sentences", () => {
  const d = db();
  const OLD = "Oldbrand"; // any former name: the pass reads it from the row, it is never spelled in the code
  const P = DEMO_PARTNER;
  const u = userNamed("advisor");
  const c1 = cases.createCase(u, { customerName: "Copy test" });
  const c2 = cases.createCase(u, { customerName: "Typed by a person" });
  const manualQuote = {
    status: "priced",
    amount: 12_000,
    lines: [{ label: `${OLD} quote · ref OB-82731`, amount: 12_000 }],
    source: { kind: "partner_manual", label: `Entered from the ${OLD} app by Rahul Desai` },
    partner: OLD,
    partnerRef: "OB-82731",
  };
  const repaired = { ...manualQuote, amount: 16_000, lines: [{ label: `${OLD} value in repaired condition`, amount: 16_000 }] };
  const flags = { flags: [`Storage: the phone measures 1TB, which isn't a size on file. Check Settings › About phone, and enter the ${OLD} quote on the full case if it's really 1TB.`] };
  const clearance = { outcome: "regraded", accepted: 9_000, reason: `${OLD}'s own check found a dent`, by: `${OLD} Ops (demo)` };
  const NO_PRICE_OLD = `The ${OLD} rate card has no price for this model and storage — ask the partner for a quote rather than using a similar model.`;
  const chips = [{ variant: "256GB", amount: null, reason: NO_PRICE_OLD }];
  d.prepare(`UPDATE cases SET quote = ?, repaired_quote = ?, camera_check = ?, clearance = ?, storage_quotes = ? WHERE id = ?`).run(
    JSON.stringify(manualQuote),
    JSON.stringify(repaired),
    JSON.stringify(flags),
    JSON.stringify(clearance),
    JSON.stringify(chips),
    c1.id
  );
  // Another partner, really called that, with a client of its own: never touched.
  d.prepare(`INSERT INTO orgs (id, name, kind, client_type, target_brand, partner_id, settings, demo, created_at) VALUES ('ptn_real', ?, 'partner', NULL, NULL, NULL, '{}', 0, '2026-10-17T00:00:00Z')`).run(OLD);
  d.prepare(`INSERT INTO orgs (id, name, kind, client_type, target_brand, partner_id, settings, demo, created_at) VALUES ('org_real', 'Real Client', 'client', 'experience_center', 'Samsung', 'ptn_real', '{}', 0, '2026-10-17T00:00:00Z')`).run();
  d.prepare(`INSERT INTO stores (id, org_id, name, kind, code, credit_limit, created_at) VALUES ('st_real', 'org_real', 'Real Store', 'retail', 'REA', 100000, '2026-10-17T00:00:00Z')`).run();
  const otherQuote = JSON.stringify({ ...manualQuote, lines: [{ label: `${OLD} quote · ref R-1`, amount: 12_000 }] });
  d.prepare(`UPDATE cases SET org_id = 'org_real', store_id = 'st_real', quote = ? WHERE id = ?`).run(otherQuote, c2.id);
  // The demo partner as an older first boot named it.
  d.prepare(`UPDATE orgs SET name = ? WHERE id = ?`).run(OLD, P.orgId);
  d.prepare(`UPDATE users SET username = ?, name = ? WHERE id = ?`).run(OLD.toLowerCase(), `${OLD} Ops (demo)`, P.userId);
  d.prepare(`INSERT INTO pickups (id, ref, org_id, store_id, partner_id, status, collector_name, demo, requested_at) VALUES ('pk_seeded', 'PK-AND-0001', 'org_samsung_svc', 'st_and', ?, 'settled', ?, 1, '2026-10-05T00:00:00Z')`).run(P.orgId, `Sunil (${OLD})`);
  d.prepare(`INSERT INTO pickups (id, ref, org_id, store_id, partner_id, status, collector_name, demo, requested_at) VALUES ('pk_typed', 'PK-AND-0002', 'org_samsung_svc', 'st_and', ?, 'settled', ?, 0, '2026-10-05T00:00:00Z')`).run(P.orgId, `Sunil (${OLD})`);
  d.prepare(`DELETE FROM meta WHERE key = 'renamed_demo_partner'`).run();

  renameDemoPartner();

  assert.equal(one<{ name: string }>(`SELECT name FROM orgs WHERE id = ?`, P.orgId).name, "Buyback Partner (demo)");
  assert.deepEqual(one(`SELECT username, name FROM users WHERE id = ?`, P.userId), { username: "partner", name: "Partner Ops (demo)" });
  assert.equal(authenticate("partner", "swapup2026")?.id, P.userId);
  const q = one<{ quote: string; repaired_quote: string; camera_check: string; clearance: string; storage_quotes: string }>(`SELECT quote, repaired_quote, camera_check, clearance, storage_quotes FROM cases WHERE id = ?`, c1.id);
  assert.deepEqual(JSON.parse(q.quote).lines, [{ label: "Buyback Partner (demo) quote · ref OB-82731", amount: 12_000 }]);
  assert.equal(JSON.parse(q.quote).source.label, "Entered from the Buyback Partner (demo) app by Rahul Desai");
  assert.equal(JSON.parse(q.quote).partner, "Buyback Partner (demo)");
  assert.equal(JSON.parse(q.quote).partnerRef, "OB-82731", "a reference someone typed is kept as typed");
  assert.equal(JSON.parse(q.repaired_quote).lines[0].label, "Buyback Partner (demo) value in repaired condition");
  assert.match(JSON.parse(q.camera_check).flags[0], /enter the partner's quote on the full case if it's really 1TB\.$/);
  assert.deepEqual(JSON.parse(q.clearance), { ...clearance, by: "Partner Ops (demo)" }, "the verdict's reason is the partner's own words — kept");
  assert.equal(JSON.parse(q.storage_quotes)[0].reason, "No rate-card price for this model and storage — ask the partner.");
  assert.equal(one<{ collector_name: string }>(`SELECT collector_name FROM pickups WHERE id = 'pk_seeded'`).collector_name, "Sunil (partner)");
  // Never another partner's rows, never a name someone typed.
  assert.equal(one<{ name: string }>(`SELECT name FROM orgs WHERE id = 'ptn_real'`).name, OLD);
  assert.equal(one<{ quote: string }>(`SELECT quote FROM cases WHERE id = ?`, c2.id).quote, otherQuote);
  assert.equal(one<{ collector_name: string }>(`SELECT collector_name FROM pickups WHERE id = 'pk_typed'`).collector_name, `Sunil (${OLD})`);

  // Once: the former name put back by hand is not renamed again.
  d.prepare(`UPDATE orgs SET name = ? WHERE id = ?`).run(OLD, P.orgId);
  renameDemoPartner();
  assert.equal(one<{ name: string }>(`SELECT name FROM orgs WHERE id = ?`, P.orgId).name, OLD);
  d.prepare(`UPDATE orgs SET name = ? WHERE id = ?`).run(P.name, P.orgId);
  d.prepare(`DELETE FROM pickups WHERE id IN ('pk_seeded', 'pk_typed')`).run();
});

test("stored words that asked staff to type a trade-in price are reworded on every boot — SwapUp's exact sentences only, idempotent", () => {
  const d = db();
  const u = userNamed("advisor");
  const c = cases.createCase(u, { customerName: "Reword test" });
  const quote = { status: "unpriced", amount: null, lines: [], source: { kind: "none", label: "No market price" }, partner: "Buyback Partner (demo)", partnerRef: null, reason: "No market price yet — enter a quote." };
  const chips = [
    { variant: "256GB", amount: null, reason: "No rate-card price for this model and storage — ask the partner." },
    { variant: "512GB", amount: 20_000, reason: null },
  ];
  const typed = "Customer will enter a quote from another shop later";
  const camera = {
    flags: [
      "Storage: phone measures 1TB, not on file (customer said 256GB — not used) — check Settings, then enter the partner's quote.",
      "Storage: the phone measures 1TB, which isn't a size on file (the customer said 512GB — not used). Check Settings › About phone, and enter the partner's quote on the full case if it's really 1TB.",
      "Not camera-graded — no camera grade came back before Apply. The condition is the advisor's.",
    ],
    overrides: [{ by: "Asha", userId: u.id, reason: typed, at: "2026-10-18T10:00:00Z", items: [] }],
  };
  d.prepare(`UPDATE cases SET quote = ?, repaired_quote = ?, storage_quotes = ?, camera_check = ? WHERE id = ?`).run(JSON.stringify(quote), JSON.stringify(quote), JSON.stringify(chips), JSON.stringify(camera), c.id);

  // This case, and any other still holding them (the rename above wrote two of these sentences itself).
  const changed = rewordQuoteTexts();
  assert.ok(changed.includes(c.ref), changed.join(", "));
  const read = () => one<{ quote: string; repaired_quote: string; storage_quotes: string; camera_check: string }>(`SELECT quote, repaired_quote, storage_quotes, camera_check FROM cases WHERE id = ?`, c.id);
  const r = read();
  assert.equal(JSON.parse(r.quote).reason, "No market price yet.");
  assert.equal(JSON.parse(r.quote).reason, NO_MARKET_PRICE, "the words the code writes today");
  assert.equal(JSON.parse(r.repaired_quote).reason, "No market price yet.");
  assert.deepEqual(JSON.parse(r.storage_quotes), [{ ...chips[0], reason: "This phone isn't on the rate card yet." }, chips[1]]);
  assert.equal(JSON.parse(r.storage_quotes)[0].reason, NOT_ON_CARD);
  const cam = JSON.parse(r.camera_check);
  assert.deepEqual(cam.flags, [
    "Storage: phone measures 1TB, not on file (customer said 256GB — not used) — no trade-in price for that size.",
    "Storage: the phone measures 1TB, which isn't a size on file (the customer said 512GB — not used). No trade-in price for that size.",
    camera.flags[2],
  ]);
  assert.equal(cam.overrides[0].reason, typed, "what a person typed is never touched");
  assert.doesNotMatch(JSON.stringify(r), /enter a quote\.|ask the partner\.|enter the partner's quote/);
  // Idempotent: the next boot finds nothing to change, and changes nothing.
  assert.deepEqual(rewordQuoteTexts(), []);
  assert.deepEqual(read(), r);
  assert.equal(count(`SELECT COUNT(*) n FROM audit WHERE action = 'seed.reworded_quote_texts' AND instr(detail, ?) > 0`, c.ref), 1, "audited once");
  assert.equal(count(`SELECT COUNT(*) n FROM cases WHERE instr(quote, 'enter a quote') > 0 OR instr(camera_check, 'enter the partner') > 0 OR instr(storage_quotes, 'ask the partner') > 0`), 0);
  // It runs on every boot, after the one-time passes.
  assert.match(readFileSync(join(ROOT, "lib/server/seed.ts"), "utf8"), /retireOldQuotes\(\);[^]*?rewordQuoteTexts\(\);/);
});

test("the login moves to 'partner' only when nobody else has it", () => {
  const d = db();
  const P = DEMO_PARTNER;
  d.prepare(`UPDATE orgs SET name = 'Oldbrand' WHERE id = ?`).run(P.orgId);
  d.prepare(`UPDATE users SET username = 'oldbrand' WHERE id = ?`).run(P.userId);
  d.prepare(`INSERT INTO users (id, org_id, store_id, username, name, role, password_hash, created_at) SELECT 'usr_taken', 'org_real', NULL, 'partner', 'Someone', 'org_admin', password_hash, created_at FROM users WHERE id = ?`).run(P.userId);
  d.prepare(`DELETE FROM meta WHERE key = 'renamed_demo_partner'`).run();
  renameDemoPartner();
  assert.equal(one<{ username: string }>(`SELECT username FROM users WHERE id = ?`, P.userId).username, "oldbrand");
  assert.equal(one<{ username: string }>(`SELECT username FROM users WHERE id = 'usr_taken'`).username, "partner");
  d.prepare(`DELETE FROM users WHERE id = 'usr_taken'`).run();
  d.prepare(`UPDATE users SET username = 'partner' WHERE id = ?`).run(P.userId);
});

test("the example cases an older first boot seeded are removed once — exactly those, with their holds and pickup; never a case staff or a test opened", () => {
  const d = db();
  const at = (store: string) => userNamed(store === "st_and" ? "advisor" : store === "st_kor" ? "advisor.kor" : "xc.advisor");
  const make = (store: string, name: string, phone: string, demo: 0 | 1) => {
    const c = cases.createCase(at(store), { customerName: name, customerPhone: phone });
    d.prepare(`UPDATE cases SET demo = ? WHERE id = ?`).run(demo, c.id);
    return c;
  };
  // As the old first boot left them: every example case, a hold on the line for each, one settled pickup.
  const seeded = SEEDED_EXAMPLE_CASES.map((e) => make(e.store, e.name, e.phone, 1));
  for (const c of seeded) d.prepare(`INSERT INTO credit_ledger (store_id, case_id, kind, amount, note, at) VALUES (?, ?, 'hold', 10000, 'demo', '2026-10-10T00:00:00Z')`).run(c.storeId, c.id);
  d.prepare(`INSERT INTO pickups (id, ref, org_id, store_id, partner_id, status, demo, requested_at) VALUES ('pk_demo', 'PK-AND-0009', 'org_samsung_svc', 'st_and', ?, 'settled', 1, '2026-10-08T00:00:00Z')`).run(DEMO_PARTNER.orgId);
  d.prepare(`UPDATE cases SET pickup_id = 'pk_demo' WHERE id IN (?, ?)`).run(seeded[3].id, seeded[4].id);
  // What must stay: staff's cases with the same customer (demo = 0), an example customer at another
  // store, a flagged case with another customer, and a live pickup.
  const staffSame = make("st_and", "Meera Iyer", "9820012345", 0);
  const otherStore = make("st_kor", "Meera Iyer", "9820012345", 1);
  const otherName = make("st_and", "Live test (Ammar)", "9820012345", 1);
  d.prepare(`INSERT INTO credit_ledger (store_id, case_id, kind, amount, note, at) VALUES ('st_and', ?, 'hold', 5000, 'real', '2026-10-10T00:00:00Z')`).run(staffSame.id);
  d.prepare(`INSERT INTO pickups (id, ref, org_id, store_id, partner_id, status, demo, requested_at) VALUES ('pk_live', 'PK-AND-0010', 'org_samsung_svc', 'st_and', ?, 'requested', 0, '2026-10-08T00:00:00Z')`).run(DEMO_PARTNER.orgId);
  // The made-up events the old first boot audited about them — and a real one that stays.
  const auditRow = d.prepare(`INSERT INTO audit (at, action, entity, entity_id, detail) VALUES ('2026-10-10T00:00:00Z', ?, ?, ?, '{}')`);
  auditRow.run("case.lock", "case", seeded[0].id);
  auditRow.run("pickup.settle", "pickup", "pk_demo");
  auditRow.run("case.lock", "case", staffSame.id);
  d.prepare(`DELETE FROM meta WHERE key = 'removed_example_cases'`).run();

  const removed = removeExampleCases();

  assert.deepEqual(removed, seeded.map((c) => c.ref).sort());
  assert.equal(removed.length, 11);
  for (const c of seeded) assert.equal(count(`SELECT COUNT(*) n FROM cases WHERE id = ?`, c.id), 0, c.ref);
  for (const c of [staffSame, otherStore, otherName]) assert.equal(count(`SELECT COUNT(*) n FROM cases WHERE id = ?`, c.id), 1, `${c.ref} stays`);
  assert.equal(count(`SELECT COUNT(*) n FROM credit_ledger WHERE note = 'demo'`), 0, "the example holds are freed");
  assert.equal(count(`SELECT COUNT(*) n FROM credit_ledger WHERE note = 'real'`), 1);
  assert.equal(count(`SELECT COUNT(*) n FROM pickups WHERE id = 'pk_demo'`), 0, "the seeded pickup, now empty");
  assert.equal(count(`SELECT COUNT(*) n FROM pickups WHERE id = 'pk_live'`), 1);
  const audit = JSON.parse(one<{ detail: string }>(`SELECT detail FROM audit WHERE action = 'seed.example_cases_removed' ORDER BY id DESC LIMIT 1`).detail);
  assert.deepEqual(audit.cases, removed);
  assert.deepEqual(audit.pickups, ["PK-AND-0009"]);
  assert.equal(count(`SELECT COUNT(*) n FROM audit WHERE entity_id = ?`, seeded[0].id), 0, "the example's own audit rows go with it");
  assert.equal(count(`SELECT COUNT(*) n FROM audit WHERE entity_id = 'pk_demo'`), 0);
  assert.equal(count(`SELECT COUNT(*) n FROM audit WHERE entity_id = ? AND action = 'case.lock'`, staffSame.id), 1, "a real case's audit stays");
  // Once.
  make("st_and", "Meera Iyer", "9820012345", 1);
  assert.deepEqual(removeExampleCases(), []);
});

test("ids an older first boot gave the partner and its login move to today's, with every row that holds them — foreign keys intact", () => {
  const d = db();
  const P = DEMO_PARTNER;
  const OLD_ORG = "ptn_oldbrand";
  const OLD_USER = "usr_oldbrand";
  // Put the database back as an older first boot left it: the partner and its login under other ids, referenced around.
  d.transaction(() => {
    d.pragma("defer_foreign_keys = ON");
    d.prepare(`UPDATE orgs SET partner_id = ? WHERE partner_id = ?`).run(OLD_ORG, P.orgId);
    d.prepare(`UPDATE users SET org_id = ? WHERE org_id = ?`).run(OLD_ORG, P.orgId);
    d.prepare(`UPDATE pickups SET partner_id = ? WHERE partner_id = ?`).run(OLD_ORG, P.orgId);
    d.prepare(`UPDATE orgs SET id = ? WHERE id = ?`).run(OLD_ORG, P.orgId);
    d.prepare(`UPDATE users SET id = ? WHERE id = ?`).run(OLD_USER, P.userId);
  })();
  d.prepare(`INSERT INTO pickups (id, ref, org_id, store_id, partner_id, status, demo, requested_at, requested_by) VALUES ('pk_ids', 'PK-AND-0011', 'org_samsung_svc', 'st_and', ?, 'requested', 0, '2026-10-08T00:00:00Z', 'usr_mgr_and')`).run(OLD_ORG);
  d.prepare(`INSERT INTO handoff_nonces (nonce_hash, user_id, next, expires_at) VALUES ('h1', ?, '/partner', '2026-10-20T00:00:00Z')`).run(OLD_USER);
  d.prepare(`INSERT INTO audit (at, user_id, org_id, action, entity, entity_id, detail) VALUES ('2026-10-10T00:00:00Z', ?, ?, 'pickup.schedule', 'org', ?, ?)`).run(OLD_USER, OLD_ORG, OLD_ORG, JSON.stringify({ partnerId: OLD_ORG }));
  d.prepare(`DELETE FROM meta WHERE key = 'renamed_demo_partner_ids'`).run();
  assert.equal(demoPartnerId(), OLD_ORG, "found from the programme, whatever its id");

  renameDemoPartnerIds();

  assert.equal(demoPartnerId(), P.orgId);
  assert.equal(count(`SELECT COUNT(*) n FROM orgs WHERE id = ?`, OLD_ORG), 0);
  assert.equal(one<{ id: string }>(`SELECT id FROM users WHERE username = 'partner'`).id, P.userId);
  assert.equal(one<{ partner_id: string }>(`SELECT partner_id FROM pickups WHERE id = 'pk_ids'`).partner_id, P.orgId);
  assert.equal(one<{ user_id: string }>(`SELECT user_id FROM handoff_nonces WHERE nonce_hash = 'h1'`).user_id, P.userId);
  const a = one<{ user_id: string; org_id: string; entity_id: string; detail: string }>(`SELECT user_id, org_id, entity_id, detail FROM audit WHERE action = 'pickup.schedule' ORDER BY id DESC LIMIT 1`);
  assert.deepEqual([a.user_id, a.org_id, a.entity_id, JSON.parse(a.detail).partnerId], [P.userId, P.orgId, P.orgId, P.orgId]);
  assert.deepEqual(d.prepare(`PRAGMA foreign_key_check`).all(), []);
  assert.equal(authenticate("partner", "swapup2026")?.id, P.userId, "the login still signs in");
  assert.equal(partnerMode(P.orgId).partnerName, "Buyback Partner (demo)");
  // Once; and never onto an id someone else already has.
  renameDemoPartnerIds();
  assert.equal(demoPartnerId(), P.orgId);
  d.prepare(`DELETE FROM pickups WHERE id = 'pk_ids'`).run();
  d.prepare(`DELETE FROM handoff_nonces WHERE nonce_hash = 'h1'`).run();
});

test("test cases still on a quote from a retired source: relabelled, the old caveat and chips gone, a LOCKED one cancelled with its hold released — once, test programmes only", () => {
  const d = db();
  const OLD_KIND = "sample"; // the older build's illustrative card (a test may spell it; the app never does)
  const OLD_LABEL = "SAMPLE rate card — illustrative values, not the partner's prices";
  const OLD_CAVEAT = "Trade-in values here come from a SAMPLE rate card, not the buyback partner. Do not quote them to a customer.";
  const KEPT_CAVEAT = "This answer doesn't depend on what the store earns.";
  const oldQuote = (amount: number) => ({
    status: "priced",
    amount,
    lines: [{ label: "Best-condition price on the rate card", amount }],
    source: { kind: OLD_KIND, label: OLD_LABEL, rateCardId: "rc_old", effectiveFrom: "2026-10-01" },
    partner: DEMO_PARTNER.name,
    partnerRef: null,
    quotedAt: "2026-10-12T10:00:00Z",
    // Still in date whenever the test runs, so a lapse can only come from the retired source (a fixed
    // 2026-10-19 here failed every run after that morning: "a closed case isn't re-priced").
    validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  const decision = JSON.stringify({ recommendation: "trade_in", caveats: [OLD_CAVEAT, KEPT_CAVEAT] });
  const put = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    d.prepare(`UPDATE cases SET status = ?, quote = ?, repaired_quote = ?, decision = ?, trade_value = ?, locked_at = ?, model_id = 'galaxy-s23-ultra', variant = '256GB' WHERE id = ?`).run(
      status,
      JSON.stringify(extra.quote ?? oldQuote(18_800)),
      JSON.stringify(extra.repaired ?? oldQuote(24_000)),
      decision,
      ["locked", "in_pickup"].includes(status) ? 18_800 : null,
      ["locked", "in_pickup"].includes(status) ? "2026-10-12T10:05:00Z" : null,
      id
    );
  const hold = (storeId: string, caseId: string) =>
    d.prepare(`INSERT INTO credit_ledger (store_id, case_id, kind, amount, note, at) VALUES (?, ?, 'hold', 18800, 'Trade-in', '2026-10-12T10:05:00Z')`).run(storeId, caseId);
  const adv = userNamed("advisor");

  // 00028-like: locked at the store, holding credit on the old price.
  const locked = cases.createCase(adv, { customerName: "Retired lock" });
  put(locked.id, "locked");
  hold(locked.storeId, locked.id);
  // 00017-like: closed at the counter (repair chosen) — history.
  const history = cases.createCase(adv, { customerName: "Retired history" });
  put(history.id, "repair_chosen");
  // Already in a pickup: can't be cancelled from here — named for the owner, hold untouched.
  const inPickup = cases.createCase(adv, { customerName: "Retired in pickup" });
  put(inPickup.id, "in_pickup");
  hold(inPickup.storeId, inPickup.id);
  // An open case whose storage chips the older build priced off its card.
  const chips = cases.createCase(adv, { customerName: "Retired chips" });
  d.prepare(`UPDATE cases SET storage_quotes = ? WHERE id = ?`).run(JSON.stringify([{ variant: "256GB", amount: 18_800, reason: null, [OLD_KIND]: true }]), chips.id);
  // Must stay as they are: a locked case on the partner's own card, and a LIVE programme's case on a retired source.
  const own = cases.createCase(adv, { customerName: "Own card lock" });
  const ownQuote = { ...oldQuote(17_000), source: { kind: "partner_ratecard", label: "Partner card Oct", effectiveFrom: "2026-10-01" } };
  put(own.id, "locked", { quote: ownQuote, repaired: ownQuote });
  hold(own.storeId, own.id);
  d.prepare(`UPDATE orgs SET demo = 0 WHERE id = 'org_xc'`).run();
  const live = cases.createCase(userNamed("xc.advisor"), { customerName: "Live programme" });
  put(live.id, "locked");
  hold(live.storeId, live.id);
  const ledgerBefore = count(`SELECT COUNT(*) n FROM credit_ledger`);
  d.prepare(`DELETE FROM meta WHERE key = 'retired_test_quotes'`).run();

  let r: ReturnType<typeof retireOldQuotes>;
  try {
    r = retireOldQuotes();
  } finally {
    d.prepare(`UPDATE orgs SET demo = 1 WHERE id = 'org_xc'`).run();
  }

  assert.deepEqual(r.cancelled, [locked.ref]);
  assert.deepEqual(r.history, [`${inPickup.ref} (in_pickup)`]);
  assert.deepEqual([...r.relabelled].sort(), [locked.ref, history.ref, inPickup.ref, chips.ref].sort());

  // The locked one: cancelled, its whole hold released, audited as automatic.
  const L = one<{ status: string; closed_reason: string; closed_at: string | null; quote: string; repaired_quote: string; decision: string }>(`SELECT * FROM cases WHERE id = ?`, locked.id);
  assert.equal(L.status, "cancelled");
  assert.equal(L.closed_reason, RETIRED_QUOTE_CANCEL_REASON);
  assert.ok(L.closed_at);
  assert.deepEqual(
    d.prepare(`SELECT kind, amount FROM credit_ledger WHERE case_id = ? ORDER BY id`).all(locked.id),
    [{ kind: "hold", amount: 18_800 }, { kind: "release", amount: 18_800 }]
  );
  const storeEvents = d.prepare(`SELECT case_id caseId, kind, amount, at FROM credit_ledger WHERE store_id = ? ORDER BY id`).all(locked.storeId) as Parameters<typeof checkLedger>[0];
  assert.deepEqual(checkLedger(storeEvents), [], "the store's ledger still balances");
  const cancelAudit = one<{ detail: string; user_id: string | null }>(`SELECT detail, user_id FROM audit WHERE action = 'case.cancel' AND entity_id = ?`, locked.id);
  assert.equal(cancelAudit.user_id, null);
  assert.deepEqual(JSON.parse(cancelAudit.detail), { reason: RETIRED_QUOTE_CANCEL_REASON, automatic: true, released: 18_800, tradeValue: 18_800 });
  // Its words: relabelled (the kind kept, so it is still never reused), the card's date and id gone, the caveat gone.
  for (const col of [L.quote, L.repaired_quote]) {
    const q = JSON.parse(col);
    assert.deepEqual(q.source, { kind: "retired", label: RETIRED_QUOTE_LABEL }, "a neutral kind — still retired, so never reused");
    assert.equal(q.amount > 0, true, "the figure stays as history");
  }
  assert.deepEqual(JSON.parse(L.decision).caveats, [KEPT_CAVEAT]);
  assert.equal(JSON.parse(L.decision).recommendation, "trade_in", "the rest of the stored answer is untouched");
  // What the counter, the receipt and the apps read for it.
  const view = cases.getCase(userNamed("manager"), locked.id);
  assert.equal(view.status, "cancelled");
  assert.equal(quoteSourceLabel(view.quote?.source), RETIRED_QUOTE_LABEL);
  assert.equal(view.quoteExpired, false, "a closed case isn't re-priced");
  assert.doesNotMatch(JSON.stringify(view), /sample|illustrative|rc_old|2026-10-01/i, "nothing of the old card reaches the counter, the receipt or the apps");

  assert.equal(retiredSource(view.quote?.source.kind), true, "still retired: an open case would re-ask it");
  // History: relabelled and the caveat gone, its status kept.
  const H = one<{ status: string; quote: string; decision: string }>(`SELECT status, quote, decision FROM cases WHERE id = ?`, history.id);
  assert.equal(H.status, "repair_chosen");
  assert.equal(JSON.parse(H.quote).source.label, RETIRED_QUOTE_LABEL);
  assert.deepEqual(JSON.parse(H.decision).caveats, [KEPT_CAVEAT]);
  // In a pickup: relabelled, not cancelled, its hold untouched.
  assert.equal(one<{ status: string }>(`SELECT status FROM cases WHERE id = ?`, inPickup.id).status, "in_pickup");
  assert.equal(count(`SELECT COUNT(*) n FROM credit_ledger WHERE case_id = ? AND kind = 'release'`, inPickup.id), 0);
  // The chips priced off the old card: gone (asked again when the storage is still unknown).
  assert.equal(one<{ storage_quotes: string | null }>(`SELECT storage_quotes FROM cases WHERE id = ?`, chips.id).storage_quotes, null);
  // Untouched: the partner's own card, and the live programme.
  assert.equal(one<{ status: string }>(`SELECT status FROM cases WHERE id = ?`, own.id).status, "locked");
  assert.equal(JSON.parse(one<{ quote: string }>(`SELECT quote FROM cases WHERE id = ?`, own.id).quote).source.label, "Partner card Oct");
  const LV = one<{ status: string; quote: string }>(`SELECT status, quote FROM cases WHERE id = ?`, live.id);
  assert.equal(LV.status, "locked", "a live programme's case is never cancelled from here");
  assert.equal(JSON.parse(LV.quote).source.label, OLD_LABEL);
  assert.equal(count(`SELECT COUNT(*) n FROM credit_ledger`), ledgerBefore + 1, "one release, nothing else");
  const summary = JSON.parse(one<{ detail: string }>(`SELECT detail FROM audit WHERE action = 'seed.retired_test_quotes' ORDER BY id DESC LIMIT 1`).detail);
  assert.deepEqual(summary.cancelled, [locked.ref]);

  // Once.
  put(history.id, "repair_chosen");
  assert.deepEqual(retireOldQuotes(), { relabelled: [], cancelled: [], history: [] });
  assert.equal(JSON.parse(one<{ quote: string }>(`SELECT quote FROM cases WHERE id = ?`, history.id).quote).source.label, OLD_LABEL);
  // …but whatever is stored, a retired source is shown as a retired test quote (the screens use quoteSourceLabel).
  assert.equal(quoteSourceLabel(JSON.parse(one<{ quote: string }>(`SELECT quote FROM cases WHERE id = ?`, history.id).quote).source), RETIRED_QUOTE_LABEL);
});

test("never throws on boot: a case it can't change is logged and skipped, the rest go on", () => {
  const d = db();
  const adv = userNamed("advisor");
  const bad = cases.createCase(adv, { customerName: "Odd ledger" });
  const ok = cases.createCase(adv, { customerName: "Plain history" });
  const q = JSON.stringify({ status: "priced", amount: 9_000, lines: [], source: { kind: "partner_live", label: "Old live quote" }, partnerRef: null });
  // Locked, but the ledger can't take the release (a hold on another store's line): the ledger check refuses.
  d.prepare(`UPDATE cases SET status = 'locked', quote = ?, trade_value = 9000, locked_at = '2026-10-12T00:00:00Z' WHERE id = ?`).run(q, bad.id);
  d.prepare(`INSERT INTO credit_ledger (store_id, case_id, kind, amount, note, at) VALUES ('st_kor', ?, 'hold', 9000, 'x', '2026-10-12T00:00:00Z')`).run(bad.id);
  d.prepare(`UPDATE cases SET status = 'walked_away', quote = ? WHERE id = ?`).run(q, ok.id);
  d.prepare(`UPDATE cases SET quote = '{not json' WHERE id = (SELECT id FROM cases WHERE status = 'draft' AND org_id = 'org_samsung_svc' LIMIT 1)`).run();
  d.prepare(`DELETE FROM meta WHERE key = 'retired_test_quotes'`).run();
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  let r: ReturnType<typeof retireOldQuotes>;
  try {
    r = retireOldQuotes();
  } finally {
    console.error = origErr;
  }
  assert.ok(r.relabelled.includes(ok.ref));
  assert.ok(!r.cancelled.includes(bad.ref));
  assert.equal(one<{ status: string }>(`SELECT status FROM cases WHERE id = ?`, bad.id).status, "locked", "rolled back as a whole");
  assert.equal(JSON.parse(one<{ quote: string }>(`SELECT quote FROM cases WHERE id = ?`, bad.id).quote).source.label, "Old live quote");
  assert.ok(errs.some((e) => e.includes(bad.ref)), errs.join("\n"));
  assert.ok(one<{ value: string }>(`SELECT value FROM meta WHERE key = 'retired_test_quotes'`).value);
  d.prepare(`DELETE FROM credit_ledger WHERE case_id = ?`).run(bad.id);
  d.prepare(`UPDATE cases SET status = 'cancelled' WHERE id = ?`).run(bad.id);
});

/* ─────────────────────────── the brand, and sample data, nowhere ─────────────────────────── */

const TEXT = /\.(?:ts|tsx|mjs|js|json|md|html|css|sh|py|caddy|csv|txt|yml|yaml)$/;
function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (["node_modules", ".next", "data", ".git"].includes(f)) return [];
    return statSync(p).isDirectory() ? [p, ...walk(p)] : [p];
  });
}

test("no file in the repository names the partner's former brand — not a screen, an identifier, an env name, a comment, a doc or a file name", () => {
  const paths = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components")), ...walk(join(ROOT, "lib")), ...walk(join(ROOT, "docs")), ...walk(join(ROOT, "scripts")), ...walk(join(ROOT, "deploy")), join(ROOT, "README.md"), join(ROOT, "package.json")];
  const hits = paths.filter((p) => namesBrand(relative(ROOT, p)) || (TEXT.test(p) && statSync(p).isFile() && namesBrand(readFileSync(p, "utf8"))));
  assert.deepEqual(hits.map((p) => relative(ROOT, p)), []);
});

test("no sample price source and no sample banner anywhere in the app's own code", () => {
  const src = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components")), ...walk(join(ROOT, "lib"))].filter((p) => /\.tsx?$/.test(p) && !/\.test\.ts$/.test(p) && !p.includes("/testing/"));
  const hits = src.filter((p) => /(["'`])sample\1|SAMPLE_DEDUCTIONS|sampleRateCard|sampleDeductions|pill-sample|Demo — sample prices/.test(readFileSync(p, "utf8")));
  assert.deepEqual(hits.map((p) => relative(ROOT, p)), []);
  assert.match(readFileSync(join(ROOT, "components/AppShell.tsx"), "utf8"), /Test programme — no real money/);
});
