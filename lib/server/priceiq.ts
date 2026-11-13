import { query, execute, tx, nowIso, db } from "./db";
import { isMarketGrade, priceiqModelName, storageGb, NO_MARKET_YET, type ListingRow, type MarketAnswer } from "../domain/marketSell";

export const PRICEIQ_TIMEOUT_MS = 6_000;
export const PRICEIQ_FRESH_MS = 60 * 60_000;
export const PRICEIQ_RETRY_AFTER_FAILURE_MS = 60_000;
export const PRICEIQ_SOURCE = "priceiq";

export const NOT_CONNECTED = `${NO_MARKET_YET.replace(/\.$/, "")} — PriceIQ isn't connected.`;

export type PriceiqConfig = { ok: true; base: string; key: string } | { ok: false; why: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function priceiqConfig(env: Record<string, string | undefined> = process.env): PriceiqConfig {
  const base = (env.PRICEIQ_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = (env.PRICEIQ_API_KEY ?? "").trim();
  if (!base || !key) return { ok: false, why: NOT_CONNECTED };
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { ok: false, why: NOT_CONNECTED };
  }
  if (!(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))) return { ok: false, why: NOT_CONNECTED };
  return { ok: true, base, key };
}

export function maskKey(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : "…";
}

export type MarketAsk = { modelId: string; variant: string; brand: string; model: string };

export type Fetched =
  | { kind: "answer"; rows: ListingRow[]; week: string; observedAt: string | null }
  | { kind: "none" }
  | { kind: "failed"; why: string; log?: string };

export function isPriceiqNone(status: number, body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (status === 404) return b.reason === "no-device" || b.reason === "no-price";
  if (status === 409) return Array.isArray(b.candidates);
  return false;
}

async function jsonOrNull(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text || text.length > 64_000) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const WEEK = /^\d{4}-W\d{2}$/;

export function readMarketGrades(body: unknown): { rows: ListingRow[]; week: string; observedAt: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.currency !== "INR") return null;
  if (b.market !== undefined && b.market !== "IN") return null;
  const week = typeof b.week === "string" && WEEK.test(b.week.trim()) ? b.week.trim() : null;
  if (!week) return null;
  const observed = typeof b.observedAt === "string" && Number.isFinite(Date.parse(b.observedAt)) ? new Date(Date.parse(b.observedAt)).toISOString() : null;
  const rows: ListingRow[] = [];
  for (const g of Array.isArray(b.grades) ? b.grades : []) {
    if (!g || typeof g !== "object") continue;
    const x = g as Record<string, unknown>;
    const low = Number(x.lowMinor);
    if (!isMarketGrade(x.grade) || !Number.isInteger(low) || low < 100) continue;
    const points = Number(x.points);
    rows.push({ grade: x.grade, price: Math.floor(low / 100), week, ...(Number.isInteger(points) && points > 0 ? { points } : {}) });
  }
  return { rows, week, observedAt: observed };
}

export async function askPriceiq(cfg: Extract<PriceiqConfig, { ok: true }>, q: { brand: string; model: string; storageGb: number }): Promise<Fetched> {
  const url = new URL(`${cfg.base}/api/market-grades`);
  url.searchParams.set("brand", q.brand);
  url.searchParams.set("model", q.model);
  url.searchParams.set("storageGb", String(q.storageGb));
  url.searchParams.set("market", "IN");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRICEIQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.key}`, accept: "application/json" }, signal: ctrl.signal, cache: "no-store", redirect: "error" });
    if (res.status === 404 || res.status === 409) {
      if (isPriceiqNone(res.status, await jsonOrNull(res))) return { kind: "none" };
      return {
        kind: "failed",
        why: `PriceIQ answered HTTP ${res.status} without a price answer`,
        log: `not PriceIQ's own ${res.status} — check PRICEIQ_BASE_URL and that this PriceIQ serves /api/market-grades`,
      };
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      return { kind: "failed", why: `PriceIQ refused SwapUp's key (HTTP ${res.status})`, log: `key ${maskKey(cfg.key)}` };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { kind: "failed", why: `PriceIQ answered HTTP ${res.status}` };
    }
    const read = readMarketGrades(await res.json().catch(() => null));
    if (!read) return { kind: "failed", why: "PriceIQ's answer wasn't an India refurbished market price" };
    return read.rows.length ? { kind: "answer", ...read } : { kind: "none" };
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    return { kind: "failed", why: aborted ? `PriceIQ didn't answer within ${PRICEIQ_TIMEOUT_MS / 1000} s` : "PriceIQ couldn't be reached" };
  } finally {
    clearTimeout(timer);
  }
}

type CacheRow = { grade: string; price: number; week: string; points: number | null; fetched_at: string; observed_at: string | null };

export function readCacheSync(modelId: string, variant: string): MarketAnswer | null {
  if (process.env.DATABASE_URL || process.env.PGHOST) return null;
  try {
    const rows = db().prepare(
      `SELECT grade, price, week, points, fetched_at, observed_at FROM market_listings WHERE source = ? AND model_id = ? AND variant = ? AND fetched_at IS NOT NULL`
    ).all(PRICEIQ_SOURCE, modelId, variant) as CacheRow[];
    if (!rows.length) return null;
    const fetchedAt = rows.map((r) => r.fetched_at).sort().pop()!;
    const listed = rows.filter((r) => r.fetched_at === fetchedAt && r.grade !== "");
    return {
      rows: listed.map((r) => ({ grade: r.grade, price: Number(r.price), week: r.week, ...(r.points ? { points: Number(r.points) } : {}) })),
      week: listed[0]?.week || null,
      observedAt: listed[0]?.observed_at ?? null,
      fetchedAt,
      unreachable: false,
    };
  } catch {
    return null;
  }
}

export function readCache(modelId: string, variant: string): MarketAnswer | null {
  return readCacheSync(modelId, variant);
}

export function writeCacheSync(ask: MarketAsk, f: Exclude<Fetched, { kind: "failed" }>, fetchedAt = nowIso()): void {
  if (process.env.DATABASE_URL || process.env.PGHOST) return;
  try {
    const sqlite = db();
    const listedAs = `${ask.brand} ${priceiqModelName(ask.brand, ask.model)} ${ask.variant}`;
    sqlite.prepare(`DELETE FROM market_listings WHERE source = ? AND model_id = ? AND variant = ?`).run(PRICEIQ_SOURCE, ask.modelId, ask.variant);
    if (f.kind === "none") {
      sqlite.prepare(
        `INSERT INTO market_listings (source, model_id, variant, grade, price, week, listed_as, fetched_at, observed_at, points) VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(PRICEIQ_SOURCE, ask.modelId, ask.variant, "", 0, "", listedAs, fetchedAt, null, null);
    } else {
      const ins = sqlite.prepare(
        `INSERT INTO market_listings (source, model_id, variant, grade, price, week, listed_as, fetched_at, observed_at, points) VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      for (const r of f.rows) {
        ins.run(PRICEIQ_SOURCE, ask.modelId, ask.variant, r.grade, r.price, r.week, listedAs, fetchedAt, f.observedAt, r.points ?? null);
      }
    }
  } catch {}
}

export async function writeCache(ask: MarketAsk, f: Exclude<Fetched, { kind: "failed" }>, fetchedAt = nowIso()): Promise<void> {
  writeCacheSync(ask, f, fetchedAt);
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return;
  const listedAs = `${ask.brand} ${priceiqModelName(ask.brand, ask.model)} ${ask.variant}`;
  await tx(async () => {
    await execute(`DELETE FROM market_listings WHERE source = $1 AND model_id = $2 AND variant = $3`, [PRICEIQ_SOURCE, ask.modelId, ask.variant]);
    if (f.kind === "none") {
      await execute(
        `INSERT INTO market_listings (source, model_id, variant, grade, price, week, listed_as, fetched_at, observed_at, points) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [PRICEIQ_SOURCE, ask.modelId, ask.variant, "", 0, "", listedAs, fetchedAt, null, null]
      );
    } else {
      for (const r of f.rows) {
        await execute(
          `INSERT INTO market_listings (source, model_id, variant, grade, price, week, listed_as, fetched_at, observed_at, points) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [PRICEIQ_SOURCE, ask.modelId, ask.variant, r.grade, r.price, r.week, listedAs, fetchedAt, f.observedAt, r.points ?? null]
        );
      }
    }
  });
}

type G = typeof globalThis & {
  __swapup_priceiq?: { inflight: Map<string, Promise<void>>; failed: Map<string, { at: number; why: string }> };
};
const g = globalThis as G;
const state = (g.__swapup_priceiq ??= { inflight: new Map(), failed: new Map() });
const keyOf = (a: Pick<MarketAsk, "modelId" | "variant">) => `${a.modelId}|${a.variant}`;

export function resetPriceiqState(): void {
  state.inflight.clear();
  state.failed.clear();
}

function refresh(cfg: Extract<PriceiqConfig, { ok: true }>, ask: MarketAsk, gb: number): Promise<void> {
  const key = keyOf(ask);
  const running = state.inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const f = await askPriceiq(cfg, { brand: ask.brand, model: priceiqModelName(ask.brand, ask.model), storageGb: gb });
    if (f.kind === "failed") {
      state.failed.set(key, { at: Date.now(), why: f.why });
      console.warn(`[swapup] PriceIQ: ${f.why}${f.log ? ` (${f.log})` : ""} — ${ask.brand} ${ask.model} ${ask.variant}; the last good answer stands.`);
      return;
    }
    state.failed.delete(key);
    try {
      await writeCache(ask, f);
    } catch (e) {
      console.error("[swapup] PriceIQ answer not kept:", (e as Error).message);
    }
  })().finally(() => state.inflight.delete(key));
  state.inflight.set(key, p);
  return p;
}

export type MarketRead = {
  answer: MarketAnswer | null;
  why: string | null;
};

export function currentSync(ask: MarketAsk): MarketRead {
  const cached = readCacheSync(ask.modelId, ask.variant);
  const failed = state.failed.get(keyOf(ask));
  if (!cached) return { answer: null, why: failed ? `${NO_MARKET_YET.replace(/\.$/, "")} — ${failed.why}.` : NO_MARKET_YET };
  const unreachable = !!failed && failed.at > Date.parse(cached.fetchedAt);
  return { answer: { ...cached, unreachable }, why: null };
}

async function current(ask: MarketAsk): Promise<MarketRead> {
  return currentSync(ask);
}

type Plan = { read: MarketRead } | { cfg: Extract<PriceiqConfig, { ok: true }>; gb: number; due: boolean };

function planSync(ask: MarketAsk): Plan {
  const cfg = priceiqConfig();
  if (!cfg.ok) return { read: { answer: null, why: cfg.why } };
  const gb = storageGb(ask.variant);
  if (gb === null) return { read: { answer: null, why: NO_MARKET_YET } };
  const cached = readCacheSync(ask.modelId, ask.variant);
  const age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
  const failed = state.failed.get(keyOf(ask));
  const backingOff = !!failed && Date.now() - failed.at < PRICEIQ_RETRY_AFTER_FAILURE_MS;
  return { cfg, gb, due: !(age < PRICEIQ_FRESH_MS) && !backingOff };
}

export async function freshMarket(ask: MarketAsk): Promise<MarketRead> {
  const p = planSync(ask);
  if ("read" in p) return p.read;
  if (p.due) await refresh(p.cfg, ask, p.gb);
  return current(ask);
}

export function cachedMarket(ask: MarketAsk): MarketRead {
  const p = planSync(ask);
  if ("read" in p) return p.read;
  if (p.due) void refresh(p.cfg, ask, p.gb).catch(() => {});
  return currentSync(ask);
}
