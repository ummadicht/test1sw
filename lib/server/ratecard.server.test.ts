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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("scripts/activate-rate-card.ts: the page's upload from the shell — active at once, SwapUp's % per defect with nothing off for accessories or age, only counts and the id; a label already used is refused; a database that isn't there is refused, never made", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const script = fileURLToPath(new URL("../../scripts/activate-rate-card.ts", import.meta.url));
  const file = join(dir, "script.db");
  const csv = `${HEADER}\ngalaxy-s23-ultra,256GB,34960,33574,32255,30672\ngalaxy-s23-ultra,512GB,38000,,,\ngalaxy-s23,128GB,20000,19000,,\n`;
  const run = (label: string, input = csv) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, "--label", label], { input, encoding: "utf8", env: { ...process.env, SWAPUP_DB: file } });
  // No file at that path (a wrong SWAPUP_DB, or the wrong folder): refused, and no database is made.
  const missing = run("W42 by grade");
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), `No database at ${file} — nothing uploaded.`);
  assert.equal(missing.stdout, "");
  assert.equal(existsSync(file), false);
  // The app's database is there (the server made it); an empty file stands in, and the script's boot runs over it as the server's would.
  writeFileSync(file, "");
  const out = run("W42 by grade");
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stderr.split("\n").includes(`Database: ${file}`), "the file used is named on stderr");
  const [counts, id, ...rest] = out.stdout.trim().split("\n");
  assert.equal(counts, "3 rows, 2 models — active.");
  assert.match(id, /^rc_[\w-]+$/);
  assert.deepEqual(rest, [], "nothing else on stdout");
  assert.doesNotMatch(out.stdout, /34960|34,960|33574/, "never a price");
  // Through the server's own module, on the database the script wrote.
  const Database = (await import("better-sqlite3")).default;
  const other = new Database(file, { readonly: true });
  try {
    const rows = other.prepare(`SELECT id, active, data FROM rate_cards`).all() as { id: string; active: number; data: string }[];
    assert.deepEqual(rows.map((x) => [x.id, x.active]), [[id, 1]]);
    const card = JSON.parse(rows[0].data);
    assert.equal(card.source.label, "W42 by grade");
    assert.deepEqual(card.deductions, { ...DEFECT_DEDUCTIONS, noChargerBp: 0, noBoxBp: 0, noBillBp: 0, age: { lt3m: 0, "3to11m": 0, gt11m: 0 } });
    assert.equal(card.entries.length, 3);
    // The same label again: refused, nothing written.
    const again = run("W42 by grade");
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists — nothing uploaded/);
    assert.equal(again.stdout, "");
    assert.equal((other.prepare(`SELECT COUNT(*) n FROM rate_cards`).get() as { n: number }).n, 1);
    // A sheet the page would refuse is refused the same way.
    const bad = run("W43", "galaxy-s23-ultra,999GB,1\n");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /"999GB" is not a variant of galaxy-s23-ultra/);
  } finally {
    other.close();
  }
});
