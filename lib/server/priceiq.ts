/**
 * PRICEIQ — the live refurbished-market price by grade, asked server to server.
 *
 * Contract v1 (2026-10-18), §1–3:
 *
 *   GET {PRICEIQ_BASE_URL}/api/market-grades?brand=Samsung&model=Galaxy S23 Ultra&storageGb=256&market=IN
 *   Authorization: Bearer {PRICEIQ_API_KEY}           6-second timeout
 *
 *   200  {week, observedAt, ageDays, stale, currency:"INR", grades:[{grade, lowMinor, medianMinor, highMinor, points}]}
 *   404  {error, reason:"no-device"|"no-price"}      409 {candidates}      401 a missing or bad key
 *
 *   Only PriceIQ's OWN 404 / 409 — JSON with that reason, or with a candidates list — means "PriceIQ
 *   has no price for this phone". Any other 404 (an HTML page, JSON with no reason: a wrong base path,
 *   or a PriceIQ rolled back to a build without this route) is a FAILURE like a 503: the last good
 *   answer stands, labelled unreachable, and the cache is never overwritten by it.
 *
 * Rules this file keeps:
 *   • The key is read from the server's env only (/etc/swapup.env), never a NEXT_PUBLIC_ variable,
 *     never sent anywhere but PriceIQ, never logged — at most its last 4 characters, and those only
 *     in the server log: never in a `why` (it reaches quotes, the counter and the customer's answer).
 *     It travels only to 127.0.0.1 / localhost or over https; a plain-http remote address is refused.
 *   • No key or no address → no price ("No refurbished market price yet"), never a guess.
 *   • One answer per model + storage, kept in market_listings (one row per grade, its LOWEST listing,
 *     with fetched_at), so it survives a restart. Fresh for 1 hour; then the next request refreshes
 *     it. A quote waits for the refresh (6 s at most: freshMarket); a page view reads the cache and
 *     refreshes in the background (cachedMarket). PriceIQ's own 404 / 409 ("no price") is cached for
 *     an hour too.
 *   • PriceIQ down, slow or refusing: the last good answer, marked `unreachable` so every screen says
 *     "PriceIQ unreachable, last answer …" — and so is a 404 that isn't PriceIQ's own (see above). After
 *     a failure the next ask waits a minute, so a counter is never held 6 seconds per storage chip
 *     while PriceIQ is down.
 *   • Only what SwapUp prices from is kept: the grade's name, its lowest listing in rupees, how many
 *     distinct prices, the week and when it was observed. No source id, no partner name, nothing else
 *     PriceIQ might add.
 *   • Never a neighbouring model or storage: PriceIQ matches the model exactly; SwapUp only strips
 *     the brand and a "(code)" from the name (marketSell.ts priceiqModelName).
 */
import { db, nowIso } from "./db";
import { isMarketGrade, priceiqModelName, storageGb, NO_MARKET_YET, type ListingRow, type MarketAnswer } from "../domain/marketSell";

export const PRICEIQ_TIMEOUT_MS = 6_000;
/** An answer is fresh for this long; after it, the next request asks again. */
export const PRICEIQ_FRESH_MS = 60 * 60_000;
/** After a failed ask, the next one for the same phone waits this long (the last good answer stands meanwhile). */
export const PRICEIQ_RETRY_AFTER_FAILURE_MS = 60_000;
/** market_listings.source for PriceIQ's answers. */
export const PRICEIQ_SOURCE = "priceiq";

export const NOT_CONNECTED = `${NO_MARKET_YET.replace(/\.$/, "")} — PriceIQ isn't connected.`;

export type PriceiqConfig = { ok: true; base: string; key: string } | { ok: false; why: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The PriceIQ address and key from the server's env, or why PriceIQ can't be asked. */
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

/** A key as it may appear in a log line: its last 4 characters. */
export function maskKey(key: string): string {
  return key.length > 8 ? `…${key.slice(-4)}` : "…";
}

/** What SwapUp asks PriceIQ about: one catalogue model at one storage size. */
export type MarketAsk = { modelId: string; variant: string; brand: string; model: string };

/** What came back from one ask. */
export type Fetched =
  | { kind: "answer"; rows: ListingRow[]; week: string; observedAt: string | null }
  | { kind: "none" }
  /** `why` reaches quotes and screens — plain words, never a key character. `log` is for the server log only. */
  | { kind: "failed"; why: string; log?: string };

/** PriceIQ's own "no price for this phone": a 404 with reason no-device / no-price, or a 409 with candidates. */
export function isPriceiqNone(status: number, body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (status === 404) return b.reason === "no-device" || b.reason === "no-price";
  if (status === 409) return Array.isArray(b.candidates);
  return false;
}

/** A small body read as JSON, or null (an HTML page, an empty or oversized body). */
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

/** PriceIQ's 200 body → the rows SwapUp keeps, or null when it isn't an India refurbished-price answer. */
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
    // Minor units (paise) → whole rupees, rounded DOWN: never a rupee more than the market asks.
    rows.push({ grade: x.grade, price: Math.floor(low / 100), week, ...(Number.isInteger(points) && points > 0 ? { points } : {}) });
  }
  return { rows, week, observedAt: observed };
}

/** One GET to PriceIQ. Never throws: a failure is an answer. The key goes in the header only. */
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
      // Not PriceIQ's own answer: the route isn't there (a wrong base path, an older PriceIQ). A failure,
      // never "no price" — the last good answer must not be overwritten by it.
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

/* ─────────────────────────── the cache (market_listings) ─────────────────────────── */

type CacheRow = { grade: string; price: number; week: string; points: number | null; fetched_at: string; observed_at: string | null };

/** The stored answer for one model + storage, or null when PriceIQ was never asked about it. */
export function readCache(modelId: string, variant: string): MarketAnswer | null {
  const rows = db()
    .prepare(`SELECT grade, price, week, points, fetched_at, observed_at FROM market_listings WHERE source = ? AND model_id = ? AND variant = ? AND fetched_at IS NOT NULL`)
    .all(PRICEIQ_SOURCE, modelId, variant) as CacheRow[];
  if (!rows.length) return null;
  const fetchedAt = rows.map((r) => r.fetched_at).sort().pop()!;
  const listed = rows.filter((r) => r.fetched_at === fetchedAt && r.grade !== "");
  return {
    rows: listed.map((r) => ({ grade: r.grade, price: r.price, week: r.week, ...(r.points ? { points: r.points } : {}) })),
    week: listed[0]?.week || null,
    observedAt: listed[0]?.observed_at ?? null,
    fetchedAt,
    unreachable: false,
  };
}

/** Keep one ask's answer: the grades' lowest listings, or one marker row (grade '') for "PriceIQ has none". */
export function writeCache(ask: MarketAsk, f: Exclude<Fetched, { kind: "failed" }>, fetchedAt = nowIso()): void {
  const listedAs = `${ask.brand} ${priceiqModelName(ask.brand, ask.model)} ${ask.variant}`;
  const d = db();
  d.transaction(() => {
    d.prepare(`DELETE FROM market_listings WHERE source = ? AND model_id = ? AND variant = ?`).run(PRICEIQ_SOURCE, ask.modelId, ask.variant);
    const ins = d.prepare(
      `INSERT INTO market_listings (source, model_id, variant, grade, price, week, listed_as, fetched_at, observed_at, points) VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    if (f.kind === "none") ins.run(PRICEIQ_SOURCE, ask.modelId, ask.variant, "", 0, "", listedAs, fetchedAt, null, null);
    else for (const r of f.rows) ins.run(PRICEIQ_SOURCE, ask.modelId, ask.variant, r.grade, r.price, r.week, listedAs, fetchedAt, f.observedAt, r.points ?? null);
  })();
}

/* ─────────────────────────── refresh: fresh for an hour, one ask at a time ─────────────────────────── */

type G = typeof globalThis & {
  __swapup_priceiq?: { inflight: Map<string, Promise<void>>; failed: Map<string, { at: number; why: string }> };
};
const g = globalThis as G;
const state = (g.__swapup_priceiq ??= { inflight: new Map(), failed: new Map() });
const keyOf = (a: Pick<MarketAsk, "modelId" | "variant">) => `${a.modelId}|${a.variant}`;

/** Forget in-flight asks and recent failures (tests). */
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
      writeCache(ask, f);
    } catch (e) {
      console.error("[swapup] PriceIQ answer not kept:", (e as Error).message);
    }
  })().finally(() => state.inflight.delete(key));
  state.inflight.set(key, p);
  return p;
}

export type MarketRead = {
  /** PriceIQ's answer as SwapUp may use it now; null = none at all. */
  answer: MarketAnswer | null;
  /** With no answer: why (PriceIQ not connected, never answered). null when there is an answer. */
  why: string | null;
};

function current(ask: MarketAsk): MarketRead {
  const cached = readCache(ask.modelId, ask.variant);
  const failed = state.failed.get(keyOf(ask));
  if (!cached) return { answer: null, why: failed ? `${NO_MARKET_YET.replace(/\.$/, "")} — ${failed.why}.` : NO_MARKET_YET };
  const unreachable = !!failed && failed.at > Date.parse(cached.fetchedAt);
  return { answer: { ...cached, unreachable }, why: null };
}

type Plan = { read: MarketRead } | { cfg: Extract<PriceiqConfig, { ok: true }>; gb: number; due: boolean };

function plan(ask: MarketAsk): Plan {
  const cfg = priceiqConfig();
  if (!cfg.ok) return { read: { answer: null, why: cfg.why } };
  const gb = storageGb(ask.variant);
  if (gb === null) return { read: { answer: null, why: NO_MARKET_YET } };
  const cached = readCache(ask.modelId, ask.variant);
  const age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
  const failed = state.failed.get(keyOf(ask));
  const backingOff = !!failed && Date.now() - failed.at < PRICEIQ_RETRY_AFTER_FAILURE_MS;
  return { cfg, gb, due: !(age < PRICEIQ_FRESH_MS) && !backingOff };
}

/**
 * For a QUOTE: PriceIQ's answer, refreshed first when it is over an hour old (waiting 6 s at most).
 * PriceIQ failing → the last good answer, `unreachable`; never anything made up.
 */
export async function freshMarket(ask: MarketAsk): Promise<MarketRead> {
  const p = plan(ask);
  if ("read" in p) return p.read;
  if (p.due) await refresh(p.cfg, ask, p.gb);
  return current(ask);
}

/** For a PAGE VIEW: what is kept now; an answer over an hour old is refreshed in the background. */
export function cachedMarket(ask: MarketAsk): MarketRead {
  const p = plan(ask);
  if ("read" in p) return p.read;
  if (p.due) void refresh(p.cfg, ask, p.gb).catch(() => {});
  return current(ask);
}
