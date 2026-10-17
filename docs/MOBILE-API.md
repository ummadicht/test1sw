# SwapUp mobile — API contract (store app + customer test app)

Two Android apps from one Expo codebase (`~/projects/swapup-mobile`):

- **SwapUp Store** (`com.swapup.store`, scheme `swapupstore`) — staff sign in with their
  SwapUp account, start a customer trade-in, show the Wi‑Fi QR and the test QR, watch the
  customer's tests land live, apply them to the case, continue pricing.
- **SwapUp Check** (`com.swapup.check`, scheme `swapupcheck`) — the customer installs it
  from the test QR's download page, runs the native hardware tests on their own phone, and
  every result streams to the SwapUp server.

Both apps also run **in a browser**, built from the same code with Expo web and served on the
SwapUp origin itself — `/app/store/` and `/app/check/` (see §7). Same origin = same API, no CORS.

Server: the SwapUp Next.js app (`~/projects/swapup`). Production base URL
`https://swapup.104-197-168-25.sslip.io`; dev `http://<mac-lan-ip>:4500`.

All bodies are JSON. Errors are `{ "error": "<sentence a person can read>" }` with a 4xx/5xx.

---

## 1. Staff authentication (store app)

`POST /api/auth/token` `{ username, password }` →
`200 { token, expiresAt, user: { id, name, role, roleLabel, org: {id,name,demo}, store: {id,name,code,city,kind} | null } }`

The token is the same signed session the web cookie carries. Send it as
`Authorization: Bearer <token>` on every staff call. **A Bearer header always wins over the
session cookie** (and a bad one is a 401 — never topped up from the cookie): the browser store
app shares the desk's origin, so its requests also carry whatever desk cookie that browser has,
often a different person's. Valid 12 h; on 401 the app returns to
the sign-in screen. Only counter roles (`advisor`, `store_manager`) may use the store app;
other roles get `403 "The store app is for store staff."`.

`GET /api/me` (Bearer) → same `user` object.

`GET /api/stores/<storeId>/credit` (Bearer) → credit summary (`position.available`,
`position.utilisation`, `position.state`, `advice`, `held[]`) — already exists.

### Web hand-off (continue pricing in an in-app WebView)
`POST /api/auth/handoff` (Bearer) `{ next: "/cases/<id>?view=answer" }` → `{ url }` — a one-time URL
`/api/auth/handoff/<nonce>` valid 60 s that sets the web session cookie and redirects to
`next`. Load that URL in the WebView.

Since 2026-10-17 the store app hands off with **`?view=answer`**: the desk's case page then opens on
the same answer the app shows (§3c) — refurb quote vs trade-in + bonus — with steps 1–6 folded
under it. A `#step-…` anchor is optional (`#step-phone`, `#step-repair`, `#step-tradein`,
`#step-upgrade`, `#step-lock`); `/cases/<id>` alone still works and lays the page out as before.

## 1b. Store tablet (signed in for the store, advisor by name + PIN)

The full contract — model, data, rules, sentences and the app's screens — is
[`STORE-TABLET.md`](STORE-TABLET.md). In short: a store manager enrolls the counter tablet once and
it keeps a long-lived, revocable **device token** (`sdt_…`) for that one store, sent as
`Authorization: Device <token>` (never Bearer — it is not a session). Unlocking with a PIN returns
the same 12 h staff token as `/api/auth/token`; everything after that is the staff API above.

Staff (Bearer):
- `POST /api/store-devices` `{ name }` (store manager) → `201 { deviceToken, device: { id, name, createdAt }, store: { id, name, code, city } }` — the token is shown once.
- `GET /api/store-devices` (store manager; programme admin with `?storeId=`) → `{ devices: [{ id, name, createdAt, createdBy, lastSeenAt, revokedAt }] }`, newest first.
- `POST /api/store-devices/<id>/revoke` (store manager of that store / programme admin) → `{ ok: true }`, idempotent.
- `POST /api/me/pin` `{ password, pin }` (advisor / store manager) → `{ ok: true }`; wrong password 403, weak PIN 400.

Tablet (Device):
- `GET /api/tablet` → `{ device, store, org, staff: [{ id, name, role, roleLabel, hasPin }] }`.
- `POST /api/tablet/unlock` `{ userId, pin }` → `{ token, expiresAt, user }` (404 not staff · 409 no PIN yet · 429 locked · 403 wrong PIN).
- `POST /api/tablet/set-pin` `{ userId, password, pin }` → `{ token, expiresAt, user }`.

Unknown or removed device token → `401 "This tablet was removed from the store. A manager can set it up again."`;
a rejected store → 403. 5 wrong tries for one person on one tablet lock that person there for 10 minutes.

## 2. Store Wi‑Fi (the network the customer's phone joins)

`GET /api/stores/<storeId>/wifi` (Bearer, counter roles of that store) →
`{ wifi: { ssid, password, security: "WPA"|"WEP"|"nopass", hidden } | null, qr: "WIFI:T:WPA;S:…;P:…;H:false;;" | null }`

`POST /api/stores/<storeId>/wifi` (store_manager / org_admin) `{ ssid, password, security, hidden }`
→ same shape. `{ ssid: "" }` clears it. Special characters `\ ; , : "` are escaped in `qr`.

## 2b. Returning customers (find by mobile)

The counter starts with the customer's mobile number (since 2026-10-17, `docs/TWO-PASS-CAMERA.md`).

`GET /api/customers?phone=<10 digits>` (Bearer, `advisor` / `store_manager`) →

```json
{
  "customer": { "name": "Meera Iyer", "phone": "9820012345" } | null,
  "history": [{ "caseId", "ref", "status", "storeName", "device": "Samsung Galaxy S22 128GB" | null, "createdAt" }]
}
```

- Matched on the phone recorded on earlier **cases of the caller's own organisation** (any of its
  stores — a sister store's customer is still a returning customer); never another client's.
- `history`: newest first, at most 10, every status (the app labels them). `customer` is null when
  no case has the number; `customer.name` is the newest name any of them recorded, `""` when none did
  (a case opened with only the number) — ask for it.
- The number is reduced to digits first; `+91` / `91` and a leading `0` are dropped. Anything that is
  not a 10-digit Indian mobile (6–9 first) → `400 "Enter a 10-digit Indian mobile number."`
- `partner`, `org_admin`, `platform` → `403` (no counter). Then create as before
  (`POST /api/test-sessions` with `customerName` + `customerPhone`).

## 2c. The store's counter code (a customer starts a trade-in alone)

Since 2026-10-17 (`docs/PHONE-LED-FLOW.md`) every store has a permanent 6-character **counter
code** (same alphabet as session codes; never the demo code), printed as a QR on the counter. A
customer scans it, their phone joins, and a new session **and case** appear on the store's Home
like any other (`TestSessionView.customerStarted: true`).

`GET /api/stores/counter-code` (Bearer, `advisor` / `store_manager` of their own store) →
`{ code: "K7M2QX", joinUrl: "https://swapup…/j/K7M2QX" }` — made the first time anyone asks.
Other roles → `403`.

`POST /api/stores/counter-code/regenerate` (Bearer, `store_manager`) → `{ code, joinUrl }` — a new
code at once; the old one stops starting new checks (phones already mid-check on it carry on).
Advisors → `403 "Only the store manager can make a new counter code."`

Joining with a counter code works like the standing demo code, generalised (`testSessions.ts`
`standingSessionFor`): this phone's own open session at that store, else an unclaimed one, else a
new session + case opened under a store manager of that store (an advisor when it has no manager),
audited `test_session.create` `{ via: "counter code" }`. Guards, because the QR is on show:
- at most 20 NEW sessions per store per 10 minutes → `429 "Too many new checks at this store…"`;
- the same phone re-joining within 12 h of the store **applying** its results →
  `409 "This phone's check at <store> is finished — the store has its results…"` — so a re-opened
  app doesn't quietly open a second trade-in; its old ticket still reads `GET /api/device/status`
  → `applied`.
A closed (rejected / inactive) store's counter code, or one with no staff, is `404` like any
dead code. `/j/<counter code>` shows the store's name and no case (there is none until a phone joins).

## 3. Test sessions (store side)

`POST /api/test-sessions` (Bearer, advisor/store_manager)
`{ caseId?: string, customerName?: string, customerPhone?: string }`
→ creates a case at the user's store when `caseId` is absent, and a test session:

```json
{
  "session": TestSessionView,
  "joinUrl": "https://swapup…/j/K7M2QX",
  "deepLink": "swapupcheck://join?code=K7M2QX&server=https%3A%2F%2Fswapup…",
  "downloadUrl": "https://swapup…/downloads/swapup-check.apk",
  "wifi": { "ssid": "...", "qr": "WIFI:…" } | null
}
```

`GET /api/test-sessions/<id>` (Bearer) → `TestSessionView` (poll every 2 s while open). This
poll also drives the camera-grading pulls from GradeIQ (§8) — throttled on the server.
`GET /api/test-sessions?open=1` (Bearer) → `{ sessions: TestSessionView[] }` for the store
(grading from what is stored; no GradeIQ calls).
`POST /api/test-sessions/<id>/apply` (Bearer) → applies the mapped model, storage, the tested
faults **and the camera-confirmed faults** (§8), and a condition no better than the advisor's,
the faults' or the camera's, to the case (through the normal case service, so it re-prices) →
`{ session: TestSessionView, caseId }`. Since 2026-10-17 Apply also settles the storage without
asking (§4, "At Apply") and **suggests the new phone** (§3c) unless staff already chose one, so the
case comes back with an answer: `GET /api/cases/<id>` → `offer`.
`POST /api/test-sessions/<id>/cancel` (Bearer) → status `cancelled`, ticket revoked; its GradeIQ
session is abandoned.
`POST /api/test-sessions/<id>/reissue` (Bearer) → new code + QR for the SAME case when the
old one expired. A new code is a new GradeIQ session (the photos belong to the phone that joins).
`POST /api/test-sessions/<id>/camera-override` (Bearer) `{ reason }` → `TestSessionView` — unlocks
the camera page without the customer's phone echoing patterns (§8). Needs a reason (≥ 8 chars);
recorded with the staff member's name; the case is marked "LCD not camera-checked".
`POST /api/test-sessions/<id>/grading-retry` (Bearer) → `TestSessionView` — after "Camera grading
unavailable", ask for a fresh GradeIQ session.

```ts
type TestSessionView = {
  id: string; code: string; caseId: string; caseRef: string;
  status: "waiting" | "opened" | "joined" | "testing" | "complete" | "applied" | "expired" | "cancelled";
  createdAt: string; expiresAt: string; openedAt: string | null; joinedAt: string | null;
  completedAt: string | null; appliedAt: string | null;
  device: { brand, manufacturer, modelName, modelCode, osVersion, totalDiskBytes, totalMemoryBytes, batteryLevelPct, isPhysicalDevice, appVersion } | null;
  plan: { id: string; name: string; critical: boolean }[];    // tests the app will run
  results: Record<string, { outcome: "pass"|"fail"|"skip"|"unsupported"; detail: object|null; at: string }>;
  declared: { screenCracked: boolean|null; backCracked: boolean|null; liquid: boolean|null; imei: string|null;
              // only when a ≥ 0.6.0 app sent them:
              imei2?: string|null; identityConfirmed?: boolean|null;
              picked?: { modelId: string; variant: string|null; label: string } | null;   // the customer's own pick — a claim
              customerName?: string|null; customerPhone?: string|null } | null;
  progress: { done: number; total: number };
  summary: DiagnosticSummary | null;   // computed whenever results change
  grading: GradingView | null;         // camera grading (§8) — staff responses only
  // Phone-led flow (SwapUp Check ≥ 0.6.0, docs/PHONE-LED-FLOW.md):
  scanFirst: boolean;                  // the joined phone is ≥ 0.6.0 (native or web-0.6.0+): Identify › Scan › Test › Result
  phonePhase: "identify"|"scan"|"battery"|"test"|"done" | null;   // what the phone last said (POST /api/device/phase)
  phonePhaseAt: string | null;
  customerStarted: boolean;            // started from the store's counter code (§2c)
  imeiAgreement: "match"|"differs"|"unknown" | null;   // the phone's IMEI(s) vs the case's (no shared number = differs); staff only
};
type DiagnosticSummary = {
  model: { modelId: string|null; label: string|null; variant: string|null; match: "exact"|"family"|"none"; why: string };
  faults: { id: FaultId; because: string; sources: ("tested"|"declared"|"camera_ai")[] }[]; // SwapUp fault ids (lib/domain/condition.ts); camera_ai = a display fail only the store camera's confirmed LCD sweep found
  untested: { id: string; name: string; critical: boolean }[]; // skipped / unsupported / never run
  notes: string[];                                             // things that are not faults but worth saying
  verdict: "all_passed" | "faults_found" | "incomplete";
};
```

Status meanings: `waiting` (QR shown) → `opened` (download page viewed — GET never
consumes the code) → `joined` (the app exchanged the code for a ticket) → `testing` (first
result in) → `complete` (app said done) → `applied` (staff applied it to the case).
A session expires 30 min after creation unless joined; a joined session expires 2 h after
joining.

## 3b. Refurb cost quote and BUY vs SELL (store side)

After the test is applied, the advisor enters the refurb cost and the trade-in is shown as
buy vs sell — the same four lines on the desk's case page (step 5) and in the store app
(`lib/domain/buySell.ts` is the reference implementation).

**Since 2026-10-17 this is the store's margin, staff only.** In the store app the card sits in a
collapsed "Store margin · staff only" row at the bottom of the answer screen (§3c), closed by
default; its box is relabelled **"Store's refurb cost"** (it was "Refurb cost · your quote" in the
app and "Refurb cost (quote)" on the desk), so it can't be confused with the answer's **Refurb
quote** — the CUSTOMER's repair price. The figures and the logic below are unchanged.

| Line | From the case (`GET /api/cases/<id>`) |
| --- | --- |
| Buy — pay the customer | `quote.amount` when `quote.status === "priced"` |
| Store's refurb cost | `refurbCost.amount`, else `repair.listTotal ?? repair.customerPays` when `repair.status === "quoted"`, else ₹0 when `faults` is empty |
| Sell — after refurb | `marketSell.amount` (PriceIQ's Cashify refurbished listing less 2–5%), else `repairedQuote.amount` when `repairedQuote.status === "priced"` |
| Margin | Sell − Buy − Refurb, only when all three are known (negative = a loss) |

`marketSell` is `{ amount, listing, markdownBp, grade, gradeWanted, listings, week, why: null, source }`
or `{ amount: null, why, source }`. `listing` is the lowest Cashify refurbished ask at `grade` for
that model + storage (PriceIQ leaf `cashify/sell`); the markdown is 5% up to ₹15,000, 4% up to
₹30,000, 3% up to ₹50,000, 2% above (`lib/domain/marketSell.ts`). `grade` is the Cashify grade
the phone comes out at after refurb (`gradeAfterRefurb`); when Cashify lists none at it, the next
lower listed grade is used and `gradeWanted` keeps the one it should have been.

A missing number is shown as "—" with why (no quote yet; PriceIQ has no listing and the
partner gave no repaired price; the repair needs a bench quote) — never guessed.

`PATCH /api/cases/<id>` (Bearer, `advisor` / `store_manager` of the case's store; the case still
`draft` or `quoted`) `{ "refurbCost": { "amount": 4200 } }` → the whole `CaseView`. `amount` is
whole rupees 0–5,00,000; the staff member's name and the time are stored with it
(`refurbCost.by`, `refurbCost.at`). `{ "refurbCost": null }` goes back to SwapUp's estimate.
The refurb cost is the STORE's figure: it changes no price — the partner is not re-asked, and the
advice, bonus and decision never read it (`manualRepair` is the customer's repair price and still
does). A partner viewing the case sees `refurbCost: null`. Errors: `400` bad amount, `401` session
over, `403` not a counter role, `404` case not in your store, `409` the case is past the counter.

## 3c. The answer (`offer`) — refurb quote vs trade-in + bonus

Owner, 2026-10-17: "Why asking questions when we have all tested data ... just refurb quote vs bonus
+ trade in price." After Apply the case carries **one answer**, worked out on the server
(`lib/domain/offer.ts` `buildOffer`, called from `toView`) and shown the same way by the store app's
answer screen and the desk's `?view=answer` card. The app never invents a reason: it shows these
strings and owns only its labels.

| Label | Figure |
| --- | --- |
| **Refurb quote** | What the CUSTOMER pays to fix it: `repair.customerPays` from the price book, or the bench / service-centre quote (`manualRepair`), or ₹0 when covered. The figure `decide()` compares and the bonus's repair-ratio rule reads. **Never** the store's `refurbCost` (§3b). |
| **Trade-in + bonus** | The partner's as-is price + the upgrade bonus for the new phone. |

The verdict is `decision.headline`, unchanged (`decide()`, its thresholds and `RULESET_VERSION` did
not move); the bonus is shown and never a reason.

### CaseView additions (`GET`/`PATCH /api/cases/<id>` and every `/action` response)

```ts
type UpgradeChoice = {
  deviceId: string; label: string; model: string; series: string; variant: string;
  price: number; supportEndYear: number | null;
  suggested?: boolean;   // true = SwapUp picked it; false/absent = staff picked it (it then stands)
  why?: string;          // the suggestion's reason, e.g. "Newest Galaxy S Ultra, same storage (256GB)."
  rule?: string;         // UPGRADE_RULE_VERSION ("2026-10-17.1") when suggested
};
CaseView += {
  variantSource: "measured" | "catalogue" | "customer" | "advisor" | null;  // null when there is no storage
  measuredStorage: string | null;  // the size the phone read off its own disk at Apply, whatever the model's
                                   // list says ("1TB" on an Ultra on file as 256/512GB); null = it didn't measure
  offer: Offer | null;   // null for a partner viewer
};

type VariantSource = "measured" | "catalogue" | "customer" | "advisor";
type OfferAsk =
  | { kind: "blocked";       title: string; text: string }
  | { kind: "model";         title: string; text: string }
  | { kind: "storage";       title: string; text: string;
      options: { variant: string; tradeIn: number | null; sample: boolean }[];   // [] = no chip can be right (below)
      note: string | null }                                                      // "Sample price — not a real quote." | null
  | { kind: "partner_quote"; title: string; text: string }
  | { kind: "repair_quote";  title: string; text: string }
  | { kind: "new_phone";     title: string; text: string };

type Offer = {
  open: boolean;                          // status is draft or quoted
  headline: string;
  reason: string | null;                  // one sentence under the headline
  recommendation: Recommendation | null;  // decision.recommendation (null when no decision)
  recommended: "repair" | "swap" | null;  // repair→"repair"; upgrade|no_repair→"swap"; either|cannot_say→null
  asks: OfferAsk[];                       // ordered: blocked, model, storage, partner_quote, repair_quote, new_phone
  storage: { variant: string | null; source: VariantSource | null; note: string | null };
  repair: {                               // THE refurb quote
    amount: number | null; covered: boolean; basis: "book" | "manual" | null;
    detail: string | null; why: string | null; nothingToRepair: boolean;
    coverage: "none" | "warranty" | "care_plus";
  };
  swap: {
    tradeIn: number | null; tradeInNote: string | null;
    bonus: number | null; bonusBp: number | null; bonusWhy: string | null;
    total: number | null;                 // tradeIn + (bonus ?? 0); null when tradeIn is null
    why: string | null;                   // why tradeIn is null
    newPhone: { deviceId: string; label: string; price: number; suggested: boolean; why: string | null } | null;
                                          // label = model + storage, no brand ("Galaxy S26 Ultra 256GB");
                                          // the CaseView's upgrade.label keeps the brand
    customerPays: number | null;          // decision.upgrade.pays
    vsRepair: number | null;              // decision.upgrade.extraVsRepair (+ = the swap costs more today)
  };
  actions: { repair: string | null; swap: string | null; walkAway: string | null }; // null = allowed, string = why not
  signals: { text: string; points: "repair" | "upgrade"; strength: "strong" | "soft" }[];
  caveats: string[];
};
```

The offer is worked out for every status; `open` says whether it can still be acted on. Once the
case is closed (`repair_chosen`, `walked_away`, `locked` and later) `asks` is `[]` and every action
is "This case is closed.". A partner viewing a case gets `offer: null` (and `refurbCost: null`).

### The strings, word for word

`asks` (each appears only while the case is open):

| Kind | Title | Text | When |
| --- | --- | --- | --- |
| `blocked` | "Check this is the right phone" | `quoteBlocked` | the camera says this may not be the phone on the case |
| `model` | "Which phone is it?" | "The test couldn't tell the model. Choose it on the full case." (no test was applied to the case: "No model on the case yet. Choose it on the full case.") | no model on the case |
| `storage` | "Which storage is it?" | "The phone couldn't measure its storage. Settings › About phone › Storage shows it." — only when a test ran and the phone read nothing. No test applied (a desk-only case), or the phone measured a size on the list that is no longer on the case: "No storage on the case yet. Settings › About phone › Storage shows it." The phone measured a size that ISN'T on the model's list (`measuredStorage`, e.g. a 1TB Ultra on file as 256/512GB): "The phone measures 1TB, which isn't a size on file. Check Settings › About phone, and enter the Cashify quote on the full case if it's really 1TB." | a model, no storage. `options`: the what-if trade-in for each size, smallest size first (`tradeIn: null` when the partner has no price for that size, or none could be asked yet — e.g. the condition is incomplete). `sample: true` on a chip whose price comes from the SAMPLE rate card (a chip with no price is `false`; so are the model's bare sizes); `note` is "Sample price — not a real quote." while any chip is a sample, else null — show it under the chips. **`options: []` when the phone measured an off-list size:** every listed size is one the phone has ruled out, so none is offered (and no what-if prices are asked) — show the text and the way to the full case. |
| `partner_quote` | "Enter the Cashify quote" | `quote.reason` ?? "The partner has no price for this phone." A quote typed in from the Cashify app that has lapsed: "Cashify quote (ref CF-88421) expired — enter today's quote." | model + storage, not blocked, the partner's quote is unpriced or errored — or it is a lapsed Cashify-app quote (`partner_manual` + `quoteExpired`, open case): SwapUp never re-quotes those, so only today's quote from the app (`PATCH {partnerQuote}`) replaces it |
| `repair_quote` | "The repair needs a quote" | the first `repair.notes` entry, or `repairNotServiced` (fallback "The price book can't price this repair — enter the service centre's quote.") | a model, something to repair, and the book can't price it (`needs_inspection` / `unpriced` / brand not serviced) |
| `new_phone` | "Choose the new phone" | "No new phone in the catalogue matches this one — choose it to see the bonus." (the catalogue does have one — staff cleared the suggestion, or none ran on a desk-only case: "Choose the new phone to see the bonus.") | a model and no new phone (the suggestion found none: e.g. an iPhone at a Samsung centre) |

- **`headline`:** the title of the first ask that isn't `new_phone`; else `decision.headline`; else
  "Not enough to compare yet".
- **`reason`:** the first that applies — that ask's text; the first strong signal pointing the way of
  the recommendation; the first signal; for `no_repair` with no signals "The test found nothing wrong
  with the phone." (no test applied to the case: "No faults are recorded on the case."); `cannot_say` with nothing to ask → the first `decision.missing` entry (e.g. "No buyback value for this phone once repaired."); else null.
- **`storage`:** `source` and `note` are null whenever `variant` is null. `note`, when the source is
  `customer`: "The customer typed this — the phone couldn't measure it. Check Settings › About phone
  before the trade-in."
- **`repair.detail`:** covered → "Covered by warranty" / "Covered by Care+"; a manual quote →
  `Quote: ${reason}`; a book estimate → every line label joined with " + ", then "+ labour" if
  labour > 0, "+ GST" if GST > 0, "+ Care+ fee" if that fee > 0 (e.g. "Display assembly + labour + GST").
- **`repair.why`** (only when `amount` is null): "Nothing to repair."; "Choose the phone first.";
  otherwise the repair note, or `repairNotServiced`, else "The price book can't price this repair —
  enter the service centre's quote."
- **`swap.tradeIn`** is null whenever the trade-in can't be trusted — the camera blocks it, there is
  no model, or no storage — even if an older priced quote is still stored.
- **`swap.tradeInNote`:** sample → "Sample price — not a real quote."; read off the partner's app
  (`partner_manual`) and lapsed, on an open case → "Cashify quote (ref ${partnerRef}) expired — enter today's
  quote." (the figure stays on screen for reference, marked; the same sentence is the `partner_quote` ask and
  `actions.swap`); read off the partner's app → `Cashify ref ${partnerRef}` (SwapUp never re-quotes those, so
  it is never "re-quoting"); expired on an open case → "Quote expired — re-quoting." (a closed case's quote
  running out after the lock is no news: no note).
- **`swap.why`**, in order: `quoteBlocked`; "Choose the phone first."; "Tap the storage to see the
  trade-in." (the phone measured an off-list size: the storage ask's text — there is nothing to tap); `quote.reason` (fallback "The partner has no price for this phone."); the first
  `conditionProblems` entry; "Answer the condition questions." (no condition); "No trade-in price
  from the partner yet."
- **`bonusWhy`:** no new phone → "Choose the new phone to see the bonus."; a new phone but no bonus →
  "No upgrade-bonus campaign applies to this phone today." `bonus` / `bonusBp` are a manager's
  override when there is one (`override.amount` / `override.bp`).
- **`actions.repair`:** closed → "This case is closed."; nothing to repair → "Nothing to repair.";
  no refurb quote → `repair.why`; draft → "Not priced yet."; else null.
- **`actions.swap`:** closed → "This case is closed."; no trade-in → `swap.why`; a lapsed Cashify-app quote →
  "Cashify quote (ref …) expired — enter today's quote."; no new phone → "Choose the new phone." (the lock
  blocker's own words); not quoted → "Not priced yet."; else null. A swap the Lock screen is certain to refuse
  for a reason it can't fix there is refused here, with that reason. The IMEI, sample-card, credit and
  rate-card/live expiry blockers stay on the Lock screen (`lockBlockers`) — an expired rate-card or live quote
  IS re-quoted by `reprice`. The lock's expired-quote blocker is "The partner's quote has expired — re-quote."
  for those, and the same "Cashify quote (ref …) expired — enter today's quote." for a Cashify-app quote
  (`expiredQuoteBlocker`), so the Lock screen never asks for a re-quote that can't happen.
- **`actions.walkAway`:** closed → "This case is closed."; else null.

### Filled without asking

- **Storage** — at Apply (§4): the phone's measurement; else the model's only size (`catalogue`);
  else the size the customer picked on their own phone (`customer` — a claim, see the lock below). A
  measured size that isn't on the model's list fills nothing and is kept as `measuredStorage`; the answer
  says so and offers no chip. **Entering the Cashify quote for that phone (`PATCH {partnerQuote}` while the
  case has no storage) settles the storage at the measured size** (`variant: "1TB"`, `variantSource:
  "measured"`): the partner's app priced that phone. `PATCH {variant: "1TB"}` stays refused (not on file).
  Still unknown → the `storage` ask: one row of chips, each with that size's trade-in. Those are
  partner **what-if** quotes (`whatIf: true`, never binding), asked by the re-price for each of the
  model's sizes while the storage is unknown and the condition is complete, consistent and not
  camera-blocked — again only when the description changed or there are none yet — and dropped the
  moment a size is set. One tap: `PATCH {variant}`. Never a guessed size.
- **New phone** — SwapUp suggests one at Apply (`lib/domain/upgrade.ts`, rule `2026-10-17.1`): the
  newest phone in the same line as the old one (S23 Ultra → the newest S Ultra) at the same storage,
  widening to the same family, the nearest A/M/F tier, then the series only when the catalogue has
  nothing closer. It never reads the bonus, the margin or a campaign. It is suggested again whenever the
  model or storage really changes (re-saving the same value is no change) while the new phone is still
  SwapUp's suggestion **or there is none yet** — a desk-only case gets one when its model is set, and a
  case whose suggestion staff cleared gets a new one when the phone's description changes. With no storage
  on the case, the phone's own reading (`measuredStorage`) is the size it is suggested against (S23 Ultra
  1TB → S26 Ultra 512GB). A suggestion for another phone is cleared, never kept. Staff's own choice
  (`PATCH {upgradeDeviceId}` → `suggested: false`) stands across later changes; their Clear stands until
  the phone itself changes.
- **Cover** — `none` unless changed; the refurb tile has a quiet "Cover: None · change".
- **The trade-in is not re-asked** for `manualRepair` or `coverage` (since 2026-10-17): the partner's
  quote reads only model, storage, condition and IMEI, and each edit on the answer screen would
  otherwise extend a rate-card quote's validity or call a live partner again. `reprice` still
  recomputes the repair, bonus and decision on every call, and still re-quotes a missing or expired
  quote. `faults`, `condition`, `modelId`, `variant`, `partnerQuote` and the camera identity override
  still re-quote.
- **IMEI** — not needed for the answer; asked on the Lock screen only if missing.

### The calls

All exist and accept Bearer:
- `GET /api/cases/<id>`
- `PATCH /api/cases/<id>` with one of `{variant}`, `{upgradeDeviceId}`, `{coverage}`,
  `{manualRepair: {amount, reason} | null}`, `{partnerQuote: {amount, reference, validDays?, repairedAmount?}}`,
  `{imei}` → the whole `CaseView`. A staff `variant` is recorded as `variantSource: "advisor"`; only
  Apply can record `measured` / `catalogue` / `customer` (the public PATCH can't say where a size came from).
  **Re-saving the size already on the case changes nothing** (since the 2026-10-17 review): it keeps its
  `variantSource` — a size the customer typed stays `customer`, so the lock still asks for `storageSeen` —
  and the partner is not re-asked and a Cashify-app quote is not cleared. Only a different size is the
  advisor's word (re-quoted, Cashify-app quote cleared). Apply's own word still counts on the same size: a
  measurement turns the customer's claim into `measured`.
- `POST /api/cases/<id>/action` with `{action: "reprice"}`, `{action: "choose_repair"}`,
  `{action: "walk_away", reason?}` or `{action: "lock", customer, checks}` (below).
- `GET /api/catalog/new-devices` → `{ devices: [{ id, brand, model, series, variant, price, supportEndYear }] }`.
- `GET /api/cases?status=draft,quoted&limit=10` — the cases still waiting on the customer.
- `POST /api/auth/handoff` `{ next: "/cases/<id>?view=answer" }` (§1).

### Taking the trade-in — `{action: "lock"}`

`{ action: "lock", customer: { name, phone, idType, idLast4 }, checks: { ownership, simRemoved,
imeiMatches, noFinanceLock, kym: { status, reference? }, imeiCheckAck?, storageSeen? } }`

**`checks.storageSeen: boolean`** (since 2026-10-17) — required when `variantSource === "customer"`:
the advisor saw the storage in Settings › About phone. Without it →
`400 "Confirm before taking the phone: Settings › About phone shows 512GB (the customer typed it — the phone couldn't measure it)."`
A claimed size is enough to SHOW a price; moving money needs it seen — the same rule as the IMEI, one
tick, only when the phone couldn't measure it. It is stored with the checks (`checks.storageSeen: true`)
and in the `case.lock` audit (`storage: {variant, source, seen}`). It is checked right after the
status (only a `quoted` case locks) and before the IMEI check digit and the lock blockers.

### Worked example (local seed: `org_samsung_svc`, sample card, S23 Ultra, `screen_cracked`)

Storage unknown after Apply: status `quoted` (the repair is priced); `asks[0]` storage with 256GB →
₹18,800 and 512GB → ₹20,300; `swap.tradeIn` null, why "Tap the storage to see the trade-in.";
`repair.amount` 34096 (display 28,470 + labour 425 + GST 5,201); new phone S26 Ultra 256GB, suggested.

After `PATCH {variant: "256GB"}`: Refurb quote ₹34,096 · new phone Galaxy S26 Ultra 256GB ₹1,54,999
(suggested, "Newest Galaxy S Ultra, same storage (256GB).") · trade-in ₹18,800 · bonus 400 bp = ₹6,199
(base 200 + S series 100 + repair ≥ 50% of the repaired value ₹34,800 100) · **trade-in + bonus
₹24,999** · customer pays ₹1,30,000 · vsRepair +95,904 · `either`, "Either is reasonable — it's the
customer's choice", three soft signals · `tradeInNote` "Sample price — not a real quote." (Checked
end to end on the local server, 2026-10-17.)

## 4. Customer test app (device side)

The code is 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`.

`GET /j/<code>` — the public page the test QR opens (HTML). Opening it only marks the session
`opened`; nothing is bound. Three choices, in this order:
1. **Test in this browser — no install** → `/app/check/?code=<CODE>` (the browser check, §7).
   On an iPhone it says the app is Android-only and the Android options fold away.
2. **Install SwapUp Check** (the APK) + the steps to allow installs from the browser.
3. **Already installed? Open the app** (`swapupcheck://join?code=…&server=…`) and the code to type.
Anything not published says so instead of linking to a 404.

Links (`joinUrl`, `deepLink`, `downloadUrl`, `session.server`) are built from
`SWAPUP_PUBLIC_URL` (always set in production), else from the origin the request arrived on —
so a dev server reached through the web-app proxy (:4620) or a LAN IP hands out links a phone
can open.

`POST /api/device/join` `{ code, device: DeviceInfo, appVersion, installId }` →
`200 { ticket, session: { id, caseRef, storeName, plan, server, status, results, declared, identity, customerStarted } }`
- `code` may be a session's code, the demo code, or a store's counter code (§2c).
- `session.identity` (since 2026-10-17): `{ label, match: "exact"|"family"|"none", reason, variant, modelId, variants }`
  — SwapUp's `matchModel` on the phone's own model code ("Samsung Galaxy S22", "128GB"), for the
  Identify card. `reason` is the matcher's explanation. Never a price. `match: "none"` → the picker.
  `variants` (since 2026-10-17, the answer screen): the matched model's storage sizes, e.g.
  `["256GB","512GB"]` — always present, `[]` when no model matched (an older server sends none: read
  that as `[]`), and `[]` whenever the phone reported its disk size — even a size that isn't on the
  model's list (a 1TB Ultra on file as 256/512GB): the phone already answered, so the customer is never
  asked, and never offered only sizes the phone has ruled out. When `variant` is null and there is more
  than one size, the confirm card asks "How much storage?" and sends the size as
  `picked: { modelId, variant }` with `identityConfirmed: true`.
- `session.customerStarted`: true for a counter-code session — the app also asks for the customer's
  mobile number and name (both optional) and sends them with `declare`.
- `session.plan` depends on the app: SwapUp Check ≥ 0.6.0 (native, or `web-0.6.0`+) gets
  `battery_health` (after `battery`; not critical); an older app's plan has it taken out, so it sees
  exactly the 18 tests it always had.
- `installId`: a random id the app generates once and keeps; the session binds to the first
  installId that joins. A different installId on the same code → `409 "This code is already
  being used on another phone."` The same installId re-joining (app restarted) gets a fresh
  ticket for the same session (results kept).
- Unknown/expired code → `404 "That code is not valid any more. Ask the store for a new one."`
- Refused joins (404/409/400) are rate-limited per IP: 20 in 10 min → `429`. Successful joins
  and re-joins don't count — the app re-joins on every resume, and a whole store shares one
  public IP behind its Wi‑Fi.
- Once the store has **applied** the session, writes and re-joins are refused, but the old
  ticket still reads `GET /api/device/status` → `applied`; the app shows "The store has your
  results" rather than an error.

All calls below send `Authorization: Ticket <ticket>`:

`POST /api/device/declare` `{ screenCracked, backCracked, liquid, imei? }` — what the customer
says about things a phone cannot test on itself. `imei` optional (15 digits from *#06#).
SwapUp Check ≥ 0.6.0's Identify step adds, each optional:
`imei2` (the second IMEI; must differ from `imei`), `identityConfirmed` (`true` "Yes, that's my
phone" / `false`), `picked: { modelId, variant } | null` (from `GET /api/device/models`; must be a
model and storage on SwapUp's list → else `400 "Choose your phone from the list."`; stored with its
`label` and kept a **claim**), `customerName` (≤ 80 chars), `customerPhone` (a 10-digit Indian mobile
→ else `400`). Damage answers may be null. Each POST **replaces** the whole declaration. A field
the body doesn't carry is not stored, so an older app's declaration is unchanged. On a native app a
declaration with no damage answers reads "the app doesn't ask about damage", not "unanswered".
At **Apply** (`POST /api/test-sessions/<id>/apply`):
- `imei` fills an empty case IMEI, and the phone's other number fills an empty `imei2`. When the
  phone's IMEIs share no number with the case's, the case keeps its own and gets the flag
  "IMEI differs: …" in `camera.flags`.
- `picked` sets the model only when the phone's code matched nothing AND the case has no model, or
  already has that model — flagged "Model: customer picked … Check the model before pricing." (when
  it filled an empty case; audit `modelSource: "customer picked"`). The identity flag "…the customer
  said that isn't right…" is raised only when the customer picked a DIFFERENT model than the phone's
  code, or said "No" and picked nothing — "No" then the same model is agreement.
- **Storage** (`lib/domain/phoneLed.ts` `storageFromTest`; first match wins; audit `storage: {variant, source, measured}`):
  1. **measured** — the phone read its own disk, a size on the model's list: always used, however the
     model was named (code match or the customer's pick). A customer who picked the same model in another
     size gets the flag "Storage: the customer said X, the phone measures Y. The measurement is used."
  1b. the phone read a size that ISN'T on the model's list → nothing is patched, and no pick, single
     size or guess is used against the reading. Flag: "Storage: the phone measures 1TB, which isn't a size
     on file (the customer said 512GB — not used). Check Settings › About phone, and enter the Cashify quote
     on the full case if it's really 1TB." The reading is kept as `measuredStorage` (§3c).
  2. the case already has a size for that model → nothing is patched (a claim never overwrites).
  3. **catalogue** — the model comes in one size only.
  4. **customer** — the customer picked that model and a size on its list (on the confirm card, or in
     the picker) → used as a CLAIM, flagged "Storage: the customer said X — the phone couldn't measure
     it. Check Settings › About phone before the trade-in." Locking then needs `checks.storageSeen` (§3c).
  5. nothing → the answer screen asks with one row of priced chips (§3c).
- The new phone is suggested (§3c) unless staff already chose one (audit `upgrade: <deviceId> | null`).
- `customerName` / `customerPhone` fill the case's customer only where it is empty.

`POST /api/device/results` `{ results: [{ testId, outcome, detail?, at }] }` — batch;
idempotent per `testId` (the latest `at` wins). The app sends after every test and retries
its queue until acknowledged → `{ ok: true, received: n, progress }`.

`POST /api/device/complete` `{}` → `{ ok: true, summary }`.

`GET /api/device/status` → `{ status, progress, storeName, caseRef }` (lets the app show
"The store has your results").

### Phone-led flow (SwapUp Check ≥ 0.6.0 — `docs/PHONE-LED-FLOW.md`)

Identify › Scan › Test › Result, the phone moving itself. All Ticket-authenticated.

`POST /api/device/phase` `{ phase: "identify" | "scan" | "battery" | "test" | "done" }` → `{ ok: true }`
on each step change. Only the store's screen reads it (`TestSessionView.phonePhase`, the camera
card's line); anything else → `400`.

`GET /api/device/models` → `{ brands: string[] }` (most models first); `?brand=Samsung` (any case) →
`{ models: [{ id, brand, model, variants }] }`, newest first. SwapUp's own model list, no prices.

`GET /api/device/camera-link` → `{ url }` — **GradeIQ's own camera link** for this check
(`<GRADEIQ_PUBLIC_URL>/v2/cam/<gradeiq id>`, the full single pass, no `pass`), which the Scan
screen shows as a QR, exactly as GradeIQ v2 does. `409 "The camera check isn't ready yet."` while
the GradeIQ session is being made (ask again); `409 "…isn't running for this check…"` when camera
grading is off or failed. **This is the one device response that carries a GradeIQ id** — owner's
decision 2026-10-17: whoever holds the link can write to that GradeIQ session (photos, results,
grade) and open GradeIQ's `/report`, which shows GradeIQ's own price. Audited once per session
(`test_session.camera_link`). Older apps never call it.

`POST /api/device/battery` `{ image: "data:image/png|jpeg|webp|heic;base64,…" }` (≤ 3 MB as a data
URL, else `413`) → `{ healthPct: number | null, outcome: "pass" | "fail" | "skip" }`. The server
forwards it to GradeIQ's `/ocr` (call 7, `GRADEIQ-INTEGRATION.md`), reads `ocr.batteryHealth`, and
records the `battery_health` result itself: **≥ 80 % pass, below 80 % fail** (the `battery_drain`
fault — "Battery health 72 % (screenshot)" — which prices), nothing legible → `skip` (untested,
`healthPct: null`): show "Couldn't read it — try a clearer screenshot" and offer Skip. Up to
`GRADEIQ_OCR_TIMEOUT_MS` (30 s) — give this call a long client timeout. `409` while GradeIQ's
session is still being made ("still starting" — try again) or when camera grading is off/failed for
the session (skip the step); `503` when GradeIQ can't be reached (try again or skip); `400` not an
image data URL. The response is what THIS screenshot said. What is stored: a screenshot that couldn't be read
never wipes an earlier reading, and a new reading replaces the old one with the earlier figures kept
in `detail.earlier` (so the store sees a seller who tried several). Through `/api/device/results` the
phone may report `battery_health` only as `skip`/`unsupported`, and only while there is no reading —
a `pass`/`fail` from the phone, or a skip over a reading, comes back in `ignored`.

For a scan-first session the store's `grading` changes (§8): no `photosUrl`, and `message` follows
`phonePhase`.

**Photo check** (native app: the LAST step, after the tests — §8; changed 2026-10-16 so the
customer never waits for the store's camera). "Lay it on the counter, screen up": poll about
every 700 ms, show `pattern` full-screen, echo what is on screen. SwapUp Check ≥ 0.6.0 runs the same
screen FIRST, as its Scan step (after Identify), showing the camera-link QR while the pattern is
`idle` — same two endpoints, same escapes.

`GET /api/device/screen` →
`{ state, pattern, shown, cosmeticDone, handoffDone, capture: { verdict, code, reasons[], attempt } | null }`
- `state`: `disabled` or `failed` → skip the photo check and run the tests; `pending` → wait;
  `ready` → show `pattern` (`idle` | `white` | `black` | `red` | `green` | `blue` | `stripes`).
- `capture.verdict = "retake"` → the store's photos were rejected (show `reasons`; stay on the
  screen — the store retakes).
- Leave (to Done) when `handoffDone` is true, or 30 s after `cosmeticDone`; "Finish without photos"
  after 90 s with no store camera page (a NEW `connectedAt` — a page loaded after the screen mounted —
  a pattern request or a capture verdict counts as connected), or over a pattern left unchanged for 90 s.
- Two camera passes (2026-10-17, §8): the store's photos (pass 1) are usually taken BEFORE the phone
  joins, so `cosmeticDone: true` and a `capture` verdict may already be there when this screen mounts.
  Those are pass 1's — only a `cosmeticDone` / `capture` that appears or changes after the screen
  mounted counts as connected or starts the 30 s. `handoffDone` comes only from the screen check (pass 2).
- `connectedAt` (since 2026-10-17): GradeIQ's stamp of the last camera-page load; never cleared.
- Apply (`POST /api/test-sessions/<id>/apply`) answers **409** while the photos are in but the camera
  grade or LCD verdict is still being worked out (≤ 180 s from the later of the photos and the screen
  check); `grading.gradePending` says so.
- `503 { error }` → the server can't reach GradeIQ just now: keep the screen, keep polling.
- Never carries the GradeIQ session id or the camera URL (a ≥ 0.6.0 app gets the link from
  `GET /api/device/camera-link` instead).

`POST /api/device/screen` `{ shown: "<pattern actually on screen>" }` → `{ ok: true }`. The first
echo is what unlocks the store's camera button.

## 4b. Data clearing after acceptance (store side, via the desk case page)

After the customer accepts (case `locked`, or `in_pickup` while the phone is still at the store),
the customer factory-resets their own phone from its Settings and the store records what it saw:

`POST /api/cases/:id/action` `{ "action": "data_clear", "steps": { "accountsSignedOut": true, "resetDone": true, "setupScreenSeen": true, "noPreviousAccount": true }, "note": "optional, ≤200 chars" }`
→ the CaseView with `dataClear` `{label, steps, note, by, at}` and `dataClearState: "done"`.
Advisor / store manager only (403 otherwise); 400 lists unconfirmed steps; 409 if the case is not at the store
after acceptance or the record already exists. `dataClearState` is `done | attested | due | not_applicable`
(`attested` = an older case where the reset was ticked at hand-over). The record is always labelled
"Factory reset by the customer, seen by the store — not a certified erasure". The customer app only
shows the steps and opens Settings (Android `Linking.sendIntent`); nothing resets a phone remotely.

## 5. Downloads

`GET /downloads/swapup-check.apk` and `/downloads/swapup-store.apk` — served by Caddy from
`/home/ammar/swapup-downloads` in production (outside the app dir so deploys never delete
them). `GET /downloads` — a small page listing both with version and size.

## 6. Test → fault mapping (server, `lib/domain/diagnostics.ts`)

| Test id | Fail means | SwapUp fault |
|---|---|---|
| touch, multitouch | touch not responding | `touch_issue` |
| display | lines / spots / dead pixels | `display_lines` |
| mic | microphone faulty | `mic` |
| speaker, voice | speaker / earpiece faulty | `speaker` |
| camera | camera faulty (detail.side front/rear/both) | `rear_camera` / `front_camera` |
| buttons | side keys faulty | `buttons` |
| charging | not charging | `charging_issue` |
| battery | (fail only if the app measured a defect) | `battery_drain` |
| battery_health | health under 80 % on the battery screen's screenshot, read by GradeIQ (≥ 0.6.0; `POST /api/device/battery`) | `battery_drain` |
| flash, faceid, vibration, sensors, motion, connectivity, bluetooth, nfc | — | note only |
| declared screenCracked / backCracked / liquid | customer says so | `screen_cracked` / `back_cracked` / `water_damage` |

A skipped or unsupported test is **untested, never passed**. A critical test untested →
`verdict: "incomplete"`.

## 7. The browser versions (`/app/store/`, `/app/check/`)

Expo web exports of the same codebase (`swapup-mobile`: `bash scripts/export-web.sh store|check`
→ `dist-web/<app>/`, built with baseUrl `/app/<app>`). Production: `deploy/deploy.sh` uploads
them to `/var/www/swapup-web/<app>/`, Caddy serves them ahead of the app (SPA fallback to
`index.html`, hashed `_expo/static/*` cached for a year, a missing `/_expo/` file is a 404).
Locally: `node scripts/web-dev-proxy.mjs` in swapup-mobile → http://localhost:4620 (the apps,
everything else proxied to :4500); for `/j` and `/downloads` to offer them, symlink
`public/app → ../swapup-mobile/dist-web` (gitignored; deploy excludes it).

- **Which app:** `EXPO_PUBLIC_APP_VARIANT`, inlined at export (the URL path is the fallback).
- **Server:** the page's own origin. A `?server=` on another origin is ignored.
- **Store:** same staff API with a Bearer token kept in `localStorage`. *Continue pricing*
  calls `POST /api/auth/handoff` and opens the one-time URL (rewritten to the page origin) in a
  named tab `swapup-desk`, so the hand-off cookie lands on the desk's origin.
- **Check:** `/app/check/?code=K7M2QX` joins automatically, then strips `?code=` so a refresh
  resumes from `localStorage` (warning bar when the browser won't save). `appVersion` is
  `web-<version>`; the summary then adds the note "Tested in a web browser — …". Tests the browser
  cannot run are reported `unsupported` (untested, never passed). Device facts: model from UA
  client hints / user agent, battery on phones only; disk, RAM and physical-vs-emulator are null.
- **Never send** a Permissions-Policy that blocks camera, microphone, geolocation, motion
  sensors, Bluetooth or NFC on `/app/check/` — the tests need them.

## 8. Camera grading (GradeIQ underneath)

SwapUp Check is built on GradeIQ: every test session gets a GradeIQ session in the background
(server to server; `docs/GRADEIQ-INTEGRATION.md`). The **customer's phone** is tested
automatically — no extra questions — and its screen echoes the patterns the **store device's**
camera asks for; GradeIQ's AI vision grades cracks, scratches and the LCD from those photos.

**Two camera passes (2026-10-17, `docs/TWO-PASS-CAMERA.md`).** The screen sweep needs SwapUp Check
open on the customer's phone, which it can't be before the phone has joined — so the camera page is
split in two, and the counter runs: customer (found by mobile, §2b) → **photos** → Wi‑Fi + QR → the
phone downloads/opens SwapUp Check and tests itself → **screen check** → Apply → continue pricing.

1. **Take photos** — `grading.photosUrl` (`/v2/cam/<id>?pass=photos`): the exterior photos and the
   cosmetic grade. Offered as soon as `state` is `ready` and the session is `waiting`…`complete`;
   **not** gated on the phone (it needs nothing there). `grading.photosDone` once GradeIQ accepts them.
2. **Connect the customer's phone** — the Wi‑Fi QR, test QR and code (§3), then its tests.
3. **Check the screen** — `grading.screenUrl` (`/v2/cam/<id>?pass=screen`): the LCD sweep only, while
   the phone shows its photo screen. Same fail-closed lock (and override) as `cameraUrl`.
   `grading.screenDone` once an LCD verdict exists or the page reported it finished.
4. Watch `grading.assessment` → Apply (waits while `gradePending`).

Open both in Chrome (`Linking.openURL`, not the WebView: the page needs the camera, HTTPS and, on
Android, the torch). `grading.message` speaks to the two-pass states once the photos are in ("Photos
accepted — next, connect the customer's phone. The screen check comes after its tests."); before
that it explains the screen-check lock, so the photos card should carry its own copy.

**Phone-led flow (SwapUp Check ≥ 0.6.0, `docs/PHONE-LED-FLOW.md`; supersedes the two passes for
those phones).** The phone identifies itself, then its Scan screen shows **GradeIQ's camera link as a
QR** (`GET /api/device/camera-link`, §4) — the tablet's camera app scans it and runs the **single
pass** (photos, dark front glass, screen sweep, Settings photo → `handoffDone`), GradeIQ v2's own
await2nd handoff, with no GradeIQ change. The camera grade is worked out while the phone then tests
itself. For such a session (`TestSessionView.scanFirst`):
- `grading.photosUrl` is **null** — no photos before the phone joins. `cameraUrl` is the "Take photos"
  fallback on the tablet, behind the same fail-closed lock (the phone echoes `idle` while it shows
  its QR, so it unlocks then).
- `grading.message` follows `phonePhase`: "The customer's phone is identifying itself…", "…is showing
  its scan code — scan it with your camera, or Take photos.", "…is testing itself — the camera grade
  is being worked out." (or the grade, once settled). `cameraLocked` says why in the same terms.
- Before the phone has joined nothing is known about it, so the view is today's (`photosUrl` may be
  offered). A SwapUp Store ≤ 0.5 tablet with a ≥ 0.6.0 phone gets no `photosUrl` after the join and
  must use `cameraUrl` / `screenUrl`.
Older Check apps: unchanged.

SwapUp Store ≤ 0.4.x (single pass): wait for `grading.deviceReady` → **Take photos** opens
`grading.cameraUrl` (photos, sweep and Settings photo in one go) → Apply. Unchanged; an app that gets
no `photosUrl` from the server (an older server) falls back to it.

```ts
type GradingView = {
  state: "disabled" | "pending" | "ready" | "failed";
  message: string;                 // one line for the top of the card
  error: string | null;
  canRetry: boolean;               // show Retry → POST …/grading-retry
  deviceReady: boolean;            // the customer's phone is echoing patterns
  cameraConnected: boolean;
  cameraUrl: string | null;        // GradeIQ /v2/cam/<id>, the single pass — ONLY when deviceReady (or overridden). SwapUp prints it in no QR; a ≥ 0.6.0 phone shows the same link as its own scan code (§4)
  photosUrl: string | null;        // /v2/cam/<id>?pass=photos — as soon as state is ready and the session is waiting…complete; no device gate; never in a QR; null once a scan-first phone has joined
  screenUrl: string | null;        // /v2/cam/<id>?pass=screen — same gate as cameraUrl; never in a QR
  cameraLocked: string | null;     // why cameraUrl / screenUrl are locked
  canOverride: boolean;            // offer "Start without the customer's phone" → …/camera-override {reason}
  override: { by: string; reason: string; at: string } | null;
  screenReadable: boolean;
  pattern: string | null; cosmeticDone: boolean; handoffDone: boolean;
  photosDone: boolean;             // the photos were accepted (pass 1, or the single pass's photos)
  screenDone: boolean;             // the screen check ran: an LCD verdict exists, or the camera page finished
  capture: { verdict: string; reasons: string[] } | null;   // e.g. "retake" + reasons
  sync: { state: "idle" | "in_sync" | "sending" | "retrying"; error: string | null; forwardedAt: string | null };
  outOfSync: boolean;              // show "GradeIQ out of sync, retrying" — SwapUp's own results stay authoritative
  assessment: AssessmentView | null;
  disagreements: { topic: "screen"|"back"|"display"|"identity"; customer: string|null; tested: string|null;
                   camera: string; final: string; message: string; photoIndex: number|null; box: Box|null }[];
  timedOut: boolean;               // stopped waiting: 180 s after the LATER of the photos and the screen check
  gradePending: boolean;           // photos in, grade or LCD verdict still being worked out — Apply waits
  syncedAt: string | null;
};
type AssessmentView = {
  final: boolean; provisional: boolean; status: "none"|"grading"|"provisional"|"final"|"failed"; reasons: string[];
  grade: string | null;            // Premium/A/B/C/D — shown, NEVER priced; null = not camera-graded
  conclusive: boolean | null; gradeRange: { best: string; worst: string } | null; needsHumanReview: boolean;
  coverage: number | null; score: number | null; tierUsed: "stub"|"flash"|"pro"|null; visionModel: string | null;
  functionalGrade: string | null;  // GradeIQ's Working/Faulty — display only; `summary.verdict` is the authority
  components: { id: "front"|"back"|"frame"|"cameras"|"display"; label: string; grade: string|null; confidence: number|null; findings: number }[];
  findings: { component; componentLabel; type; label; severity; confidence; confirmed: boolean;
              photoIndex: number|null; photoUrl: string|null; box: [ymin,xmin,ymax,xmax]|null; location: string|null;
              meaning: string|null;           // in SwapUp's words, e.g. "Cracked glass"
              effect: "fault"|"condition"|"suggested"|"flag"|"none" }[];
  faults: { id: FaultId; because: string; component; confidence; photoIndex; box }[];    // added at Apply (source camera_ai)
  suggested: { id: FaultId; because: string; … }[];   // shown, never added (frame_damage, cracked lens)
  floor: { screen: ScreenState; body: BodyState };   // the condition may be recorded worse, never better
  flags: string[];                                    // weaker sightings, "LCD not camera-checked", review notes
  displayCheck: { verdict: "pass"|"fail"|"unknown"; confidence; note; findings[]; patterns[]; captures[]; requested[]; missing[]; reason } | null;
  lcd: { cameraChecked: boolean; verdict: "pass"|"fail"|"unknown"|null; reason: string|null };
  obstruction: { present: boolean; type: string; note: string } | null;   // a case on the phone → grade not used
  oem: { verdict: string; confidence: number|null; evidence: string[] } | null;
  identity: { verdict: "match"|"mismatch"|"unverified"; reasons: string[]; device: { make, model, match, reason } | null };
  photos: string[]; fetchedAt: string | null;
};
```

Rules the server enforces:
- **Camera lock fails closed.** `cameraUrl` and `screenUrl` are null until GradeIQ's `/screen`
  reports the customer's phone echoing (`shown` is a string). Unreadable `/screen` → `cameraLocked`
  says so; only `camera-override` with a reason unlocks them, and the LCD is then "not
  camera-checked". `photosUrl` has no such lock: the photos need nothing on the phone.
- **The pull window** (the session pulled every 5 s for a final grade and the LCD verdict) runs
  180 s from the LATER of the photos being accepted and the screen check finishing — with the photos
  first, the screen check comes minutes later and would otherwise never be pulled. No photos, no window.
- **Only confirmed damage changes the case:** confidence ≥ 0.7, corroborated, located with a box,
  from a FINAL grade (a grade letter, a real model tier, no refinement running, photos accepted,
  no case on the phone). Weaker sightings are flags. A provisional grade is never applied.
- **The camera only makes things worse** and never downgrades a customer's damage declaration.
- **Identity mismatch blocks the quote** (`CaseView.quoteBlocked`, no partner quote) until a
  **store manager** sends `PATCH /api/cases/<id>` `{ cameraOverride: { identity: true, reason } }`.
- **Recording the phone better than the camera confirmed** (removing a `camera_ai` fault, or a
  better screen/body answer) → `409` unless the PATCH carries `cameraOverride: { reason }`; the
  name and reason are stored in `CaseView.camera.overrides`.
- No grade ever comes from anywhere else: no demo grade, no fallback, no switch for one.
  `GRADEIQ_ENABLED=0` is a labelled kill switch (`state: "disabled"`, condition by eye).

Case fields (`GET /api/cases/<id>`): `faultSources` (`{ [faultId]: ("tested"|"declared"|"camera_ai"|"advisor")[] }`),
`camera` (what the camera saw, written at Apply: grade, final, floor, faults, suggested, flags, lcd,
lcdOverride, identity, identityOverride, overrides, devicefax), `quoteBlocked`. The DeviceFax JSON
(photo URLs on the public GradeIQ origin) is kept on the test session for staff only.
