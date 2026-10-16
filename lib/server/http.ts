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

/**
 * The public origin for links this response hands out (join QR, deep link):
 * SWAPUP_PUBLIC_URL when set — production always sets it, so a forged Host
 * header changes nothing there — else the origin the request arrived on
 * (Host / X-Forwarded-Host), e.g. the local web-app proxy on :4620 or the
 * Mac's LAN IP when a phone is testing against a dev server.
 */
export function publicOrigin(req: Request): string {
  return originFromHeaders(req.headers, new URL(req.url).protocol.replace(/:$/, "")) ?? new URL(req.url).origin;
}

/** As publicOrigin, for server components (`await headers()`). null = nothing usable. */
export function originFromHeaders(h: Headers, defaultProto = "http"): string | null {
  const env = process.env.SWAPUP_PUBLIC_URL;
  if (env) return env.replace(/\/$/, "");
  const host = (h.get("x-forwarded-host") || h.get("host") || "").split(",")[0].trim();
  const proto = (h.get("x-forwarded-proto") || "").split(",")[0].trim() || defaultProto;
  if (host && /^[A-Za-z0-9.\-\[\]:]+$/.test(host) && /^https?$/.test(proto)) return `${proto}://${host}`;
  return null;
}
