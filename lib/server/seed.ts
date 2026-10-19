import { db, tx, nowIso, todayIso, newId, audit, parseJson } from "./db";
import { hashPassword, orgSettingsDefaults, type Role } from "./auth";
import { postEvents } from "./credit";
import seedData from "./seed-data.json";
import type { Campaign } from "../domain/bonus";
import { cancelEvents, OPEN_TRADE_STATUSES } from "../domain/lifecycle";
import { NOT_ON_CARD, RETIRED_QUOTE_LABEL, RETIRED_SOURCE_KIND, retiredSource } from "../domain/ratecard";
import { NO_MARKET_PRICE } from "../domain/offer";

/**
 * First-boot data. Two kinds, kept apart:
 *
 *   REFERENCE  Samsung India list prices for spare parts and new phones, read
 *              from samsung.com/in on 2026-10-15 and labelled as such (see
 *              scripts/build-seed-data.py and the two research CSVs beside it).
 *   TEST       the test programmes' clients, stores, people, logins and bonus
 *              campaigns, flagged demo ("Test programme — no real money"), and a
 *              buyback partner ("Buyback Partner (demo)", login `partner`).
 *
 * No prices of SwapUp's own and no example cases (owner, 2026-10-18: "Remove
 * sample data"): a trade-in is priced by PriceIQ or the partner's uploaded rate
 * card — never a typed price (2026-10-19); none of them → "No market price yet".
 * A database seeded before that loses its example cases once
 * (removeExampleCases); migration 15 (db.ts) removed the sample rate card.
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
      renameDemoPartner();
      renameDemoPartnerIds();
      const removed = removeExampleCases();
      if (removed.length) console.log(`[swapup] removed ${removed.length} example cases seeded on first boot: ${removed.join(", ")}`);
      const r = retireOldQuotes();
      if (r.relabelled.length) console.log(`[swapup] test cases with a retired quote relabelled "${RETIRED_QUOTE_LABEL}": ${r.relabelled.join(", ")}`);
      if (r.cancelled.length) console.log(`[swapup] locked test trade-ins on a retired quote cancelled, their holds released: ${r.cancelled.join(", ")}`);
      if (r.history.length) console.warn(`[swapup] test trade-ins on a retired quote already in a pickup or collected — not cancelled, the owner decides: ${r.history.join(", ")}`);
      const reworded = rewordQuoteTexts();
      if (reworded.length) console.log(`[swapup] cases whose stored words asked staff to type a trade-in price, reworded: ${reworded.join(", ")}`);
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

/**
 * The test programmes' buyback partner, as a new database seeds it. A database seeded earlier
 * gets these ids once (renameDemoPartnerIds); code finds the partner by its programme
 * (demoPartnerId), never by a remembered id.
 */
export const DEMO_PARTNER = { orgId: "ptn_demo", name: "Buyback Partner (demo)", userId: "usr_partner", username: "partner", userName: "Partner Ops (demo)" } as const;

/** The partner org of the seeded test programme (org_samsung_svc), whatever its id; null when there is none. */
export function demoPartnerId(): string | null {
  const r = db()
    .prepare(`SELECT p.id FROM orgs c JOIN orgs p ON p.id = c.partner_id AND p.kind = 'partner' WHERE c.id = 'org_samsung_svc' AND c.demo = 1`)
    .get() as { id: string } | undefined;
  return r?.id ?? null;
}

/**
 * Owner, 2026-10-17: don't refer to the partner's brand. A database seeded before that keeps the test
 * programme's partner under its former brand — its name, its login, and copies of the name in
 * the case records its quotes were written into. Rename them once. The former name is read from
 * the partner's own row (the code never spells it), and only the sentences SwapUp itself wrote
 * around it are swapped: never a reference, a reason or a name someone typed. Only that partner's
 * rows, its test pickups and the cases of the programmes it serves. The login moves to `partner`
 * only when no other user has it. Its ids move separately (renameDemoPartnerIds).
 */
export function renameDemoPartner(): void {
  const d = db();
  if (d.prepare(`SELECT 1 FROM meta WHERE key = 'renamed_demo_partner'`).get()) return;
  const id = demoPartnerId();
  const old = id ? (d.prepare(`SELECT name FROM orgs WHERE id = ?`).get(id) as { name: string }).name : null;
  const P = DEMO_PARTNER;
  d.transaction(() => {
    if (id && old && old !== P.name) {
      d.prepare(`UPDATE orgs SET name = ? WHERE id = ?`).run(P.name, id);
      d.prepare(
        `UPDATE users SET username = ? WHERE org_id = ? AND role = 'partner' AND lower(username) = lower(?) AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.username = ?)`
      ).run(P.username, id, old, P.username);
      d.prepare(`UPDATE users SET name = ? WHERE org_id = ? AND role = 'partner' AND name = ?`).run(P.userName, id, `${old} Ops (demo)`);
      d.prepare(`UPDATE pickups SET collector_name = 'Sunil (partner)' WHERE demo = 1 AND partner_id = ? AND collector_name = ?`).run(id, `Sunil (${old})`);
      renameCopies(id, old);
    }
    d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('renamed_demo_partner', ?)`).run(nowIso());
  })();
}

/** Every column that holds an org id or a user id (foreign keys, and the plain ones audit and money rows keep). */
const ORG_ID_COLUMNS: readonly [string, string][] = [
  ["orgs", "partner_id"],
  ["stores", "org_id"],
  ["users", "org_id"],
  ["new_devices", "org_id"],
  ["repair_book", "org_id"],
  ["rate_cards", "partner_id"],
  ["campaigns", "org_id"],
  ["cases", "org_id"],
  ["pickups", "org_id"],
  ["pickups", "partner_id"],
  ["test_sessions", "org_id"],
  ["store_devices", "org_id"],
  ["audit", "org_id"],
];
const USER_ID_COLUMNS: readonly [string, string][] = [
  ["cases", "advisor_id"],
  ["test_sessions", "created_by"],
  ["handoff_nonces", "user_id"],
  ["store_invites", "created_by"],
  ["store_devices", "created_by"],
  ["store_devices", "revoked_by"],
  ["pin_attempts", "user_id"],
  ["credit_ledger", "by_user"],
  ["pickups", "requested_by"],
  ["rate_cards", "created_by"],
  ["grading_reports", "issued_by"],
  ["phonecheck_records", "attached_by"],
  ["audit", "user_id"],
];

/**
 * Once: the test programme's partner org and its seeded login get today's ids (DEMO_PARTNER), so
 * no id an older first boot gave them — ids reach URLs and API answers (`partner.partnerId`) —
 * carries the partner's former brand. The old ids are read from the data (demoPartnerId, the
 * partner's first login), never spelled here. Every column holding them moves in one transaction,
 * foreign keys checked at commit; audit rows follow (their `entity_id` too). Skipped when the new
 * id is already taken. Tokens issued to the old login stop working: it signs in again.
 */
export function renameDemoPartnerIds(): void {
  const d = db();
  if (d.prepare(`SELECT 1 FROM meta WHERE key = 'renamed_demo_partner_ids'`).get()) return;
  const P = DEMO_PARTNER;
  const oldOrg = demoPartnerId();
  const oldUser = oldOrg
    ? ((d.prepare(`SELECT id FROM users WHERE org_id = ? AND role = 'partner' ORDER BY created_at, id LIMIT 1`).get(oldOrg) as { id: string } | undefined)?.id ?? null)
    : null;
  const free = (table: string, id: string) => !d.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
  const move = (cols: readonly [string, string][], table: string, from: string, to: string) => {
    for (const [t, c] of cols) d.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(to, from);
    d.prepare(`UPDATE audit SET entity_id = ? WHERE entity_id = ?`).run(to, from);
    d.prepare(`UPDATE audit SET detail = replace(detail, ?, ?) WHERE instr(detail, ?) > 0`).run(JSON.stringify(from), JSON.stringify(to), JSON.stringify(from));
    d.prepare(`UPDATE ${table} SET id = ? WHERE id = ?`).run(to, from);
  };
  d.transaction(() => {
    d.pragma("defer_foreign_keys = ON");
    if (oldOrg && oldOrg !== P.orgId && free("orgs", P.orgId)) move(ORG_ID_COLUMNS, "orgs", oldOrg, P.orgId);
    if (oldUser && oldUser !== P.userId && free("users", P.userId)) move(USER_ID_COLUMNS, "users", oldUser, P.userId);
    d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('renamed_demo_partner_ids', ?)`).run(nowIso());
  })();
}

/**
 * Copies of the former name in the case records the partner priced (its quotes, the storage chips,
 * the flags written at Apply, its pickup verdicts): exact sentences SwapUp wrote; nothing typed.
 */
function renameCopies(partnerId: string, old: string): void {
  const d = db();
  const P = DEMO_PARTNER;
  const pair = (k: string, a: string, b: string): [string, string] => [JSON.stringify({ [k]: a }).slice(1, -1), JSON.stringify({ [k]: b }).slice(1, -1)];
  const swaps: [string, string][] = [
    pair("partner", old, P.name),
    pair("by", `${old} Ops (demo)`, P.userName),
    [`not ${old} prices`, "not the partner's prices"],
    [`${old} quote · ref `, `${P.name} quote · ref `],
    [`${old} value in repaired condition`, `${P.name} value in repaired condition`],
    [`Entered from the ${old} app`, `Entered from the ${P.name} app`],
    [`enter the ${old} quote on the full case`, "enter the partner's quote on the full case"],
    [
      `The ${old} rate card has no price for this model and storage — ask the partner for a quote rather than using a similar model.`,
      "No rate-card price for this model and storage — ask the partner.",
    ],
  ];
  const wrap = (col: string) => swaps.reduce((sql) => `replace(${sql}, ?, ?)`, col);
  const args = swaps.flat();
  const cols = ["quote", "repaired_quote", "storage_quotes", "camera_check", "clearance"];
  d.prepare(
    `UPDATE cases SET ${cols.map((c) => `${c} = ${wrap(c)}`).join(", ")}
     WHERE org_id IN (SELECT id FROM orgs WHERE partner_id = ?)
       AND (${cols.map((c) => `instr(${c}, ?) > 0`).join(" OR ")})`
  ).run(...cols.flatMap(() => args), partnerId, ...cols.map(() => old));
}

/**
 * The example cases a first boot used to seed into the test programmes (seedDemoCases, removed
 * 2026-10-18 — owner: "Remove sample data"), exactly as seeded: store, customer name and mobile.
 * Together with `cases.demo = 1` — a flag nothing but that seeding ever set — in a demo
 * programme, they pick out those cases and nothing else: never a case staff or a test opened.
 */
export const SEEDED_EXAMPLE_CASES: readonly { store: string; name: string; phone: string }[] = [
  { store: "st_and", name: "Meera Iyer", phone: "9820012345" },
  { store: "st_and", name: "Vikram Joshi", phone: "9867012345" },
  { store: "st_and", name: "Farhan Shaikh", phone: "9930012345" },
  { store: "st_and", name: "Ananya Kulkarni", phone: "9769012345" },
  { store: "st_and", name: "Rohan Pillai", phone: "9821012345" },
  { store: "st_and", name: "Sneha Patil", phone: "9819012345" },
  { store: "st_and", name: "Imran Khan", phone: "9833012345" },
  { store: "st_kor", name: "Lakshmi Narayan", phone: "9845012345" },
  { store: "st_kor", name: "Deepak Hegde", phone: "9880012345" },
  { store: "st_kor", name: "Pooja Reddy", phone: "9886012345" },
  { store: "st_cpx", name: "Kabir Malhotra", phone: "9811012345" },
];

/**
 * Once: delete the seeded example cases and everything that hangs off them — their credit-ledger
 * rows (the holds were never real money, so the store's line is freed), any test sessions, grading
 * reports or Phonecheck links, the seeded pickup once it has no case left, and the audit rows about
 * those cases and that pickup (they describe made-up events). The removal itself is audited, with
 * the refs. Returns the refs removed.
 */
export function removeExampleCases(): string[] {
  const d = db();
  if (d.prepare(`SELECT 1 FROM meta WHERE key = 'removed_example_cases'`).get()) return [];
  const find = d.prepare(
    `SELECT c.id, c.ref FROM cases c JOIN orgs o ON o.id = c.org_id
      WHERE c.demo = 1 AND o.demo = 1 AND c.store_id = ?
        AND json_extract(c.customer, '$.name') = ? AND json_extract(c.customer, '$.phone') = ?`
  );
  const hits = SEEDED_EXAMPLE_CASES.flatMap((e) => find.all(e.store, e.name, e.phone) as { id: string; ref: string }[]);
  const refs = hits.map((h) => h.ref).sort();
  tx(() => {
    for (const { id } of hits) {
      d.prepare(`DELETE FROM credit_ledger WHERE case_id = ?`).run(id);
      d.prepare(`DELETE FROM test_sessions WHERE case_id = ?`).run(id);
      d.prepare(`DELETE FROM grading_reports WHERE case_id = ?`).run(id);
      d.prepare(`UPDATE phonecheck_records SET case_id = NULL, attached_at = NULL, attached_by = NULL WHERE case_id = ?`).run(id);
      d.prepare(`DELETE FROM cases WHERE id = ?`).run(id);
      d.prepare(`DELETE FROM audit WHERE entity = 'case' AND entity_id = ?`).run(id);
    }
    const pickups = d.prepare(`SELECT id, ref FROM pickups WHERE demo = 1 AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.pickup_id = pickups.id)`).all() as { id: string; ref: string }[];
    for (const p of pickups) {
      d.prepare(`DELETE FROM pickups WHERE id = ?`).run(p.id);
      d.prepare(`DELETE FROM audit WHERE entity = 'pickup' AND entity_id = ?`).run(p.id);
    }
    if (refs.length || pickups.length) audit({ action: "seed.example_cases_removed", detail: { cases: refs, pickups: pickups.map((p) => p.ref) } });
    d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('removed_example_cases', ?)`).run(JSON.stringify({ at: nowIso(), cases: refs }));
  });
  return refs;
}

/** Why a locked test trade-in priced from a retired source was cancelled (cases.closed_reason, the audit). */
export const RETIRED_QUOTE_CANCEL_REASON = "Retired test quote — priced from a source SwapUp no longer uses. Cancelled; the store's credit line is released.";

type QuoteLike = { source?: { kind?: string | null; label?: string | null } | null } & Record<string, unknown>;

/** The stored quote with its retired source relabelled — still a retired kind, so it is never reused. */
function relabelled(q: QuoteLike | null): QuoteLike | null {
  if (!q || !q.source || !retiredSource(q.source.kind)) return q;
  return { ...q, source: { kind: RETIRED_SOURCE_KIND, label: RETIRED_QUOTE_LABEL } };
}

/**
 * Once (owner, 2026-10-18: "Remove sample data" — never a made-up price): the test programmes'
 * cases still carrying a quote from a source SwapUp no longer has (retiredSource — an older
 * build's illustrative card). An open case re-asks such a quote anyway (cases.ts treats it as
 * lapsed); what is left is history, and it must keep neither the old words nor the old money:
 *
 *   • the quote and the repaired value are re-stored as RETIRED_SOURCE_KIND / RETIRED_QUOTE_LABEL
 *     (still retired, so never reused) — the old kind, the card's own label, date and id go;
 *   • the stored answer's caveat about that card goes (its "Why this answer" no longer says it);
 *   • storage chips priced off that card (flagged by the older build) go — asked again when needed;
 *   • a LOCKED one — at the store, its value held on the store's credit line — is cancelled and
 *     what it still holds is released: a partner pickup would otherwise collect and settle it at
 *     that price. One already in a pickup or collected can't be cancelled from here: it is
 *     relabelled and named in the log (and the audit) for the owner to decide; one already
 *     closed stays as history, relabelled.
 *
 * Test programmes only (orgs.demo = 1): a live programme's case is never touched. Each case is its
 * own transaction, so one that can't be changed (the ledger refuses) is logged and the rest go on;
 * this never throws (it runs on boot). Audited.
 */
export function retireOldQuotes(): { relabelled: string[]; cancelled: string[]; history: string[] } {
  const out = { relabelled: [] as string[], cancelled: [] as string[], history: [] as string[] };
  const d = db();
  if (d.prepare(`SELECT 1 FROM meta WHERE key = 'retired_test_quotes'`).get()) return out;
  type Row = { id: string; ref: string; status: string; org_id: string; store_id: string; quote: string | null; repaired_quote: string | null; decision: string | null; storage_quotes: string | null; trade_value: number | null };
  const rows = d
    .prepare(
      `SELECT c.id, c.ref, c.status, c.org_id, c.store_id, c.quote, c.repaired_quote, c.decision, c.storage_quotes, c.trade_value
         FROM cases c JOIN orgs o ON o.id = c.org_id
        WHERE o.demo = 1 AND (c.quote IS NOT NULL OR c.repaired_quote IS NOT NULL OR c.storage_quotes IS NOT NULL)
        ORDER BY c.ref`
    )
    .all() as Row[];
  const held = d.prepare(
    `SELECT COALESCE(SUM(CASE kind WHEN 'hold' THEN amount ELSE 0 END), 0) - COALESCE(SUM(CASE kind WHEN 'release' THEN amount ELSE 0 END), 0) AS n
       FROM credit_ledger WHERE case_id = ?`
  );
  for (const r of rows) {
    const quote = parseJson<QuoteLike | null>(r.quote, null);
    const repaired = parseJson<QuoteLike | null>(r.repaired_quote, null);
    const chips = parseJson<Record<string, unknown>[] | null>(r.storage_quotes, null);
    const retiredQuote = retiredSource(quote?.source?.kind);
    const retiredRepaired = retiredSource(repaired?.source?.kind);
    // The older build flagged a chip priced off its illustrative card; today's chips carry no such flag.
    const retiredChips = Array.isArray(chips) && chips.some((c) => !!c && typeof c === "object" && c.sample === true);
    if (!retiredQuote && !retiredRepaired && !retiredChips) continue;
    try {
      tx(() => {
        const now = nowIso();
        const decision = parseJson<{ caveats?: unknown } | null>(r.decision, null);
        const caveats = decision && Array.isArray(decision.caveats) ? (decision.caveats as unknown[]) : null;
        const keptCaveats = caveats ? caveats.filter((c) => !(typeof c === "string" && /\bsample\b/i.test(c))) : null;
        d.prepare(`UPDATE cases SET quote = ?, repaired_quote = ?, storage_quotes = ?, decision = ?, updated_at = ? WHERE id = ?`).run(
          quote ? JSON.stringify(relabelled(quote)) : r.quote,
          repaired ? JSON.stringify(relabelled(repaired)) : r.repaired_quote,
          retiredChips ? null : r.storage_quotes,
          decision && keptCaveats && keptCaveats.length !== caveats!.length ? JSON.stringify({ ...decision, caveats: keptCaveats }) : r.decision,
          now,
          r.id
        );
        let cancelled = false;
        if (retiredQuote && r.status === "locked") {
          const upd = d
            .prepare(`UPDATE cases SET status = 'cancelled', closed_reason = ?, closed_at = ?, updated_at = ? WHERE id = ? AND status = 'locked'`)
            .run(RETIRED_QUOTE_CANCEL_REASON, now, now, r.id);
          if (upd.changes === 1) {
            const outstanding = (held.get(r.id) as { n: number }).n;
            if (outstanding > 0) postEvents(r.store_id, cancelEvents(r.id, outstanding, now), null);
            audit({ orgId: r.org_id, storeId: r.store_id, action: "case.cancel", entity: "case", entityId: r.id, detail: { reason: RETIRED_QUOTE_CANCEL_REASON, automatic: true, released: Math.max(0, outstanding), tradeValue: r.trade_value } });
            cancelled = true;
          }
        }
        if (cancelled) out.cancelled.push(r.ref);
        // Still moving money (in a pickup, collected): the owner decides — it can't be cancelled from here.
        else if (retiredQuote && r.status !== "locked" && (OPEN_TRADE_STATUSES as string[]).includes(r.status)) out.history.push(`${r.ref} (${r.status})`);
        out.relabelled.push(r.ref);
      });
    } catch (e) {
      console.error(`[swapup] ${r.ref}: its retired quote could not be retired — ${(e as Error).message}`);
    }
  }
  try {
    tx(() => {
      if (out.relabelled.length) audit({ action: "seed.retired_test_quotes", detail: out });
      d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('retired_test_quotes', ?)`).run(JSON.stringify({ at: nowIso(), ...out }));
    });
  } catch (e) {
    console.error(`[swapup] retired test quotes: not recorded — ${(e as Error).message}`);
  }
  return out;
}

/**
 * SwapUp's own sentences that told staff to type a trade-in price (before 0.9.1 — owner, 2026-10-19:
 * the price is the system's), as stored on cases, and what each says now. Exact sentences SwapUp
 * wrote, never anything typed.
 */
export const REWORDED_QUOTE_TEXTS: readonly (readonly [string, string])[] = [
  ["No market price yet — enter a quote.", NO_MARKET_PRICE],
  ["No rate-card price for this model and storage — ask the partner.", NOT_ON_CARD],
  // The tail of the Apply flag for a size not on file (phoneLed.ts).
  ["— check Settings, then enter the partner's quote.", "— no trade-in price for that size."],
];
// An older build's flag for a size not on file, with the size in it ("… if it's really 1TB.").
const OLDER_SIZE_FLAG = / Check Settings › About phone, and enter the partner's quote on the full case if it's really [^."]+\./g;
const OLDER_SIZE_FLAG_NEEDLE = "enter the partner's quote on the full case";

/**
 * On every boot: those sentences, reworded wherever a case stores them — its quote's reason, its
 * repaired value's, its storage chips', the flags written at Apply (cases.camera_check). The stored
 * answer (cases.decision) never holds them. Idempotent: the new words don't contain the old, so only
 * a case that still carries one is touched, once. Every case, live or test: these are SwapUp's words,
 * not a price. Audited; returns the case refs it changed. Never throws (it runs on boot).
 */
export function rewordQuoteTexts(): string[] {
  const d = db();
  const cols = ["quote", "repaired_quote", "storage_quotes", "camera_check"] as const;
  const needles = [...REWORDED_QUOTE_TEXTS.map(([from]) => from), OLDER_SIZE_FLAG_NEEDLE];
  type Row = { id: string; ref: string } & Record<(typeof cols)[number], string | null>;
  const done: string[] = [];
  try {
    const rows = d
      .prepare(`SELECT id, ref, ${cols.join(", ")} FROM cases WHERE ${cols.flatMap((c) => needles.map(() => `instr(${c}, ?) > 0`)).join(" OR ")} ORDER BY ref`)
      .all(...cols.flatMap(() => needles)) as Row[];
    if (!rows.length) return done;
    tx(() => {
      for (const r of rows) {
        const sets: Partial<Record<(typeof cols)[number], string>> = {};
        for (const c of cols) {
          const was = r[c];
          if (!was) continue;
          let now = was;
          for (const [from, to] of REWORDED_QUOTE_TEXTS) now = now.split(from).join(to);
          now = now.replace(OLDER_SIZE_FLAG, " No trade-in price for that size.");
          if (now !== was) sets[c] = now;
        }
        const keys = Object.keys(sets) as (typeof cols)[number][];
        if (!keys.length) continue;
        d.prepare(`UPDATE cases SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => sets[k]!), r.id);
        done.push(r.ref);
      }
      if (done.length) audit({ action: "seed.reworded_quote_texts", detail: { cases: done } });
    });
  } catch (e) {
    console.error(`[swapup] stored quote words: not reworded — ${(e as Error).message}`);
    return [];
  }
  return done;
}

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
    org.run(DEMO_PARTNER.orgId, DEMO_PARTNER.name, "partner", null, null, null, "{}", 0, now);
    const s1 = { ...orgSettingsDefaults(), releaseOn: "collected" };
    const s2 = { ...orgSettingsDefaults(), releaseOn: "cleared", maxAgeDays: 5 };
    org.run("org_samsung_svc", "SwapUp Experience Centers (demo)", "client", "oem_service", "Samsung", DEMO_PARTNER.orgId, JSON.stringify(s1), 1, now);
    org.run("org_xc", "Any Client — Experience Centres (demo)", "client", "experience_center", "Samsung", DEMO_PARTNER.orgId, JSON.stringify(s2), 1, now);

    const store = d.prepare(`INSERT INTO stores (id, org_id, name, kind, city, code, credit_limit, created_at) VALUES (?,?,?,?,?,?,?,?)`);
    store.run("st_and", "org_samsung_svc", "Andheri West Experience Center", "service_center", "Mumbai", "AND", 300_000, now);
    store.run("st_kor", "org_samsung_svc", "Koramangala Experience Center", "service_center", "Bengaluru", "KOR", 95_000, now);
    store.run("st_cpx", "org_xc", "Connaught Place Experience Centre", "experience_center", "New Delhi", "CPX", 500_000, now);

    const user = d.prepare(`INSERT INTO users (id, org_id, store_id, username, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?,?,?)`);
    const users: [string, string, string | null, string, string, Role][] = [
      ["usr_platform", "org_platform", null, "platform", "SwapUp Ops", "platform"],
      [DEMO_PARTNER.userId, DEMO_PARTNER.orgId, null, DEMO_PARTNER.username, DEMO_PARTNER.userName, "partner"],
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
