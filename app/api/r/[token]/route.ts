import { handle } from "@/lib/server/http";
import { publicReport } from "@/lib/server/gradingReport";

/**
 * GET /api/r/<token>[?v=n] — the grading report behind a public link: the latest
 * version, or version n. No sign-in (the 128-bit token is the key), no list of
 * versions, never cached; 404 for an unknown token or version. The body has no
 * money, no customer and a masked IMEI; sha256 is the hash of
 * canonicalJson(body), which anyone can recompute.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const res = await handle(async () => {
    const { token } = await ctx.params;
    return publicReport(token, new URL(req.url).searchParams.get("v"));
  });
  res.headers.set("x-robots-tag", "noindex, nofollow");
  return res;
}
