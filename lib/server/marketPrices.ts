import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { db, nowIso } from "./db";
import { marketSell, resolveModel, variantFromCapacity, type MarketSell } from "../domain/marketSell";
import type { ConditionAnswers } from "../domain/condition";

/**
 * PriceIQ's Cashify refurbished listings — the SELL side of a trade-in.
 *
 * Source: the PriceIQ daily vendor drop, leaf `cashify/sell` (source_id
 * `cashify_in_sell`, ~/projects/priceiq-vendors/cashify/sell/latest.csv): what
 * Cashify's own refurbished store asks, per model, storage and Cashify grade.
 * A copy ships at lib/server/priceiq/cashify_in_sell.csv; to refresh, copy the
 * newer latest.csv over it and deploy — the next start re-imports it (the
 * file's hash is remembered in meta, so an unchanged file is not re-read).
 * PRICEIQ_CASHIFY_SELL_CSV may point at a different copy of the same file.
 *
 * Only rows that name a SwapUp trade model and a real storage size are kept;
 * what was dropped is counted in meta 'priceiq_cashify_sell' so it is visible,
 * not silent. Prices are asks, not sales — the domain marks them down 2–5%.
 */

export const SOURCE = "priceiq:cashify_in_sell";
const META_KEY = "priceiq_cashify_sell";

export type MarketImport = { file: string; hash: string; week: string | null; rowsIn: number; kept: number; unresolved: string[]; importedAt: string };

function csvPath(): string {
  return process.env.PRICEIQ_CASHIFY_SELL_CSV || join(process.cwd(), "lib/server/priceiq/cashify_in_sell.csv");
}

let checked = false;

/** Import the bundled PriceIQ file once per process if it changed since the last import. Never throws. */
export function ensureMarketListings(): void {
  if (checked) return;
  try {
    // Names resolve against the catalogue — wait until it exists, or every row would be dropped for good.
    const n = db().prepare(`SELECT COUNT(*) n FROM trade_models`).get() as { n: number };
    if (!n.n) return;
    checked = true;
    const path = csvPath();
    const text = readFileSync(path, "utf8");
    const hash = createHash("sha256").update(text).digest("hex");
    const last = lastImport();
    if (last?.hash === hash) return;
    const r = importCashifySell(text, path, hash);
    console.log(`[swapup] PriceIQ Cashify sell: kept ${r.kept}/${r.rowsIn} rows (week ${r.week ?? "?"}), ${r.unresolved.length} names not in the catalogue`);
  } catch (e) {
    console.error("[swapup] PriceIQ Cashify sell import failed — SELL falls back to the partner's repaired price:", e);
  }
}

export function lastImport(): MarketImport | null {
  const row = db().prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as MarketImport;
  } catch {
    return null;
  }
}

/** Replace every PriceIQ Cashify listing with the rows in `text` (PriceIQ's latest.csv format). */
export function importCashifySell(text: string, file: string, hash: string): MarketImport {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = (lines.shift() ?? "").split(",").map((h) => h.trim());
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`PriceIQ file has no "${name}" column`);
    return i;
  };
  const iWeek = col("week_id"), iVendor = col("vendor"), iModel = col("model"), iCap = col("capacity_gb"), iGrade = col("grade"), iCur = col("currency"), iPrice = col("price");
  const models = db().prepare(`SELECT id, brand, model FROM trade_models`).all() as { id: string; brand: string; model: string }[];
  const resolved = new Map<string, string | null>();
  const unresolved = new Set<string>();
  const keep: { model: string; variant: string; grade: string; price: number; week: string; as: string }[] = [];
  let week: string | null = null;
  for (const line of lines) {
    const f = line.split(",");
    if (f[iCur] !== "INR") continue;
    const brand = f[iVendor].trim(), name = f[iModel].trim();
    const key = `${brand}|${name}`;
    if (!resolved.has(key)) resolved.set(key, resolveModel(brand, name, models));
    const modelId = resolved.get(key);
    const variant = variantFromCapacity(f[iCap]);
    const price = Math.round(Number(f[iPrice]));
    if (!modelId) {
      unresolved.add(`${brand} ${name}`);
      continue;
    }
    if (!variant || !Number.isFinite(price) || price <= 0) continue;
    const w = f[iWeek].trim();
    if (!week || w > week) week = w;
    keep.push({ model: modelId, variant, grade: f[iGrade].trim(), price, week: w, as: `${brand} ${name} ${f[iCap].trim()}GB` });
  }
  const summary: MarketImport = { file, hash, week, rowsIn: lines.length, kept: keep.length, unresolved: [...unresolved].sort(), importedAt: nowIso() };
  db().transaction(() => {
    db().prepare(`DELETE FROM market_listings WHERE source = ?`).run(SOURCE);
    const ins = db().prepare(`INSERT INTO market_listings (source, model_id, variant, grade, price, week, listed_as) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const k of keep) ins.run(SOURCE, k.model, k.variant, k.grade, k.price, k.week, k.as);
    db().prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(META_KEY, JSON.stringify(summary));
  })();
  return summary;
}

export type CaseMarketSell = MarketSell & { source: "PriceIQ · Cashify refurbished" };

/** The sell price for a phone on a case, from PriceIQ — or why there is none. */
export function caseMarketSell(input: { modelId: string | null; variant: string | null; model: string | null; condition: ConditionAnswers | null }): CaseMarketSell {
  const source = "PriceIQ · Cashify refurbished" as const;
  if (!input.modelId || !input.variant) return { amount: null, why: "The phone's model and storage aren't on the case yet.", source };
  ensureMarketListings();
  const rows = db()
    .prepare(`SELECT grade, price, week FROM market_listings WHERE source = ? AND model_id = ? AND variant = ?`)
    .all(SOURCE, input.modelId, input.variant) as { grade: string; price: number; week: string }[];
  return { ...marketSell({ rows, condition: input.condition, label: `${input.model ?? "phone"} ${input.variant}` }), source };
}
