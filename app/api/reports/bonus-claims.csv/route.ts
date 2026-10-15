import { NextResponse } from "next/server";
import { HttpError, requireUser } from "@/lib/server/auth";
import { bonusClaims, toCsv, type BonusClaimRow } from "@/lib/server/reports";
import { getOrg } from "@/lib/server/scope";
import { CASE_STATUS_LABEL, type CaseStatus } from "@/lib/domain/lifecycle";

const AT_RISK: Record<string, string> = {
  rejected: "Claim at risk: device failed partner check",
  not_received: "Claim at risk: partner says the device never arrived",
};

const HEADER = [
  "Case",
  "Store",
  "Store code",
  "Traded in at (UTC)",
  "New phone",
  "New phone price (INR)",
  "Trade-in value (INR)",
  "Bonus (%)",
  "Bonus (INR)",
  "Campaign",
  "Funded by",
  "Bonus override",
  "Case status",
  "Claim note",
];

function csvRow(r: BonusClaimRow): Record<string, unknown> {
  const v = [
    r.caseRef,
    r.storeName,
    r.storeCode,
    r.lockedAt,
    r.newDevice,
    r.newPrice,
    r.tradeValue,
    r.bonusBp / 100,
    r.bonus,
    r.campaign,
    r.fundedBy,
    r.override ?? "",
    CASE_STATUS_LABEL[r.status as CaseStatus] ?? r.status,
    AT_RISK[r.status] ?? "",
  ];
  return Object.fromEntries(HEADER.map((h, i) => [h, v[i]]));
}

/**
 * The month's upgrade-bonus claims as a spreadsheet, for claiming the bonus back
 * from whoever funds the campaign. Not wrapped by handle(): the success body is
 * CSV, but errors are still JSON with the right status.
 */
export async function GET(req: Request) {
  try {
    const u = await requireUser(["org_admin", "platform", "store_manager"]);
    const p = new URL(req.url).searchParams;
    const orgId = p.get("orgId");
    const monthRaw = p.get("month");
    const month = monthRaw && /^\d{4}-\d{2}$/.test(monthRaw) ? monthRaw : null;
    const rows = bonusClaims(u, { orgId, month });
    const csv = rows.length ? toCsv(rows.map(csvRow)) : HEADER.join(",");
    // Name the file after the caller's own org; only platform staff may name another one.
    const nameOrg = u.role === "platform" && orgId ? orgId : u.orgId;
    const orgSlug = (getOrg(nameOrg)?.name ?? "programme").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const file = `swapup-bonus-claims-${orgSlug || "programme"}-${month ?? "all-months"}.csv`;
    // BOM so Excel opens ₹ and accented names correctly.
    return new NextResponse(`﻿${csv}\n`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${file}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[swapup] bonus-claims.csv", e);
    return NextResponse.json({ error: "Something went wrong on our side." }, { status: 500 });
  }
}
