import { query, queryOne, execute, tx, nowIso, todayIso, newId, parseJson, audit } from "./db";
import { hashPassword, orgSettingsDefaults, type Role } from "./auth";
import { postEvents } from "./credit";
import seedData from "./seed-data.json";
import type { Campaign } from "../domain/bonus";
import { cancelEvents } from "../domain/lifecycle";
import { NOT_ON_CARD, RETIRED_QUOTE_LABEL, RETIRED_SOURCE_KIND, retiredSource } from "../domain/ratecard";
import { NO_MARKET_PRICE } from "../domain/offer";

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
      const has = await queryOne<{ n: string | number }>(`SELECT COUNT(*) n FROM orgs`);
      if (Number(has?.n || 0) === 0) await seedBase();
      const added = await backfillTradeModels();
      if (added.length) console.log(`[swapup] trade models added to the catalogue from the seed data: ${added.join(", ")}`);
      await backfillModelCodes();
      await renameDemoCentres();
      await renameDemoPartner();
      await renameDemoPartnerIds();
      const removed = await removeExampleCases();
      if (removed.length) console.log(`[swapup] removed ${removed.length} example cases seeded on first boot: ${removed.join(", ")}`);
      const r = await retireOldQuotes();
      if (r.relabelled.length) console.log(`[swapup] test cases with a retired quote relabelled "${RETIRED_QUOTE_LABEL}": ${r.relabelled.join(", ")}`);
      if (r.cancelled.length) console.log(`[swapup] locked test trade-ins on a retired quote cancelled, their holds released: ${r.cancelled.join(", ")}`);
      if (r.history.length) console.warn(`[swapup] test trade-ins on a retired quote already in a pickup or collected — not cancelled, the owner decides: ${r.history.join(", ")}`);
      const reworded = await rewordQuoteTexts();
      if (reworded.length) console.log(`[swapup] cases whose stored words asked staff to type a trade-in price, reworded: ${reworded.join(", ")}`);
    })();
  }
  return g.__swapup_seed;
}

export async function backfillTradeModels(): Promise<string[]> {
  const rows = await query<{ id: string }>(`SELECT id FROM trade_models`);
  const have = new Set(rows.map((r) => r.id));
  const missing = DATA.tradeModels.filter((m) => !have.has(m.id));
  if (!missing.length) return [];
  const added: string[] = [];
  await tx(async () => {
    for (const m of missing) {
      const r = await execute(
        `INSERT INTO trade_models (id, brand, model, series, release_year, support_end_year, variants, service_tier, care_plus_fee, model_codes, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO NOTHING`,
        [m.id, m.brand, m.model, m.series, m.releaseYear, m.supportEndYear, JSON.stringify(m.variants), m.serviceTier, m.carePlusFee, JSON.stringify(m.modelCodes ?? []), JSON.stringify(m.source)]
      );
      if (r.rowCount > 0) added.push(m.id);
    }
    if (added.length) await audit({ action: "catalog.trade_models.backfill", entity: "trade_models", detail: { added } });
  });
  return added;
}

async function backfillModelCodes(): Promise<void> {
  const empty = await query<{ id: string }>(`SELECT id FROM trade_models WHERE model_codes = '[]' OR model_codes IS NULL`);
  if (!empty.length) return;
  const byId = new Map(DATA.tradeModels.map((m) => [m.id, m.modelCodes ?? []]));
  await tx(async () => {
    for (const r of empty) {
      const codes = byId.get(r.id);
      if (codes && codes.length) await execute(`UPDATE trade_models SET model_codes = $1 WHERE id = $2`, [JSON.stringify(codes), r.id]);
    }
  });
}

async function renameDemoCentres(): Promise<void> {
  const meta = await queryOne<{ '?column?': number }>(`SELECT 1 FROM meta WHERE key = 'renamed_experience_centers'`);
  if (meta) return;
  await tx(async () => {
    await execute(`UPDATE orgs SET name = 'SwapUp Experience Centers (demo)' WHERE id = 'org_samsung_svc' AND demo = 1 AND name = 'Samsung Service Centres (demo)'`);
    await execute(`UPDATE stores SET name = $1 WHERE id = $2 AND org_id = 'org_samsung_svc' AND name = $3`, ["Andheri West Experience Center", "st_and", "Andheri West Service Centre"]);
    await execute(`UPDATE stores SET name = $1 WHERE id = $2 AND org_id = 'org_samsung_svc' AND name = $3`, ["Koramangala Experience Center", "st_kor", "Koramangala Service Centre"]);
    await execute(`INSERT INTO meta (key, value) VALUES ('renamed_experience_centers', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [nowIso()]);
  });
}

export const DEMO_PARTNER = { orgId: "ptn_demo", name: "Buyback Partner (demo)", userId: "usr_partner", username: "partner", userName: "Partner Ops (demo)" } as const;

export async function demoPartnerId(): Promise<string | null> {
  const r = await queryOne<{ id: string }>(
    `SELECT p.id FROM orgs c JOIN orgs p ON p.id = c.partner_id AND p.kind = 'partner' WHERE c.id = 'org_samsung_svc' AND c.demo = 1`
  );
  return r?.id ?? null;
}

export async function renameDemoPartner(): Promise<void> {
  const meta = await queryOne<{ '?column?': number }>(`SELECT 1 FROM meta WHERE key = 'renamed_demo_partner'`);
  if (meta) return;
  const id = await demoPartnerId();
  const oldRow = id ? await queryOne<{ name: string }>(`SELECT name FROM orgs WHERE id = $1`, [id]) : null;
  const old = oldRow?.name ?? null;
  const P = DEMO_PARTNER;
  await tx(async () => {
    if (id && old && old !== P.name) {
      await execute(`UPDATE orgs SET name = $1 WHERE id = $2`, [P.name, id]);
      await execute(
        `UPDATE users SET username = $1 WHERE org_id = $2 AND role = 'partner' AND lower(username) = lower($3) AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.username = $4)`,
        [P.username, id, old, P.username]
      );
      await execute(`UPDATE users SET name = $1 WHERE org_id = $2 AND role = 'partner' AND name = $3`, [P.userName, id, `${old} Ops (demo)`]);
      await execute(`UPDATE pickups SET collector_name = 'Sunil (partner)' WHERE demo = 1 AND partner_id = $1 AND collector_name = $2`, [id, `Sunil (${old})`]);
      await renameCopies(id, old);
    }
    await execute(`INSERT INTO meta (key, value) VALUES ('renamed_demo_partner', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [nowIso()]);
  });
}

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

export async function renameDemoPartnerIds(): Promise<void> {
  const meta = await queryOne<{ '?column?': number }>(`SELECT 1 FROM meta WHERE key = 'renamed_demo_partner_ids'`);
  if (meta) return;
  const P = DEMO_PARTNER;
  const oldOrg = await demoPartnerId();
  const oldUserRow = oldOrg
    ? await queryOne<{ id: string }>(`SELECT id FROM users WHERE org_id = $1 AND role = 'partner' ORDER BY created_at, id LIMIT 1`, [oldOrg])
    : null;
  const oldUser = oldUserRow?.id ?? null;
  const free = async (table: string, id: string) => !(await queryOne(`SELECT 1 FROM ${table} WHERE id = $1`, [id]));
  const move = async (cols: readonly [string, string][], table: string, from: string, to: string) => {
    for (const [t, c] of cols) await execute(`UPDATE ${t} SET ${c} = $1 WHERE ${c} = $2`, [to, from]);
    await execute(`UPDATE audit SET entity_id = $1 WHERE entity_id = $2`, [to, from]);
    await execute(`UPDATE audit SET detail = replace(detail, $1, $2) WHERE position($3 in detail) > 0`, [JSON.stringify(from), JSON.stringify(to), JSON.stringify(from)]);
    await execute(`UPDATE ${table} SET id = $1 WHERE id = $2`, [to, from]);
  };
  await tx(async () => {
    await execute("SET CONSTRAINTS ALL DEFERRED");
    if (oldOrg && oldOrg !== P.orgId && (await free("orgs", P.orgId))) await move(ORG_ID_COLUMNS, "orgs", oldOrg, P.orgId);
    if (oldUser && oldUser !== P.userId && (await free("users", P.userId))) await move(USER_ID_COLUMNS, "users", oldUser, P.userId);
    await execute(`INSERT INTO meta (key, value) VALUES ('renamed_demo_partner_ids', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [nowIso()]);
  });
}

async function renameCopies(partnerId: string, old: string): Promise<void> {
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
  const cols = ["quote", "repaired_quote", "storage_quotes", "camera_check", "clearance"];
  const cases = await query<{ id: string; quote: string | null; repaired_quote: string | null; storage_quotes: string | null; camera_check: string | null; clearance: string | null }>(
    `SELECT id, quote, repaired_quote, storage_quotes, camera_check, clearance FROM cases
     WHERE org_id IN (SELECT id FROM orgs WHERE partner_id = $1)`,
    [partnerId]
  );
  for (const c of cases) {
    let changed = false;
    const upd: Record<string, string | null> = {};
    for (const col of cols) {
      let val = c[col as keyof typeof c];
      if (!val) continue;
      const initial = val;
      for (const [from, to] of swaps) {
        val = val.split(from).join(to);
      }
      if (val !== initial) {
        upd[col] = val;
        changed = true;
      }
    }
    if (changed) {
      const keys = Object.keys(upd);
      const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
      const params = keys.map((k) => upd[k]);
      params.push(c.id);
      await execute(`UPDATE cases SET ${setClauses} WHERE id = $${params.length}`, params);
    }
  }
}

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

export async function removeExampleCases(): Promise<string[]> {
  const meta = await queryOne<{ '?column?': number }>(`SELECT 1 FROM meta WHERE key = 'removed_example_cases'`);
  if (meta) return [];
  const hits: { id: string; ref: string }[] = [];
  for (const e of SEEDED_EXAMPLE_CASES) {
    const rows = await query<{ id: string; ref: string }>(
      `SELECT c.id, c.ref FROM cases c JOIN orgs o ON o.id = c.org_id
        WHERE c.demo = 1 AND o.demo = 1 AND c.store_id = $1
          AND (c.customer::jsonb #>> '{name}') = $2 AND (c.customer::jsonb #>> '{phone}') = $3`,
      [e.store, e.name, e.phone]
    );
    hits.push(...rows);
  }
  const refs = hits.map((h) => h.ref).sort();
  await tx(async () => {
    for (const { id } of hits) {
      await execute(`DELETE FROM credit_ledger WHERE case_id = $1`, [id]);
      await execute(`DELETE FROM test_sessions WHERE case_id = $1`, [id]);
      await execute(`DELETE FROM grading_reports WHERE case_id = $1`, [id]);
      await execute(`UPDATE phonecheck_records SET case_id = NULL, attached_at = NULL, attached_by = NULL WHERE case_id = $1`, [id]);
      await execute(`DELETE FROM cases WHERE id = $1`, [id]);
      await execute(`DELETE FROM audit WHERE entity = 'case' AND entity_id = $1`, [id]);
    }
    const pickups = await query<{ id: string; ref: string }>(
      `SELECT id, ref FROM pickups WHERE demo = 1 AND NOT EXISTS (SELECT 1 FROM cases c WHERE c.pickup_id = pickups.id)`
    );
    for (const p of pickups) {
      await execute(`DELETE FROM pickups WHERE id = $1`, [p.id]);
      await execute(`DELETE FROM audit WHERE entity = 'pickup' AND entity_id = $1`, [p.id]);
    }
    if (refs.length || pickups.length) await audit({ action: "seed.example_cases_removed", detail: { cases: refs, pickups: pickups.map((p) => p.ref) } });
    await execute(`INSERT INTO meta (key, value) VALUES ('removed_example_cases', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ at: nowIso(), cases: refs })]);
  });
  return refs;
}

export const RETIRED_QUOTE_CANCEL_REASON = "Retired test quote — priced from a source SwapUp no longer uses. Cancelled; the store's credit line is released.";

type QuoteLike = { source?: { kind?: string | null; label?: string | null } | null } & Record<string, unknown>;

function relabelled(q: QuoteLike | null): QuoteLike | null {
  if (!q || !q.source || !retiredSource(q.source.kind)) return q;
  return { ...q, source: { kind: RETIRED_SOURCE_KIND, label: RETIRED_QUOTE_LABEL } };
}

const OPEN_TRADE_STATUSES = ["locked", "in_pickup", "collected"];

export async function retireOldQuotes(): Promise<{ relabelled: string[]; cancelled: string[]; history: string[] }> {
  const out = { relabelled: [] as string[], cancelled: [] as string[], history: [] as string[] };
  const meta = await queryOne<{ '?column?': number }>(`SELECT 1 FROM meta WHERE key = 'retired_test_quotes'`);
  if (meta) return out;
  type Row = { id: string; ref: string; status: string; org_id: string; store_id: string; quote: string | null; repaired_quote: string | null; decision: string | null; storage_quotes: string | null; trade_value: number | null };
  const rows = await query<Row>(
    `SELECT c.id, c.ref, c.status, c.org_id, c.store_id, c.quote, c.repaired_quote, c.decision, c.storage_quotes, c.trade_value
       FROM cases c JOIN orgs o ON o.id = c.org_id
      WHERE o.demo = 1 AND (c.quote IS NOT NULL OR c.repaired_quote IS NOT NULL OR c.storage_quotes IS NOT NULL)
      ORDER BY c.ref`
  );
  for (const r of rows) {
    const quote = parseJson<QuoteLike | null>(r.quote, null);
    const repaired = parseJson<QuoteLike | null>(r.repaired_quote, null);
    const chips = parseJson<Record<string, unknown>[] | null>(r.storage_quotes, null);
    const retiredQuote = retiredSource(quote?.source?.kind);
    const retiredRepaired = retiredSource(repaired?.source?.kind);
    const retiredChips = Array.isArray(chips) && chips.some((c) => !!c && typeof c === "object" && c.sample === true);
    if (!retiredQuote && !retiredRepaired && !retiredChips) continue;
    try {
      await tx(async () => {
        const now = nowIso();
        const decision = parseJson<{ caveats?: unknown } | null>(r.decision, null);
        const caveats = decision && Array.isArray(decision.caveats) ? (decision.caveats as unknown[]) : null;
        const keptCaveats = caveats ? caveats.filter((c) => !(typeof c === "string" && /\bsample\b/i.test(c))) : null;
        await execute(
          `UPDATE cases SET quote = $1, repaired_quote = $2, storage_quotes = $3, decision = $4, updated_at = $5 WHERE id = $6`,
          [
            quote ? JSON.stringify(relabelled(quote)) : r.quote,
            repaired ? JSON.stringify(relabelled(repaired)) : r.repaired_quote,
            retiredChips ? null : r.storage_quotes,
            decision && keptCaveats && keptCaveats.length !== caveats!.length ? JSON.stringify({ ...decision, caveats: keptCaveats }) : r.decision,
            now,
            r.id,
          ]
        );
        let cancelled = false;
        if (retiredQuote && r.status === "locked") {
          const upd = await execute(
            `UPDATE cases SET status = 'cancelled', closed_reason = $1, closed_at = $2, updated_at = $3 WHERE id = $4 AND status = 'locked'`,
            [RETIRED_QUOTE_CANCEL_REASON, now, now, r.id]
          );
          if (upd.rowCount === 1) {
            const held = await queryOne<{ n: string | number }>(
              `SELECT COALESCE(SUM(CASE kind WHEN 'hold' THEN amount ELSE 0 END), 0) - COALESCE(SUM(CASE kind WHEN 'release' THEN amount ELSE 0 END), 0) AS n
                 FROM credit_ledger WHERE case_id = $1`,
              [r.id]
            );
            const outstanding = Number(held?.n || 0);
            if (outstanding > 0) await postEvents(r.store_id, cancelEvents(r.id, outstanding, now), null);
            await audit({ orgId: r.org_id, storeId: r.store_id, action: "case.cancel", entity: "case", entityId: r.id, detail: { reason: RETIRED_QUOTE_CANCEL_REASON, automatic: true, released: Math.max(0, outstanding), tradeValue: r.trade_value } });
            cancelled = true;
          }
        }
        if (cancelled) out.cancelled.push(r.ref);
        else if (retiredQuote && r.status !== "locked" && OPEN_TRADE_STATUSES.includes(r.status)) out.history.push(`${r.ref} (${r.status})`);
        out.relabelled.push(r.ref);
      });
    } catch (e) {
      console.error(`[swapup] ${r.ref}: its retired quote could not be retired — ${(e as Error).message}`);
    }
  }
  try {
    await tx(async () => {
      if (out.relabelled.length) await audit({ action: "seed.retired_test_quotes", detail: out });
      await execute(`INSERT INTO meta (key, value) VALUES ('retired_test_quotes', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ at: nowIso(), ...out })]);
    });
  } catch (e) {
    console.error(`[swapup] retired test quotes: not recorded — ${(e as Error).message}`);
  }
  return out;
}

export const REWORDED_QUOTE_TEXTS: readonly (readonly [string, string])[] = [
  ["No market price yet — enter a quote.", NO_MARKET_PRICE],
  ["No rate-card price for this model and storage — ask the partner.", NOT_ON_CARD],
  ["— check Settings, then enter the partner's quote.", "— no trade-in price for that size."],
];
const OLDER_SIZE_FLAG = / Check Settings › About phone, and enter the partner's quote on the full case if it's really [^."]+\./g;
export const OLDER_SIZE_FLAG_NEEDLE = "enter the partner's quote on the full case";

export async function rewordQuoteTexts(): Promise<string[]> {
  const cols = ["quote", "repaired_quote", "storage_quotes", "camera_check"] as const;
  const needles = [...REWORDED_QUOTE_TEXTS.map(([from]) => from), OLDER_SIZE_FLAG_NEEDLE];
  type Row = { id: string; ref: string } & Record<(typeof cols)[number], string | null>;
  const done: string[] = [];
  try {
    const whereConditions: string[] = [];
    const args: unknown[] = [];
    for (const c of cols) {
      for (const needle of needles) {
        args.push(`%${needle}%`);
        whereConditions.push(`${c} LIKE $${args.length}`);
      }
    }
    const rows = await query<Row>(
      `SELECT id, ref, ${cols.join(", ")} FROM cases WHERE ${whereConditions.join(" OR ")} ORDER BY ref`,
      args
    );
    if (!rows.length) return done;
    await tx(async () => {
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
        const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
        const params = keys.map((k) => sets[k]!);
        params.push(r.id);
        await execute(`UPDATE cases SET ${setClauses} WHERE id = $${params.length}`, params);
        done.push(r.ref);
      }
      if (done.length) await audit({ action: "seed.reworded_quote_texts", detail: { cases: done } });
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

async function seedBase(): Promise<void> {
  const now = nowIso();
  const pw = hashPassword(demoPassword());
  await tx(async () => {
    const insertOrg = async (id: string, name: string, kind: string, client_type: string | null, target_brand: string | null, partner_id: string | null, settings: string, demo: number) => {
      await execute(
        `INSERT INTO orgs (id, name, kind, client_type, target_brand, partner_id, settings, demo, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [id, name, kind, client_type, target_brand, partner_id, settings, demo, now]
      );
    };

    await insertOrg("org_platform", "SwapUp", "platform", null, null, null, "{}", 0);
    await insertOrg(DEMO_PARTNER.orgId, DEMO_PARTNER.name, "partner", null, null, null, "{}", 0);
    const s1 = { ...orgSettingsDefaults(), releaseOn: "collected" };
    const s2 = { ...orgSettingsDefaults(), releaseOn: "cleared", maxAgeDays: 5 };
    await insertOrg("org_samsung_svc", "SwapUp Experience Centers (demo)", "client", "oem_service", "Samsung", DEMO_PARTNER.orgId, JSON.stringify(s1), 1);
    await insertOrg("org_xc", "Any Client — Experience Centres (demo)", "client", "experience_center", "Samsung", DEMO_PARTNER.orgId, JSON.stringify(s2), 1);

    const insertStore = async (id: string, org_id: string, name: string, kind: string, city: string, code: string, credit_limit: number) => {
      await execute(
        `INSERT INTO stores (id, org_id, name, kind, city, code, credit_limit, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [id, org_id, name, kind, city, code, credit_limit, now]
      );
    };
    await insertStore("st_and", "org_samsung_svc", "Andheri West Experience Center", "service_center", "Mumbai", "AND", 300_000);
    await insertStore("st_kor", "org_samsung_svc", "Koramangala Experience Center", "service_center", "Bengaluru", "KOR", 95_000);
    await insertStore("st_cpx", "org_xc", "Connaught Place Experience Centre", "experience_center", "New Delhi", "CPX", 500_000);

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
    for (const u of users) {
      await execute(
        `INSERT INTO users (id, org_id, store_id, username, name, role, password_hash, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [...u, pw, now]
      );
    }

    for (const m of DATA.tradeModels) {
      await execute(
        `INSERT INTO trade_models (id, brand, model, series, release_year, support_end_year, variants, service_tier, care_plus_fee, model_codes, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [m.id, m.brand, m.model, m.series, m.releaseYear, m.supportEndYear, JSON.stringify(m.variants), m.serviceTier, m.carePlusFee, JSON.stringify(m.modelCodes ?? []), JSON.stringify(m.source)]
      );
    }

    for (const orgId of ["org_samsung_svc", "org_xc"]) {
      for (const r of DATA.repairBook) {
        await execute(
          `INSERT INTO repair_book (org_id, model_id, part, price, source)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id, model_id, part) DO NOTHING`,
          [orgId, r.modelId, r.part, r.price, JSON.stringify(r.source)]
        );
      }
      for (const n of DATA.newDevices) {
        await execute(
          `INSERT INTO new_devices (id, org_id, brand, model, series, variant, price, support_end_year, active, sort, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10) ON CONFLICT (id) DO NOTHING`,
          [newId("nd"), orgId, n.brand, n.model, n.series, n.variant, n.price, n.supportEndYear, n.sort, JSON.stringify(n.source)]
        );
      }
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
    await execute(
      `INSERT INTO campaigns (id, org_id, data, active, created_at) VALUES ($1,$2,$3,1,$4) ON CONFLICT (id) DO NOTHING`,
      [c1.id, "org_samsung_svc", JSON.stringify(c1), now]
    );
    await execute(
      `INSERT INTO campaigns (id, org_id, data, active, created_at) VALUES ($1,$2,$3,1,$4) ON CONFLICT (id) DO NOTHING`,
      [c2.id, "org_xc", JSON.stringify(c2), now]
    );
  });
}
