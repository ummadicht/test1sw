/**
 * TESTS ONLY — a stand-in PriceIQ on 127.0.0.1, answering GET /api/market-grades the way the
 * contract (v1, §1) says the real one does. The dev server can't reach the VM's PriceIQ, so the
 * client is tested against this.
 *
 *   phones      "Galaxy S23 Ultra|256" → the grades PriceIQ would answer (lowest/median/high in
 *               rupees); absent → 404 no-device. `ageDays` dates observedAt that many days before now.
 *   key         the bearer key it accepts; anything else → 401.
 *   candidates  "Galaxy S23|128" → the model names a 409 lists (the query matched more than one).
 *   mode        "ok" (default), "down" (HTTP 503), "slow" (answers after `slowMs`), "garbage",
 *               "html404" (an HTML 404 page on every path — what a wrong base path or a PriceIQ
 *               without this route answers; NOT PriceIQ's own JSON 404).
 *   calls       every request: path + query, and whether it carried the right key.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeGrade = { grade: string; low: number; median?: number; high?: number; points?: number };
export type FakePhone = { grades: FakeGrade[]; ageDays?: number; brand?: string };
export type FakePriceiq = {
  url: string;
  key: string;
  phones: Map<string, FakePhone>;
  candidates: Map<string, string[]>;
  mode: "ok" | "down" | "slow" | "garbage" | "html404";
  slowMs: number;
  calls: { path: string; query: Record<string, string>; keyOk: boolean; authorization: string | null }[];
  close(): Promise<void>;
};

/** "2026-W35" for a date (ISO week). */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day); // the Thursday of this week decides its year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The contract's acceptance phone: Galaxy S23 Ultra 256GB, the lowest listing per grade in the drop. */
export const S23U_256: FakePhone = {
  grades: [
    { grade: "Superb", low: 53_499, median: 55_299, high: 57_099, points: 2 },
    { grade: "Good", low: 51_399, median: 53_099, high: 54_799, points: 2 },
    { grade: "Fair", low: 49_399, median: 50_999, high: 52_599, points: 2 },
    { grade: "Best Value", low: 47_199, median: 47_199, high: 47_199, points: 1 },
  ],
  ageDays: 52,
};

export async function startFakePriceiq(phones: Record<string, FakePhone> = {}, key = "pk_live_test_0000000000000000abcd"): Promise<FakePriceiq> {
  const fake: FakePriceiq = {
    url: "",
    key,
    phones: new Map(Object.entries(phones)),
    candidates: new Map(),
    mode: "ok",
    slowMs: 8_000,
    calls: [],
    close: async () => {},
  };
  const answer = (req: IncomingMessage): { status: number; body: unknown } => {
    const u = new URL(req.url ?? "/", "http://x");
    const query = Object.fromEntries(u.searchParams);
    const authorization = (req.headers.authorization as string | undefined) ?? null;
    const keyOk = authorization === `Bearer ${key}`;
    fake.calls.push({ path: u.pathname, query, keyOk, authorization });
    if (u.pathname !== "/apps/priceiq/api/market-grades") return { status: 404, body: { error: "not found" } };
    if (!keyOk) return { status: 401, body: { error: "a read key is required" } };
    if (fake.mode === "down") return { status: 503, body: { error: "unavailable" } };
    const cands = fake.candidates.get(`${query.model}|${query.storageGb}`);
    if (cands) return { status: 409, body: { error: "more than one device matches", candidates: cands.map((model) => ({ brand: query.brand, model })) } };
    const phone = fake.phones.get(`${query.model}|${query.storageGb}`);
    if (!phone) return { status: 404, body: { error: "no refurbished market price", reason: "no-device" } };
    if (!phone.grades.length) return { status: 404, body: { error: "no refurbished market price", reason: "no-price" } };
    const seen = new Date(Date.now() - (phone.ageDays ?? 3) * 86_400_000);
    return {
      status: 200,
      body: {
        device: { brand: query.brand, model: query.model, storageGb: Number(query.storageGb), ids: ["fake-id"] },
        market: "IN",
        currency: "INR",
        kind: "refurbished market price",
        ask: true,
        week: isoWeek(seen),
        observedAt: seen.toISOString().replace(/\.\d{3}Z$/, "Z"),
        ageDays: phone.ageDays ?? 3,
        stale: (phone.ageDays ?? 3) > 14,
        grades: phone.grades.map((g) => ({ grade: g.grade, lowMinor: g.low * 100, medianMinor: (g.median ?? g.low) * 100, highMinor: (g.high ?? g.low) * 100, points: g.points ?? 1 })),
        // Fields a caller must never keep, even if PriceIQ one day sent them.
        source: "some_partner_feed",
        partner: "Some Partner",
      },
    };
  };
  const server: Server = createServer((req, res) => {
    const reply = () => {
      if (fake.mode === "garbage") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{not json");
      }
      if (fake.mode === "html404") {
        fake.calls.push({ path: new URL(req.url ?? "/", "http://x").pathname, query: {}, keyOk: false, authorization: null });
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        return res.end("<!DOCTYPE html><html><head><title>404: This page could not be found.</title></head><body><h1>404</h1></body></html>");
      }
      const a = answer(req);
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(JSON.stringify(a.body));
    };
    if (fake.mode === "slow") {
      const t = setTimeout(reply, fake.slowMs);
      req.on("close", () => clearTimeout(t));
    } else reply();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/apps/priceiq`;
  fake.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return fake;
}
