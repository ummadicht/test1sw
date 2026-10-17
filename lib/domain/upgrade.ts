/**
 * THE NEW PHONE SWAPUP SUGGESTS — so the answer has a bonus and a "customer
 * pays" the moment the test is applied, without the advisor picking one.
 *
 * The rule is the plain one a service-centre advisor would follow: the newest
 * phone in the SAME LINE as the old one (an S23 Ultra → the newest S Ultra), at
 * the same storage. Only when the catalogue has nothing in that line does it
 * widen — same family, then the nearest tier (A/M/F), then the series.
 *
 * THE INTEGRITY RULE. It never reads the bonus, the store's margin or any
 * campaign. "Newest in the same line" is usually the dearest phone in that
 * line, which makes repair ÷ new price SMALLER — so the suggestion can never
 * inflate decide()'s "upgrade" signal. Staff can always change it; once they
 * do, their choice stands.
 *
 * Pure functions only — no database, no clock.
 */

/** Bumped whenever the rule changes; stored on every suggested upgrade for audit. */
export const UPGRADE_RULE_VERSION = "2026-10-17.1";

/**
 * Where a Samsung model sits in the line-up. "Galaxy A54 5G" → A, tier "5",
 * gen 4. "Galaxy S23 Ultra" → S, gen 23, suffix "Ultra". "Galaxy Z Flip7 FE"
 * → Z, Flip, gen 7, suffix "FE".
 */
export type Line = { series: string; family: "" | "Flip" | "Fold"; tier: string; gen: number; suffix: string };

/**
 * The model's line, or null when it is not a Samsung model SwapUp can place
 * (an iPhone, a Pixel) or its letter is not the series it is filed under.
 */
export function parseLine(model: string, series: string | null): Line | null {
  if (!series) return null;
  const s = model
    .replace(/^\s*Galaxy\s+/i, "")
    .replace(/\b20\d\d\s+Edition\b/gi, " ")
    .replace(/\b(?:5G|LTE|4G)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const z = /^Z\s*(Flip|Fold)\s*(\d+)\s*(.*)$/i.exec(s);
  if (z) {
    if (series !== "Z") return null;
    return { series: "Z", family: z[1].toLowerCase() === "flip" ? "Flip" : "Fold", tier: "", gen: Number(z[2]), suffix: z[3].trim() };
  }
  const m = /^([SAMF])(\d{1,2})([a-z]*)(\+?)\s*(.*)$/.exec(s);
  if (!m || m[1] !== series) return null;
  const suffix = [m[3], m[4], m[5].trim()].filter(Boolean).join(" ");
  if (m[1] === "S") return { series: "S", family: "", tier: "", gen: Number(m[2]), suffix };
  const n = m[2].padStart(2, "0");
  return { series: m[1], family: "", tier: n[0], gen: Number(n[1]), suffix };
}

/** The storage in a variant: "8GB+256GB" → "256GB", "1TB" → "1TB", anything else → null. */
export function storageOf(variant: string): string | null {
  const last = variant.split("+").pop()!.trim();
  const m = /^(\d+)\s*(GB|TB)$/i.exec(last);
  return m ? `${Number(m[1])}${m[2].toUpperCase()}` : null;
}

/** "256GB" → 256, "1TB" → 1024 — for ordering sizes only. */
function sizeGb(variant: string | null): number | null {
  const s = variant ? storageOf(variant) : null;
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return s.endsWith("TB") ? n * 1024 : n;
}

/** A row of the store's new-phone catalogue, as newDevices() returns it. */
export type CatalogueRow = { id: string; brand: string; model: string; series: string; variant: string; price: number; supportEndYear: number | null };

export type UpgradeSuggestion = { deviceId: string; level: "line" | "family" | "nearby" | "series"; why: string };

/** "Galaxy S Ultra", "Galaxy S+", "Galaxy Z Flip FE", "Galaxy A5x", "Galaxy M5xs", "Galaxy F7x Pro". */
function lineName(l: Line): string {
  if (l.series === "S") return `Galaxy S${l.suffix === "+" ? "+" : l.suffix ? ` ${l.suffix}` : ""}`;
  if (l.series === "Z") return `Galaxy Z ${l.family}${l.suffix ? ` ${l.suffix}` : ""}`;
  const glued = /^[a-z]+\b/.exec(l.suffix)?.[0] ?? "";
  const rest = l.suffix.slice(glued.length).trim();
  return `Galaxy ${l.series}${l.tier}x${glued}${rest ? ` ${rest}` : ""}`;
}

/**
 * The new phone to suggest for the old one, from the store's active catalogue
 * (in newDevices() order). null when the catalogue has nothing of the old
 * phone's brand that SwapUp can place, or the old phone can't be placed — the
 * advisor chooses then, never a guess across brands.
 *
 * The first level with any candidate wins:
 *   line    same series, family, tier and suffix (S23 Ultra → S Ultra)
 *   family  same series, family and tier, any suffix (S25 Edge → S)
 *   nearby  A/M/F only: the nearest tier in the same series (a tie → the higher)
 *   series  same series
 * Then, in order: newest (support end year, then generation); a plain model
 * before an FE/Ultra/+; the old storage, else the next size up, else the
 * largest size down (skipped when the old storage is unknown); cheapest;
 * catalogue order.
 */
export function suggestUpgrade(
  old: { brand: string; model: string; series: string | null; variant: string | null },
  catalogue: CatalogueRow[]
): UpgradeSuggestion | null {
  const ol = parseLine(old.model, old.series);
  if (!ol) return null;
  const brand = old.brand.trim().toLowerCase();
  const pool = catalogue.flatMap((row, i) => {
    if (row.brand.trim().toLowerCase() !== brand) return [];
    const line = parseLine(row.model, row.series);
    return line ? [{ row, line, i }] : [];
  });
  if (!pool.length) return null;
  type Cand = (typeof pool)[number];

  let level: UpgradeSuggestion["level"] = "line";
  let cands: Cand[] = pool.filter((c) => c.line.series === ol.series && c.line.family === ol.family && c.line.tier === ol.tier && c.line.suffix === ol.suffix);
  if (!cands.length) {
    level = "family";
    cands = pool.filter((c) => c.line.series === ol.series && c.line.family === ol.family && c.line.tier === ol.tier);
  }
  if (!cands.length && ol.tier !== "") {
    level = "nearby";
    const near = pool.filter((c) => c.line.series === ol.series && c.line.family === ol.family && c.line.tier !== "");
    if (near.length) {
      const gap = (c: Cand) => Math.abs(Number(c.line.tier) - Number(ol.tier));
      const best = Math.min(...near.map(gap));
      const tier = Math.max(...near.filter((c) => gap(c) === best).map((c) => Number(c.line.tier)));
      cands = near.filter((c) => Number(c.line.tier) === tier);
    }
  }
  if (!cands.length) {
    level = "series";
    cands = pool.filter((c) => c.line.series === ol.series);
  }
  if (!cands.length) return null;

  const oldGb = sizeGb(old.variant);
  // 0 = the old storage, 1 = larger (smallest first), 2 = smaller (largest first), 3 = unreadable.
  const storageRank = (c: Cand): [number, number] => {
    if (oldGb === null) return [0, 0];
    const g = sizeGb(c.row.variant);
    if (g === null) return [3, 0];
    if (g === oldGb) return [0, 0];
    return g > oldGb ? [1, g] : [2, -g];
  };
  const year = (c: Cand) => c.row.supportEndYear ?? Number.NEGATIVE_INFINITY;
  const ranked = [...cands].sort((a, b) => {
    const [sa, sb] = [storageRank(a), storageRank(b)];
    return (
      year(b) - year(a) ||
      b.line.gen - a.line.gen ||
      (a.line.suffix === "" ? 0 : 1) - (b.line.suffix === "" ? 0 : 1) ||
      sa[0] - sb[0] ||
      sa[1] - sb[1] ||
      a.row.price - b.row.price ||
      a.i - b.i
    );
  });
  const pick = ranked[0];

  const size = storageOf(pick.row.variant);
  const [rank] = storageRank(pick);
  const storage = !size
    ? ""
    : oldGb === null
      ? `, at its lowest-priced size (${size}) until the storage is known`
      : rank === 0
        ? `, same storage (${size})`
        : rank === 1
          ? `, next storage up (${size})`
          : `, the largest size it comes in (${size})`;
  const why =
    level === "line"
      ? `Newest ${lineName(pick.line)}${storage}.`
      : level === "series"
        ? `Nothing near the ${old.model} in the catalogue — the newest Galaxy ${ol.series}${storage}.`
        : `No ${lineName(ol)} in the catalogue — the ${level === "nearby" ? "nearest is the " : ""}newest ${lineName(pick.line)}${storage}.`;
  return { deviceId: pick.row.id, level, why };
}
