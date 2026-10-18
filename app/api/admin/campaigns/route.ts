import { handle, body } from "@/lib/server/http";
import { requireUser, orgSettings, HttpError } from "@/lib/server/auth";
import { campaigns, saveCampaign } from "@/lib/server/catalog";
import { adminOrgId } from "@/lib/server/scope";
import type { Campaign } from "@/lib/domain/bonus";

/** Upgrade-bonus campaigns for the programme, with the band they must sit inside. Platform passes ?orgId=. */
export async function GET(req: Request) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    const orgId = adminOrgId(u, new URL(req.url).searchParams.get("orgId"));
    const s = orgSettings(orgId);
    return { campaigns: campaigns(orgId), band: { minBp: s.bandMinBp, maxBp: s.bandMaxBp } };
  });
}

const STORE_KINDS = ["service_center", "experience_center", "retail"];

/**
 * The counter evaluates every rule's condition on every upgrade, so a rule with a
 * condition it does not understand would break quoting. Check the shape here.
 */
function ruleProblem(c: Campaign): string | null {
  if (!Array.isArray(c.rules)) return "A campaign needs at least one rule.";
  for (const [i, r] of c.rules.entries()) {
    const n = `Rule ${i + 1}`;
    if (!r || typeof r !== "object") return `${n} is empty.`;
    if (typeof r.id !== "string" || !r.id) return `${n} has no id.`;
    if (typeof r.label !== "string" || r.label.trim().length < 3) return `${n}: describe the rule in a few words (the advisor reads it out).`;
    const w = r.when as Campaign["rules"][number]["when"] | undefined;
    if (!w || typeof w !== "object") return `${n}: choose when it applies.`;
    switch (w.kind) {
      case "always":
        break;
      case "old_brand":
        if (!Array.isArray(w.brands) || !w.brands.length || w.brands.some((b) => typeof b !== "string" || !b.trim())) return `${n}: list at least one brand.`;
        break;
      case "target_series":
        if (!Array.isArray(w.series) || !w.series.length || w.series.some((s) => typeof s !== "string" || !s.trim())) return `${n}: pick at least one series.`;
        break;
      case "old_age_years_gte":
        if (typeof w.years !== "number" || !Number.isFinite(w.years) || w.years < 0 || w.years > 20) return `${n}: phone age must be 0–20 years.`;
        break;
      case "repair_ratio_gte":
        if (typeof w.ratio !== "number" || !Number.isFinite(w.ratio) || w.ratio <= 0 || w.ratio > 2) return `${n}: repair share must be between 1% and 200%.`;
        break;
      case "store_kind":
        if (!Array.isArray(w.kinds) || !w.kinds.length || w.kinds.some((k) => !STORE_KINDS.includes(k))) return `${n}: pick at least one store type.`;
        break;
      default:
        return `${n}: unknown condition.`;
    }
  }
  return null;
}

/** Create or update a campaign: { orgId?, campaign, active }. Returns the full list. */
export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser(["org_admin", "platform"]);
    const b = await body<{ orgId?: string; campaign?: Campaign; active?: boolean }>(req);
    const c = b.campaign;
    if (!c || typeof c !== "object") throw new HttpError(400, "Send the campaign.");
    const problem = ruleProblem(c);
    if (problem) throw new HttpError(400, problem);
    const clean: Campaign = {
      id: typeof c.id === "string" ? c.id : "",
      name: String(c.name ?? ""),
      basis: c.basis,
      minBp: Number(c.minBp),
      maxBp: Number(c.maxBp),
      capRupees: c.capRupees === null || c.capRupees === undefined ? null : Number(c.capRupees),
      fundedBy: String(c.fundedBy ?? "").trim().slice(0, 120),
      startsOn: String(c.startsOn ?? ""),
      endsOn: c.endsOn ? String(c.endsOn) : null,
      rules: c.rules.map((r) => ({ id: r.id.slice(0, 40), label: r.label.trim().slice(0, 120), bp: Number(r.bp), when: r.when })),
    };
    if (!clean.fundedBy) throw new HttpError(400, "Say who funds the bonus.");
    return { campaigns: saveCampaign(u, { orgId: b.orgId, campaign: clean, active: b.active !== false }) };
  });
}
