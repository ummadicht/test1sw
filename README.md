# SwapUp

**Repair it, or swap up?** An in-store desk for Samsung service centres — and any client's
experience centres — that puts the repair quote and the trade-in value side by side, gives
an honest recommendation, and turns the upgrade into a new Samsung with a 2–5% bonus. Every
store's trade-in exposure is kept inside a credit limit until the buyback partner
collects or clears the phones.

## The flow

One flow, the same on the store tablet (SwapUp Store), the customer's phone (SwapUp Check)
and the desk (`/desk`, `/cases/:id`) — the fewest steps that keep the law, the money and safety
(owner, 2026-10-17: "Reduce the flow"):

1. **New trade-in** — the IMEI first: the customer dials *#06#, the advisor scans it (store app),
   reads the screen from a photo or types it (store app and desk), then the customer's mobile (a
   returning customer's name fills in); or the customer scans the store's counter QR alone. The
   case opens on what the IMEI says — the model, the GSMA blacklist, an IMEI already traded in.
2. **The customer's phone connects** — it scans the test code. Its own steps are **Scan → Test →
   Done**: nobody asks about condition. "Is this your phone?" only when the model match isn't
   exact, the storage only when the phone can't measure it, and the battery screenshot only when
   no other battery reading exists (an attached Phonecheck report) — and it can be skipped.
3. **One camera pass** — the store tablet scans the code on the customer's phone; GradeIQ's
   camera page photographs it and sweeps its screen in one go. Where the camera can't decide,
   "Check the phone" opens **inside that step**: the advisor taps the screen (while the phone
   shows the test colours), body and liquid indicator, one tap each, by name. A desk-only case
   records the phone by hand instead: model, storage, IMEI, cover, and what is wrong with it.
4. **The answer, by itself** — when the phone's tests and the camera grade are in (and the
   advisor's taps, where the camera couldn't decide), the server puts the results on the case
   with no "Apply to case" tap (`lib/domain/autoApply.ts`; Apply's own gates still decide, and a
   refusal shows its one-line reason and a Retry). One screen: the **refurb quote** (what
   repairing costs the customer) next to the **trade-in + bonus** toward a new Samsung, the
   phone's **SwapUp grade**, and the one thing still missing, if anything. Each number is shown once.
   - Refurb quote: Samsung India's published spare-part price for the part that fixes the
     fault, plus the published labour charge for the model's tier, plus GST. Faults with no
     published price (liquid, no power, charging port on most models) need the centre's own
     bench quote — the app never guesses one.
   - Trade-in, in this order: the amount and reference code read off the partner's own app;
     otherwise **PriceIQ, live** — the lowest refurbished-market listing at the phone's grade
     (the next lower grade, named, if none), less the **markdown** (5% up to ₹15,000, 4% to
     ₹30,000, 3% to ₹50,000, 2% above — the same margin as the sell price, and GradeIQ's), less
     **SwapUp's % for each defect** (e.g. "Refurbished market price ₹51,399 (Good) − 2% − 2
     defects · PriceIQ 2026-W35"). Market data over 14 days old is shown with its age; over 90
     days old is no price. Otherwise the partner's uploaded rate card; with none of them, "No
     market price yet" and the reason why. Never a made-up price and never a typed one: staff
     change the price only by changing what's wrong with the phone. Rules: `docs/GRADING.md` §6.
   - The recommendation follows the rules that fired (the 50% rule against the new phone's
     price, repair vs resale value, update support, age). The bonus (2–5% of the new price,
     clamped, optionally capped) is shown but never counted as a reason; a covered repair is
     always "repair".
5. **Repair, Walked away or Swap up** — Repair and Walked away end the visit from the answer.
   Swap up opens ONE "Take the trade-in" screen: the IMEI only if the case has none, the
   customer's name and mobile prefilled, the ID type and last 4, the government IMEI check
   (KYM), and ONE hand-over confirm — "Owner confirmed · SIM out · IMEI matches · no EMI/lock" —
   that still sends the server all four flags. The trade-in is then **locked**: value held on the
   store's credit line, receipt and device tag printed.

Afterwards the **grade report** (`/r/<token>`) says what was tested and why the phone got its
SwapUp grade, with no money in it: the customer opens it on their phone, the store shows it as a
QR, and the partner sees the version frozen at hand-over.

On the desk the case page takes the same order one step at a time — **Phone → What's wrong →
The answer** (Swap up then opens **Take the trade-in**) — with "Step 2 of 3" on top and Back /
Next at the bottom. The answer's asks and "Change" links open the **Repair quote** and the
**Trade-in** as pages of their own ("The answer › Repair quote", Back to the answer). Each step
asks one question and shows one figure; the rest is behind its "Show details". A tested case
(SwapUp Check or Phonecheck), and the store app's hand-off, open on the answer; `#step-repair`
and the like open that page.

After the counter:

- **Pickup** (`/store`, `/pickups/:id`, `/partner`) — the store books a pickup, the partner
  schedules and collects (handover named on both sides), inspects each phone (cleared /
  regraded / rejected / not received) and settles. The credit line frees up at collection
  or clearance (per client), and any shortfall comes back as a chargeback.
- **Programme** (`/admin`) — stores and credit limits, bonus campaigns, catalogue and repair
  price book, programme settings, bonus-claim export for the brand.

## Where the numbers come from

| Number | Source |
|---|---|
| Repair part prices | Samsung India "Mobile Spare Part Cost" page, read 2026-10-15 (excl. GST and labour; premium colour / max storage) — `scripts/research-samsung-spare-parts-2026-10-15.csv` |
| Labour per job | Samsung India out-of-warranty repair charges: Galaxy Z ₹525, S ₹425, others ₹350 (L2, taxes extra) |
| Care+ plan fee | Samsung Care+ smartphone terms (ADLD processing fee per repair, tax incl.) where published per model; otherwise the programme default |
| New phone prices | samsung.com/in selling prices, read 2026-10-15 — `scripts/research-samsung-lineup-2026-10-15.csv` |
| Trade-in values | PriceIQ's lowest refurbished-market listing at the grade (live, `GET /api/market-grades`) less the 5%→2% markdown and SwapUp's % per defect, else the partner's uploaded rate card, else no price ("No market price yet", with why). Never typed in |
| Post-repair value (staff "Refurb decision") | the same rate card the trade-in was read off, for the phone once its faults are repaired the card's way (`repairedOnCard`: `healedCondition`, the look the card priced kept → `priceFromCard`); none from PriceIQ — `lib/domain/refurbEconomics.ts` |
| Update support | release year + Samsung's update policy per series (approximate; check Samsung's security-update page) |

Regenerate the seed after refreshing the snapshots: `python3 scripts/build-seed-data.py`.

## PriceIQ (the refurbished market price)

`lib/server/priceiq.ts` asks PriceIQ, server to server on the VM:
`GET {PRICEIQ_BASE_URL}/api/market-grades?brand=&model=&storageGb=&market=IN` with
`Authorization: Bearer {PRICEIQ_API_KEY}` and a 6-second timeout. Both go in `/etc/swapup.env`
(`PRICEIQ_BASE_URL=http://127.0.0.1:4301/apps/priceiq`, a read-only key); never `NEXT_PUBLIC_`,
never logged (at most its last 4 characters), sent only to 127.0.0.1 or over https. No key → no
price, never a guess.

Each answer (one row per grade: its lowest listing) is kept in `market_listings` with
`fetched_at`, fresh for an hour. A quote waits for the refresh (6 s at most); a page view reads
what is kept and refreshes it in the background. A 404 is kept for an hour too. PriceIQ down or
slow → the last good answer, labelled "PriceIQ unreachable, last answer …". There is no bundled
price file: `deploy/deploy.sh` checks PriceIQ answers 200 for a known phone before it ships.

## Connecting the buyback partner

The buyback partner publishes no partner API. Besides PriceIQ, stores use:

- **Rate card** — the partner's operations team uploads its sheet (`model_id,variant,max_price`,
  optional grade columns) on `/partner/rate-cards`; SwapUp applies the card's condition
  deductions. It prices what PriceIQ can't. From the server's shell, the same upload:
  `node --experimental-strip-types scripts/activate-rate-card.ts --label "W42 by grade" < card.csv`.

No price is ever typed in at the counter (0.9.1): the trade-in is the system's, and what's
wrong with the phone is the only thing that changes it.

Screens never name the partner company: they say "the partner" or the partner org's own
name. The test programmes' partner is **Buyback Partner (demo)** (login `partner`); a
database seeded under the partner's former name is renamed once on start (`renameDemoPartner`,
`lib/server/seed.ts`), and its seeded example cases are removed once (`removeExampleCases`).
Test programmes carry the banner "Test programme — no real money".

## Run

```bash
npm install
npm run dev        # http://localhost:4500 — seeds the test programmes on first request (no cases, no prices)
npm test           # domain, desk and server tests (node type-stripping, no build)
npx tsc --noEmit
```

Demo accounts (password `swapup2026`, override with `SWAPUP_DEMO_PASSWORD` before first
boot): `advisor`, `manager`, `samsung` (programme admin), `partner` (buyback partner), `platform`;
`advisor.kor` / `manager.kor`; `xc.admin` / `xc.manager` / `xc.advisor`.

## Build

The server is built by the deploy. The two apps — SwapUp Store and SwapUp Check, from
`../swapup-mobile` — are built as browser apps and Android APKs by:

```bash
BUILD_ONLY=1 bash deploy/release.sh 0.9.1   # build, or check the kept build; nothing on the VM
```

It builds from swapup-mobile's committed HEAD in clean worktrees, never from a working tree, and
keeps the result outside git and outside `/private/tmp` (macOS clears it; a cold APK build takes
about 2.5 hours, a warm one about 5 minutes), in `~/projects/swapup-release-work/<version>/`:
`dist/` (both APKs and their manifests), `dist-web/` (both browser builds), `BUILT.json` (their
sha256s) and `logs/`. A kept build is used again only when it was built from swapup-mobile's HEAD
for that version and versionCode, and each APK's sha256 is the one in its manifest and in
`BUILT.json`. Anything else is refused, never shipped: delete the folder to build it fresh. The
version must be the same in swapup-mobile's `app.json` and `app.config.js` and in this repo's
`package.json`. Bump `versionCode` in `app.config.js` for every APK published.

## Deploy

A release (server, browser apps and APKs) from the committed HEADs of both repos:

```bash
bash deploy/release.sh 0.9.1 --plan   # what it would do; the price check is read only
bash deploy/release.sh 0.9.1
```

In order, it:

1. refuses uncommitted changes in either repo, or a version the repos don't say;
2. builds the apps, or reuses the kept build (see Build);
3. checks, read only, that the live site can price a trade-in. With no active rate card and no
   PriceIQ key it stops with one sentence (since 0.9.1 nobody types a price, so every trade-in would
   read "No market price yet");
4. backs up the live database to `~/swapup-backups/swapup-pre-<version>-<UTC time>.db` on the VM;
5. runs `deploy/deploy.sh` from a clean worktree, with the kept builds;
6. verifies: the versions served at `/app/<app>/version.json`, the APKs on `/downloads` (sha256),
   that no page names the partner, and that no case still stores a retired sentence;
7. adds both APKs' version, versionCode, commit and sha256 to `deploy/RELEASES.json`. Commit that
   file; the next release refuses to start until you do.

Rate cards (the partner's weekly price sheets) live in `~/projects/swapup-ops/rate-cards/`, outside
git, because no price file ever ships: the partner uploads one at `/partner/rate-cards`. What the
release asks the VM (the price check, the backup, the verify) is in `deploy/vm.sh`.
`deploy/release.test.ts` runs `release.sh` against a folder standing in for the VM (`FAKE_SSH`),
never the VM itself.

`bash deploy/deploy.sh` on its own builds the server locally in a clean copy (webpack), ships it to
the denovo-erp VM, installs production dependencies there, runs pm2 `swapup` on :4500 and adds the
Caddy site `swapup.104-197-168-25.sslip.io`, uploading whatever is in `../swapup-mobile/dist` and
`dist-web` (or `MOBILE_DIST` / `WEB_DIST`). The session secret lives in `/etc/swapup.env` on the VM,
minted once and reused. Before shipping it checks, from the VM, that PriceIQ answers 200 for a known
phone (Galaxy S23 Ultra 256GB) with the key in `/etc/swapup.env` (skipped, with a message, while
that key is missing) and that the live site can price a trade-in (the same check as `release.sh`).
It takes its own database backup unless `release.sh` already has, and it never ships a `.csv`
(there is no bundled price file).

**Rollback.** Before anything ships, `deploy.sh` keeps the release that answers now in
`~/swapup-prev` on the VM (everything but `data/` and `.next/cache`; `~/swapup-prev.kept` names it).
After the restart it asks the new build, on the VM, for `/login` (200) and
`/api/signup/programmes` (200 with its JSON). If that fails, or the ship, `npm install` or the
restart fails, it puts the kept release back, restarts pm2, checks it answers, and exits 1 either
way (`✗ ROLLED BACK`, or `✗ DOWN` when nothing was kept or the old one does not answer either).
Caddy, the browser apps and the APKs are only touched once the new build answers, so a rolled-back
deploy leaves them as they were. The database is left as the new build left it: migrations only
add, so the build before runs on it, and the backup from before the deploy is in `~/swapup-backups`.
A live app that does not answer is never kept over the release kept before it.
`deploy/deploy.test.ts` runs `deploy.sh` against a folder standing in for the VM (`FAKE_SSH`, with a
stand-in pm2 running each build's own server), never the VM itself.
