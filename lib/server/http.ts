import { NextResponse } from "next/server";
import { HttpError } from "./auth";

/**
 * Every API route body runs inside `handle()`: an HttpError becomes its status
 * and message; anything else is a 500 whose detail is logged, not leaked.
 */
export async function handle<T>(fn: () => Promise<T> | T): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json(data ?? { ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    // Domain rule violations (lib/domain/errors.ts) — duck-typed so a second
    // copy of the module in another bundle chunk still matches.
    if (e && typeof e === "object" && (e as { name?: string }).name === "RuleError") {
      const r = e as { message: string; status?: number };
      return NextResponse.json({ error: r.message }, { status: r.status ?? 409 });
    }
    console.error("[swapup] unhandled", e);
    return NextResponse.json({ error: "Something went wrong on our side." }, { status: 500 });
  }
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}
