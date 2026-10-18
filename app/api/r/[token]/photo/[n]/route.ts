import { handle } from "@/lib/server/http";
import { reportPhoto } from "@/lib/server/gradingReport";

/**
 * GET /api/r/<token>/photo/<n>[?v=] — photo n of that report version, streamed
 * from the camera's photo store. Only a photo the version lists; never a
 * redirect (the store's URL carries the grading session's key); 404 otherwise.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string; n: string }> }) {
  try {
    const { token, n } = await ctx.params;
    const res = await reportPhoto(token, n, new URL(req.url).searchParams.get("v"));
    res.headers.set("x-robots-tag", "noindex, nofollow");
    return res;
  } catch (e) {
    return handle(() => {
      throw e;
    });
  }
}
