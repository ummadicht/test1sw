# SwapUp — UI/API build spec (for the parallel builders)

SwapUp is an in-store **repair-vs-upgrade + trade-in desk** for Samsung service centres
(and any client's experience centres). A customer brings a phone to be repaired; the
advisor records the faults, gets the **repair quote** (Samsung list price + labour + GST)
and the **trade-in value** from the buyback partner, and the app shows both
side by side with an honest recommendation. If the customer upgrades to a new Samsung,
they get trade-in value **plus a 2–5% upgrade bonus** off the new phone. The store keeps
the old phone and that trade-in value is **held on the store's credit line** until the
partner **collects** (or **clears**) it. At the limit the store cannot take more trade-ins
until a pickup frees the line.

**The SwapUp premium (2026-10-18).** The trade-in value is the **market price** M — what the
buyback partner pays for the phone. SwapUp pays the customer **M + P**, the premium P being 5% / 4% /
3% / 2% of M by band (`lib/domain/premium.ts`, never less than the band edge below pays), plus the
bonus, off the new phone. The credit line holds **T = M** only — what the partner pays back — so a
regrade charges back M − accepted, never the premium. P, like the bonus, is the programme's: frozen
at lock (`premium_value`, `premium_bp`, `premium_funded_by`) and claimed on `/admin/claims` ("Bonus
and premium claims"), never a hold and never a chargeback. A new phone that costs less than M + P +
the bonus is refused (nothing is floored).

The domain, database and services are DONE and tested. You build pages, client
components and API routes on top of them. **Do not change files under `lib/domain/` or
`lib/server/`** except where your task explicitly says so — if a service is missing
something, write the smallest additive function in a NEW file `lib/server/<area>-extra.ts`
and say so in your final report.

## Stack and conventions

- Next.js 16 App Router, React 19, Tailwind v4, better-sqlite3. TypeScript strict. No basePath
  (served at the host root) — plain `fetch('/api/...')` and `<Link href="/...">` are correct.
- **Read pattern:** `app/<route>/page.tsx` is an async SERVER component:
  ```ts
  const u = await requirePage(["advisor","store_manager"], "/desk"); // lib/server/page.ts
  const data = someService(u, ...);                                   // call lib/server/* directly
  return <AppShell user={u}><ClientThing initial={data} /></AppShell>;  // components/AppShell.tsx
  ```
  Pages export `export const dynamic = "force-dynamic";`.
  Dynamic route params are a Promise in Next 16: `{ params }: { params: Promise<{ id: string }> }` then `const { id } = await params;` (same for `searchParams`).
- **Write pattern:** client components (`"use client"`) call API routes with `api()` from
  `lib/client/api.ts` (throws `Error(message)` on failure; redirects to /login on 401), show
  the error with `<ErrorText error=... />`, then `router.refresh()` (or replace local state
  with the returned object).
- **API routes:** every handler body is wrapped: `return handle(async () => { const u = await requireUser([...roles]); ... })`
  using `handle`/`body` from `lib/server/http.ts` and `requireUser` from `lib/server/auth.ts`.
  Services already enforce tenant scope and throw `HttpError` with user-facing messages — do
  not duplicate their checks, do not catch their errors.
- **⚠ Client components must NEVER import `lib/server/*` values** (it drags better-sqlite3 /
  node:fs into the browser bundle and the page dies; `tsc` does not catch it). `import type`
  from `lib/server/*` is fine. Pure modules in `lib/domain/*` are safe to import in client code
  (labels, `inr`, `fmtBp`, `FAULTS`, `CASE_STATUS_LABEL`, etc.).
- Server components may import `lib/server/*` freely.
- UI primitives: `components/ui.tsx` — `Card, Money, Pct, Banner, SourceBadge, Meter, Stat,
  Field, Empty, StatusPill, ErrorText, fmtDate, BrandMark`. CSS classes in `app/globals.css`:
  `.btn .btn-primary .btn-up .btn-fix .btn-danger .btn-ghost .btn-sm .input .select .textarea
  .label .hint .pill(.pill-up/-fix/-warn/-bad/-test) .chip (aria-pressed) .banner(-warn/-bad/-up/-test)
  .table .meter .kpi .section-title .num .card .card-pad .no-print`. Colour tokens as Tailwind
  colours: `text-up bg-up-bg text-fix bg-fix-bg text-warn text-bad text-muted text-ink-2 border-line bg-surface bg-canvas`.
  Use them; do not invent a second design language. Tablet-first (counter iPad / desktop),
  must work at 375px phone width without horizontal page scroll (wrap tables in `overflow-x-auto`).
- Money is integer rupees. Always render with `<Money value=.../>` (or `inr()`); percentages
  are basis points → `<Pct bp=.../>` / `fmtBp()`.

## Honesty rules (non-negotiable — the user has rejected "theatre" before)

1. No made-up prices and no sample prices: a trade-in comes from PriceIQ, the partner's uploaded
   rate card — none of them → "No market price yet", with the reason. Never a typed price (0.9.1).
   Market data over 14 days old is shown with its age. Show the source label/effective date for
   partner prices. A test programme says "Test programme — no real money" (`AppShell`).
   Screens never name the partner company — "the partner" or the partner org's own name.
2. Never invent a number in the UI. If the service returned null, show "—" and the reason
   it gives (`missing[]`, `reason`, `lockBlockers[]`, `notes[]`).
3. The bonus is a promotion: show it in the upgrade column and in the receipt, never as a
   reason in the recommendation.
4. Show the recommendation's `signals` (each with points→repair/upgrade) and `caveats`
   verbatim, and `favoursCustomer` as plain words ("At resale value the phone is worth more
   kept / let go / about the same").
5. Repair prices are Samsung list prices (excl. GST — the app adds GST and labour). Show
   `repair.notes` and line sources.

## Roles and logins (demo password `swapup2026` for all)

| username | role | where |
|---|---|---|
| advisor / advisor.kor / xc.advisor | advisor | Andheri / Koramangala / Connaught Place |
| manager / manager.kor / xc.manager | store_manager | same stores |
| samsung / xc.admin | org_admin | the two demo clients |
| partner | partner | Buyback Partner (demo) ops |
| platform | platform | SwapUp |

Landing per role (`homeFor`): advisor→/desk, store_manager→/store, org_admin→/admin,
partner→/partner, platform→/platform. Nav is in `components/AppShell.tsx` (`navFor`) — every
href there must exist when you are done (between all builders).

## Service API reference (signatures you call)

`lib/server/cases.ts`
- `listCases(u, {storeId?, status?: CaseStatus[], q?, limit?, pickupId?}) → CaseListItem[]` (role-scoped)
- `createCase(u, {customerName?, customerPhone?}) → CaseView` (advisor/store_manager)
- `getCase(u, id) → CaseView`
- `updateCase(u, id, patch: CasePatch) → Promise<CaseView>` — CasePatch fields:
  `modelId, variant, imei, faults: FaultId[], coverage: "none"|"warranty"|"care_plus",
  condition: ConditionAnswers, conditionFromFaults: true, customer: {name, phone},
  manualRepair: {amount, reason}|null, partnerQuote: refused 400 unless null (0.9.1 — prices are never typed in),
  upgradeDeviceId: string|null`. Re-prices automatically.
- `reprice(u, id, {requote?: boolean}) → Promise<CaseView>`
- `setBonusOverride(u, id, {bp: number|null, reason?}) → Promise<CaseView>` (store_manager+)
- `chooseRepair(u, id)`, `walkAway(u, id, reason?)`, `lockTradeIn(u, id, {customer: {name, phone, idType, idLast4}, checks: {ownership, simRemoved, imeiMatches, noFinanceLock, kym, imeiCheckAck?}})`, `cancelTradeIn(u, id, reason)` (store_manager+), `recordDataClear(u, id, {accountsSignedOut, resetDone, setupScreenSeen, noPreviousAccount, note?})` (store staff, `locked`/`in_pickup`, once — the customer's own factory reset after acceptance, labelled "not a certified erasure"; factory reset + account sign-out moved here from the lock checks on 2026-10-16)
- `CaseView` fields: `id ref status storeName storeCode advisorName customer device{modelId brand model series variant releaseYear supportEndYear ageYears} imei imeiCheck faults coverage condition conditionProblems manualRepair repairNotServiced repair(RepairEstimate) quote(PartnerQuote) quoteExpired repairedQuote upgrade{deviceId label model series variant price supportEndYear} bonus{bp amount basisAmount steps[] clampedBy fundedBy campaignName override} decision(Decision) checks tradeValue premiumValue bonusValue payable pickupId clearance{outcome accepted shortfall reason by at} settledAt demo createdAt updatedAt lockedAt closedAt partner{kind label why partnerName} creditCheck lockBlockers[]`
- `PartnerQuote`: `status amount lines[{label bp? amount}] source{kind label effectiveFrom?} partner partnerRef quotedAt validUntil reason?`
- `Decision`: `recommendation("repair"|"upgrade"|"either"|"no_repair"|"cannot_say") headline favoursCustomer("keep"|"let_go"|"level"|null) repair{pays keepsValue net covered} upgrade{label newPrice tradeIn bonus pays extraVsRepair} metrics{repairRatio valueAddedByRepair yearsLeftOld yearsLeftNew costPerYearRepair costPerYearUpgrade} signals[{code points strength text}] missing[] caveats[]`

`lib/server/catalog.ts`
- `tradeModels(q?, brand?)`, `tradeBrands()`, `newDevices(orgId, includeInactive?)`, `saveNewDevice(u, {...})`,
  `repairBook(orgId, modelId?)`, `saveRepairPrice(u, {orgId?, modelId, part, price|null, sourceLabel?})`,
  `campaigns(orgId)`, `activeCampaigns(orgId)`, `saveCampaign(u, {orgId?, campaign, active?})`,
  `rateCards(partnerId)`, `rateCardDetail(partnerId, id)`, `uploadRateCard(u, {partnerId?, label, effectiveFrom, quoteValidityDays, csv, deductions?, activate?})`, `activateRateCard(u, id, partnerId?)`
- Existing routes: `GET /api/catalog/models?q=&brand=` → `{brands, models}`; `GET /api/catalog/new-devices` (`?all=1&orgId=` for admins) → `{devices}`.

`lib/server/credit.ts`: `creditSummary(u, storeId, {withLedger?})` → `{store, policy, position{limit exposure available utilisation held chargebacksOpen state}, advice{due reasons oldestDays}, held[{caseId ref value heldSince status pickupId label}], inTransit{count value}, ledger|null}`; `setCreditLimit(u, storeId, limit, reason)`. Route exists: `GET /api/stores/[id]/credit?ledger=1`.

`lib/server/pickups.ts`: `listPickups(u, {status?, storeId?})`, `getPickup(u, id)`, `requestPickup(u, {caseIds?, notes?})` (store_manager), `schedulePickup(u, id, {scheduledFor, collectorName})` (partner), `removeFromPickup(u, id, caseId)`, `cancelPickup(u, id)`, `collectPickup(u, id, {collectedCaseIds, collectorName, handoverBy})` (partner or store_manager), `clearItem(u, id, {caseId, outcome: "cleared"|"regraded"|"rejected"|"not_received", accepted?, reason?})` (partner), `settlePickup(u, id, {reference})` (partner), `recoverChargeback(u, caseId, {amount, note})`, `openChargebacks(u, storeId?)`. PickupView: `id ref status orgName storeName storeCity partnerName requestedAt requestedBy scheduledFor collectorName handoverBy collectedAt reconciledAt settledAt settlementRef settlementAmount items[CaseListItem + clearance] totals{devices quoted accepted shortfall verified}`.

`lib/server/reports.ts`: `programmeReport(u, {orgId?, from?, to?})`, `bonusClaims(u, {orgId?, month?})`, `toCsv(rows)`, `partnerReport(u)`.

`lib/server/admin.ts`: `listOrgs(u)`, `createOrg(u, {name, kind, clientType?, targetBrand?, partnerId?})`, `updateOrgSettings(u, orgId|null, patch)`, `listStores(u)`, `createStore(u, {orgId?, name, kind, city?, code, creditLimit})`, `listUsers(u)`, `createUser(u, {name, username, role, orgId?, storeId?}) → {user, tempPassword}`, `resetPassword(u, id) → {tempPassword}`, `setUserActive(u, id, active)`, `changeOwnPassword(u, current, next)`.

`lib/server/scope.ts`: `storesForUser(u)`, `getOrg`, `getStore`, `adminOrgId(u, requested?)` (platform must pass an orgId — use `?orgId=` in the URL and a client picker).

Domain labels you will want (client-safe): `lib/domain/condition.ts` (`FAULTS, FAULT_BY_ID, PART_LABEL, SCREEN_LABEL, BODY_LABEL, ISSUE_LABEL, AGE_LABEL, SCREEN_ORDER, BODY_ORDER, conditionFromFaults, conditionFloor`), `lib/domain/lifecycle.ts` (`CASE_STATUS_LABEL, OUTCOME_LABEL, PICKUP_STATUS_LABEL`), `lib/domain/money.ts` (`inr, fmtBp, pctToBp, bpToPct`), `lib/domain/imei.ts` (`readImei, maskImei`).

## Definition of done for each builder

- `npx tsc --noEmit -p .` passes for your files (others may be mid-build; only fix your own).
- No client file imports a `lib/server/*` value.
- Every page you own renders for its roles; wrong roles are redirected by `requirePage`.
- Your final message lists: files created, routes, anything you could not do, and any
  service you wished existed.
