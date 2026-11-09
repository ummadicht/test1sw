import { query, queryOne } from "./db";
import { HttpError, type SessionUser } from "./auth";
import { ownStore } from "./scope";
import { indianMobile } from "../domain/phone";
import type { CaseStatus } from "../domain/lifecycle";

/**
 * FIND A CUSTOMER BY MOBILE — the counter's first step (docs/TWO-PASS-CAMERA.md):
 * the advisor keys the mobile number, and a returning customer's name comes
 * back with their earlier trade-ins, so nobody retypes it.
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
  customer: { name: string; phone: string } | null;
  history: CustomerHistoryItem[];
};

const PHONE_OF = `CASE WHEN c.customer IS NOT NULL AND c.customer != '' AND c.customer != '{}' THEN (c.customer::jsonb->>'phone') END`;
const NAME_OF = `CASE WHEN c.customer IS NOT NULL AND c.customer != '' AND c.customer != '{}' THEN TRIM(COALESCE((c.customer::jsonb->>'name'), '')) END`;

export async function findCustomer(u: SessionUser, rawPhone: unknown): Promise<CustomerLookup> {
  if (u.role !== "advisor" && u.role !== "store_manager") throw new HttpError(403, "Only store staff look up customers at the counter.");
  const phone = indianMobile(rawPhone);
  if (!phone) throw new HttpError(400, "Enter a 10-digit Indian mobile number.");
  const store = await ownStore(u);
  const orgId = store.org_id;

  const rows = await query<{
    id: string;
    ref: string;
    status: CaseStatus;
    variant: string | null;
    created_at: string;
    store_name: string;
    brand: string | null;
    model_name: string | null;
  }>(
    `SELECT c.id, c.ref, c.status, c.variant, c.created_at, s.name AS store_name, t.brand, t.model AS model_name
     FROM cases c JOIN stores s ON s.id = c.store_id LEFT JOIN trade_models t ON t.id = c.model_id
     WHERE c.org_id = $1 AND ${PHONE_OF} = $2
     ORDER BY c.created_at DESC, c.ref DESC
     LIMIT ${HISTORY_MAX}`,
    [orgId, phone]
  );
  if (!rows.length) return { customer: null, history: [] };

  const named = await queryOne<{ name: string }>(
    `SELECT ${NAME_OF} AS name FROM cases c
     WHERE c.org_id = $1 AND ${PHONE_OF} = $2 AND ${NAME_OF} != ''
     ORDER BY c.created_at DESC, c.ref DESC LIMIT 1`,
    [orgId, phone]
  );

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
