/**
 * ACTIVATE A RATE CARD from the server's shell — the same upload the Rate cards page makes
 * (lib/server/catalog.ts uploadRateCard), for the programme's one buyback partner, active at once:
 *
 *   node --experimental-strip-types scripts/activate-rate-card.ts --label "W42 by grade" < card.csv
 *
 * The database is SWAPUP_DB, else the app's own data/swapup.db next to this folder — never one in the
 * shell's folder, so it can run from anywhere. A database file that isn't there is refused (opening
 * it would make and seed a new one, and the card would go live there), and the file used is named on
 * stderr. It is opened through the server's db module and booted through its seed, so migrations and
 * boot passes run exactly as the server runs them. The CSV is the page's:
 * model_id,variant,max_price,good_price,fair_price,best_value_price (header optional).
 *
 * Deductions: SwapUp's % per defect (DEFECT_DEDUCTIONS), with nothing taken off for a missing
 * charger, box or bill, or for the phone's age. Quotes stay valid as long as the active card's do
 * (3 days with none). Prints only counts and the new card's id — never a price. Refuses a label a
 * card already has, and changes nothing then.
 */
// The module hooks the server's tests load lib/server with (extensionless imports, "@/…", next stubs).
import "../lib/server/testing/register.mjs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const at = process.argv.indexOf("--label");
const label = (at > 0 ? (process.argv[at + 1] ?? "") : "").trim();
if (!label) fail('Name the card: --label "W42 by grade".');
if (process.stdin.isTTY) fail("Send the CSV on stdin: … < card.csv");
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const csv = Buffer.concat(chunks).toString("utf8");
if (!csv.trim()) fail("The CSV is empty.");

// The server's db module reads SWAPUP_DB when it loads (else the shell's folder), so set it first.
const dbFile = process.env.SWAPUP_DB || fileURLToPath(new URL("../data/swapup.db", import.meta.url));
if (!existsSync(dbFile)) fail(`No database at ${dbFile} — nothing uploaded.`);
process.env.SWAPUP_DB = dbFile;
console.error(`Database: ${dbFile}`);

// The server's own boot. Its notes go to stderr, so stdout carries only the counts and the id.
const log = console.log;
console.log = (...a: unknown[]) => console.error(...a);
const { ensureSeeded } = await import("../lib/server/seed.ts");
await ensureSeeded();
console.log = log;

const { db, todayIso } = await import("../lib/server/db.ts");
const { rateCards, rateCardDetail, uploadRateCard } = await import("../lib/server/catalog.ts");
const { DEFECT_DEDUCTIONS } = await import("../lib/domain/ratecard.ts");
const { PRICEIQ_QUOTE_VALIDITY_DAYS } = await import("../lib/server/tradeIn.ts");

const partners = db().prepare(`SELECT id FROM orgs WHERE kind = 'partner'`).all() as { id: string }[];
if (partners.length !== 1) fail(`Expected one buyback partner, found ${partners.length} — nothing uploaded.`);
const partnerId = partners[0].id;
const login = db().prepare(`SELECT id, username, name FROM users WHERE org_id = ? AND role = 'partner' ORDER BY created_at, id LIMIT 1`).get(partnerId) as
  | { id: string; username: string; name: string }
  | undefined;
if (!login) fail("The buyback partner has no login to upload as — nothing uploaded.");
const before = rateCards(partnerId);
if (before.some((c) => c.label === label)) fail(`A rate card named "${label}" already exists — nothing uploaded.`);

const age = Object.fromEntries(Object.keys(DEFECT_DEDUCTIONS.age).map((k) => [k, 0])) as typeof DEFECT_DEDUCTIONS.age;
const deductions = { ...DEFECT_DEDUCTIONS, noChargerBp: 0, noBoxBp: 0, noBillBp: 0, age };

try {
  const cards = uploadRateCard(
    { id: login.id, username: login.username, name: login.name, role: "partner", orgId: partnerId, storeId: null, exp: 0 },
    {
      label,
      effectiveFrom: todayIso(),
      quoteValidityDays: before.find((c) => c.active)?.quoteValidityDays ?? PRICEIQ_QUOTE_VALIDITY_DAYS,
      csv,
      deductions,
      activate: true,
    }
  );
  const card = cards.find((c) => c.label === label && c.active);
  if (!card) fail("The card was saved but is not active — check the Rate cards page.");
  const models = new Set(rateCardDetail(partnerId, card.id).entries.map((e) => e.modelId)).size;
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  console.log(`${n(card.entries, "row")}, ${n(models, "model")} — active.`);
  console.log(card.id);
} catch (e) {
  fail((e as Error).message);
}
