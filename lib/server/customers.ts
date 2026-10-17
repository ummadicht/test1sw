import { db } from "./db";
import { HttpError, type SessionUser } from "./auth";
import { ownStore } from "./scope";
import { indianMobile } from "../domain/phone";
import type { CaseStatus } from "../domain/lifecycle";

/**
 * FIND A CUSTOMER BY MOBILE — the counter's first step (docs/TWO-PASS-CAMERA.md):
 * the advisor keys the mobile number, and a returning customer's name comes
 * back with their earlier trade-ins, so nobody retypes it.
 *
 * There is no customer table: a customer is whatever earlier cases recorded in
 * `cases.customer` (JSON). createCase and lockTradeIn both store the phone as
 * bare digits, so the lookup reduces the number it is given the same way.
 *
 * Scope: counter staff only, and only cases of their own organisation — a
 * customer who traded in at a sister store is still a returning customer, but
 * another client's customers are never visible. Other roles have no counter.
 */

const HISTORY_MAX = 10;

export type CustomerHistoryItem = {
  caseId: string;
  ref: string;
  status: CaseStatus;
  storeName: string;
  device: string | null;
  createdAt: string;
};

export type CustomerLookup = {
  /** null = no earlier case has this number. `name` is "" when none of them recorded a name. */
  customer: { name: string; phone: string } | null;
  /** Newest first, at most 10. */
  history: CustomerHistoryItem[];
};

// json_extract on text that is not JSON raises an error for the WHOLE query;
// json_valid first keeps one bad row from breaking every lookup.
const PHONE_OF = `CASE WHEN json_valid(c.customer) THEN json_extract(c.customer, '$.phone') END`;
const NAME_OF = `CASE WHEN json_valid(c.customer) THEN TRIM(COALESCE(json_extract(c.customer, '$.name'), '')) END`;

export function findCustomer(u: SessionUser, rawPhone: unknown): CustomerLookup {
  if (u.role !== "advisor" && u.role !== "store_manager") throw new HttpError(403, "Only store staff look up customers at the counter.");
  const phone = indianMobile(rawPhone);
  if (!phone) throw new HttpError(400, "Enter a 10-digit Indian mobile number.");
  const orgId = ownStore(u).org_id;

  const rows = db()
    .prepare(
      `SELECT c.id, c.ref, c.status, c.variant, c.created_at, s.name AS store_name, t.brand, t.model AS model_name
       FROM cases c JOIN stores s ON s.id = c.store_id LEFT JOIN trade_models t ON t.id = c.model_id
       WHERE c.org_id = ? AND ${PHONE_OF} = ?
       ORDER BY c.created_at DESC, c.ref DESC
       LIMIT ${HISTORY_MAX}`
    )
    .all(orgId, phone) as { id: string; ref: string; status: CaseStatus; variant: string | null; created_at: string; store_name: string; brand: string | null; model_name: string | null }[];
  if (!rows.length) return { customer: null, history: [] };

  // The newest name anyone recorded — a case opened with only the number has none,
  // and that one may be older than the ten listed.
  const named = db()
    .prepare(
      `SELECT ${NAME_OF} AS name FROM cases c
       WHERE c.org_id = ? AND ${PHONE_OF} = ? AND ${NAME_OF} != ''
       ORDER BY c.created_at DESC, c.ref DESC LIMIT 1`
    )
    .get(orgId, phone) as { name: string } | undefined;

  return {
    customer: { name: named?.name ?? "", phone },
    history: rows.map((r) => ({
      caseId: r.id,
      ref: r.ref,
      status: r.status,
      storeName: r.store_name,
      device: r.model_name ? `${r.brand} ${r.model_name}${r.variant ? " " + r.variant : ""}` : null,
      createdAt: r.created_at,
    })),
  };
}
