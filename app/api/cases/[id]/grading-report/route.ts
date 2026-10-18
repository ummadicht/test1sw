import { handle } from "@/lib/server/http";
import { requireUser } from "@/lib/server/auth";
import { gradingReportFor } from "@/lib/server/gradingReport";

/**
 * The case's grading report, filtered by who asks (docs/GRADING.md):
 *   staff    { live, issued, versions, path, staff } — the live grade, the latest
 *            issued version, every version, the public link and the staff extras.
 *   partner  { live: null, issued, versions: [that one], path, staff: null } — only
 *            the version frozen at hand-over (404 before the trade-in, like the case).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    const { id } = await ctx.params;
    return gradingReportFor(u, id);
  });
}
