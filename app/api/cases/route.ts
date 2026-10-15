import { handle, body } from "@/lib/server/http";
import { requireUser, HttpError } from "@/lib/server/auth";
import { listCases, createCase } from "@/lib/server/cases";
import { CASE_STATUS_LABEL, type CaseStatus } from "@/lib/domain/lifecycle";

const STATUSES = new Set(Object.keys(CASE_STATUS_LABEL));

/** Cases the caller may see. ?status=a,b  ?q=  ?storeId=  ?limit= */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser();
    const url = new URL(req.url);
    const rawStatus = (url.searchParams.get("status") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = rawStatus.find((s) => !STATUSES.has(s));
    if (bad) throw new HttpError(400, `Unknown case status: ${bad}`);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new HttpError(400, "limit must be a positive whole number.");
    return {
      cases: listCases(u, {
        status: rawStatus.length ? (rawStatus as CaseStatus[]) : null,
        q: url.searchParams.get("q") || null,
        storeId: url.searchParams.get("storeId") || null,
        limit,
      }),
    };
  });
}

/** Open a new case at the counter. Customer details are optional at this point. */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(["advisor", "store_manager"]);
    const b = await body<{ customerName?: unknown; customerPhone?: unknown }>(req);
    return createCase(u, {
      customerName: typeof b.customerName === "string" ? b.customerName : undefined,
      customerPhone: typeof b.customerPhone === "string" ? b.customerPhone : undefined,
    });
  });
}
