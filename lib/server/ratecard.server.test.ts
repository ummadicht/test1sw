/**
 * The per-grade rate card through the REAL upload and template services on a throwaway database
 * (owner, 2026-10-19: "rate card now, PriceIQ later"): the 6-column sheet, its monotonic check with
 * the row number, the old 3-column sheet unchanged, and the template's round trip.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/*.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "swapup-ratecard-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_") || k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_")) delete process.env[k];
const origLog = console.log;
console.log = () => {};
after(() => {
  console.log = origLog;
  rmSync(dir, { recursive: true, force: true });
});

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const { uploadRateCard } = await import("./catalog.ts");
const { activeRateCard } = await import("./buyback.ts");
const { rateCardTemplateCsv } = await import("./ratecard-extra.ts");
const { DEFECT_DEDUCTIONS } = await import("../domain/ratecard.ts");

type U = import("./auth.ts").SessionUser;
const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE username = 'partner'`).get() as { id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null };
const partner: U = { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
const upload = (csv: string, label = "Week 42") => uploadRateCard(partner, { label, effectiveFrom: "2026-10-12", quoteValidityDays: 3, csv, deductions: DEFECT_DEDUCTIONS, activate: true });

const HEADER = "model_id,variant,max_price,good_price,fair_price,best_value_price";

test("upload: the 6-column sheet keeps each row's grade prices; a blank grade column is simply not listed", () => {
  upload(`${HEADER}\ngalaxy-s23-ultra,256GB,34960,33574,32255,30672\ngalaxy-s23,128GB,20000,19000,,\ngalaxy-s22,128GB,12000,,,\n`);
  const card = activeRateCard(partner.orgId)!;
  assert.deepEqual(card.entries, [
    { modelId: "galaxy-s23-ultra", variant: "256GB", maxPrice: 34_960, gradePrices: { Good: 33_574, Fair: 32_255, "Best Value": 30_672 } },
    { modelId: "galaxy-s23", variant: "128GB", maxPrice: 20_000, gradePrices: { Good: 19_000 } },
    { modelId: "galaxy-s22", variant: "128GB", maxPrice: 12_000 },
  ]);
});

test("upload: a row whose price rises as the grade falls is refused, with its line number — nothing is saved", () => {
  const before = activeRateCard(partner.orgId)!.id;
  assert.throws(
    () => upload(`${HEADER}\ngalaxy-s23-ultra,256GB,34960,33574,32255,30672\ngalaxy-s23,128GB,20000,21000,,\n`, "Bad week"),
    (e: Error) => /Line 3: the Good price \(21000\) is above the Superb price \(20000\)/.test(e.message)
  );
  assert.throws(() => upload(`${HEADER}\ngalaxy-s23,128GB,20000,,0,\n`, "Bad week"), (e: Error) => /Line 2: the Fair price must be a whole rupee amount/.test(e.message));
  assert.throws(() => upload(`${HEADER}\ngalaxy-s23,128GB,20000,18000,,19000\n`, "Bad week"), (e: Error) => /Line 2: the Best Value price \(19000\) is above the Good price/.test(e.message));
  assert.equal(activeRateCard(partner.orgId)!.id, before);
});

test("upload: an old 3-column sheet still uploads, exactly as before — no grade prices", () => {
  upload("model_id,variant,max_price\ngalaxy-s24,256GB,40000\n", "Old sheet");
  assert.deepEqual(activeRateCard(partner.orgId)!.entries, [{ modelId: "galaxy-s24", variant: "256GB", maxPrice: 40_000 }]);
});

test("template: the 6-column header, pre-filled from the active card's grade prices — and it uploads back as the same card", () => {
  upload(`${HEADER}\ngalaxy-s23-ultra,256GB,34960,33574,32255,30672\ngalaxy-s23,128GB,20000,19000,,\n`);
  const t = rateCardTemplateCsv(partner.orgId);
  const lines = t.csv.trim().split(/\r\n/);
  assert.equal(lines[0], HEADER);
  assert.ok(lines.includes("galaxy-s23-ultra,256GB,34960,33574,32255,30672"));
  assert.ok(lines.includes("galaxy-s23,128GB,20000,19000,,"));
  assert.ok(lines.includes("galaxy-s23-ultra,512GB,,,,"), "a row the card doesn't price stays blank");
  assert.equal(t.prefilled, 2);
  const sorted = (es: { modelId: string; variant: string }[]) => [...es].sort((a, b) => `${a.modelId}|${a.variant}`.localeCompare(`${b.modelId}|${b.variant}`));
  const before = sorted(activeRateCard(partner.orgId)!.entries);
  // The partner fills nothing more: only the priced rows go back up (the upload screen drops blank ones).
  upload(lines.filter((l, i) => i === 0 || !/^[^,]+,[^,]+,,/.test(l)).join("\n"), "Round trip");
  assert.deepEqual(sorted(activeRateCard(partner.orgId)!.entries), before);
});
