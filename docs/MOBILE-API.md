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

**Words on screens.** Every sentence the server sends for a screen — errors, asks, reasons, notes,
flags — is ONE short sentence (≤ 15 words; a title ≤ 6), with the number carrying the meaning, and it
names no buyback partner. The apps print them as sent; shorten them at the source.

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
the same answer the app shows (§3c) — refurb quote vs trade-in + bonus. The case page shows one step
at a time, in the store app's order — Phone → What's wrong → The answer (→ Take the trade-in, after
"Swap up") — with Back / Next at the bottom; the Repair quote and the Trade-in are the answer's own
pages, opened from its asks and "Change" links (Back returns to the answer). A `#step-…` anchor opens
that step or page instead: `#step-phone`, `#step-faults`, `#step-repair`, `#step-tradein` (also
`#step-upgrade`), `#answer`, `#step-lock`. Without one, a tested case (SwapUp Check or an attached
Phonecheck report) and `?view=answer` open on the answer; an untested one on its first unanswered step.

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

## 2d. The IMEI first (store side, since 0.9.0 — owner 2026-10-19: *"Scan IMEI first"*)

The IMEI is now **step 1** of a trade-in: the customer dials `*#06#`, the advisor scans it, reads the
screen, or types it — before the mobile number and before any test. It is resolved ONCE per case
(`lib/server/imeiResolve.ts`): the model from its type code (free, offline) and GradeIQ's lookup —
the GSMA blacklist and the maker's model number (one paid lookup per trade-in). Lock's own IMEI card
stays as the fallback ("Skip — scan at hand-over").

**Store-led order:** `POST /api/cases {customerName, customerPhone}` → `PATCH /api/cases/<id>
{imei, imei2}` → (409 / blacklisted? stop) → `POST /api/test-sessions {caseId}`. Skipped IMEI → today's
`POST /api/test-sessions {customerName, customerPhone}`. Phone-led (counter QR): the same card on the
Session screen, `PATCH` on the session's existing case.

`POST /api/imei/read` (Bearer, advisor / store manager) — "Read the screen"
`{ "photo": "data:image/jpeg;base64,…" }` → SwapUp's server sends it to GradeIQ's stateless reader
(`POST /api/imei/ocr`, ~20 s; never a session's `/ocr`). Nothing is saved: show "Read: 35… — confirm".

| Status | Body |
|---|---|
| 200 | `{ "imei": "35…" \| null, "imei2": "35…" \| null, "valid": true \| false }` — `valid` = the IMEI's check digit |
| 503 | `{ "error": "The screen reader is off — scan or type the IMEI.", "reason": "reader_off" }` (GradeIQ's AI refused, no key, slow, down, or GradeIQ switched off) |
| 422 | `{ "error": "No IMEI found in that photo — try again or type it.", "reason": "not_found" }` |
| 400 / 413 | not a `data:image/…;base64` photo / larger than 8 MB of base64 |

`PATCH /api/cases/<id> { "imei": "…", "imei2": "…" | null }` (as before) now also resolves a NEW IMEI
synchronously (≤ 10 s) and answers with the whole `CaseView`. The same IMEI saved again → no new lookup
(an IMEI the case had before is answered from the case). An IMEI that fails its check digit is saved as
before (`imeiCheck: "invalid"`) but not resolved — a misread is never paid for. GradeIQ off
(`GRADEIQ_ENABLED=0`), no `GRADEIQ_SERVER_KEY`, or no answer in 10 s → the type code's model only and
`blacklist: "unknown"`, with no retry. The model is set ONLY when the case has none (or one an earlier
IMEI set); never the storage. A NEW `imei` with no `imei2` in the patch clears the case's IMEI 2 (it
was the other phone's; saving the IMEI 1 the case already has keeps it). An `imei` equal to the case's
IMEI 2 with no `imei2` in the patch → `400 "IMEI 1 can't be the same as IMEI 2 — that number is this
case's IMEI 2."` (not looked up); send both numbers to swap them.

```ts
CaseView += {
  modelSource: "imei" | "phone" | "customer" | "phonecheck" | "advisor" | null;
    // where the model came from: the IMEI, the phone's model code at Apply, the customer's pick (a claim),
    // a Phonecheck report, staff; null = no model, or a case from before 0.9.0
  imeiLookup: { brand: string | null; model: string | null; modelNumber: string | null;
                blacklist: "clean" | "blacklisted" | "unknown"; source: string; at: string } | null;
    // the case's CURRENT IMEI, resolved; "unknown" shows as "Blacklist not checked", never as clean.
    // blacklist is "blacklisted" whenever GSMA said so for ANY IMEI ever saved on the case — moved
    // to IMEI 2 by a re-scan, or replaced: the stop is the case's, and sticky (IMEI 2 is never
    // looked up on its own — one paid lookup per new IMEI 1, as before).
    // source: GradeIQ's ('esn'|'station'|'gsma'|'tac'|'stub'), or SwapUp's own "tac" / "none" when
    // GradeIQ wasn't asked or didn't answer. null = no IMEI, an invalid one, one from before 0.9.0
  imeiWarnings: string[];
    // at once, while the case is at the counter (the lock still decides):
    // "This IMEI is already on trade-in SU-AND-00031."
    // "The IMEI says Samsung Galaxy S23 Ultra; the case has Samsung Galaxy S23 — check Settings › About phone."
    // "IMEI 2 (35…) is reported lost or stolen (GSMA)."  /  "IMEI 35…, saved on this case before, is
    // reported lost or stolen (GSMA)." — the blacklisted number when it isn't in the IMEI 1 slot
  kymEarly: { status: "clear" | "blacklisted" | "duplicate" | "in_use"; reference: string | null } | null;
};
// Partners: imeiLookup = null, imeiWarnings = [].
```

`PATCH /api/cases/<id> { "kymEarly": { "status": KymStatus, "reference": string | null } }` records the
government KYM answer right after the IMEI (`Text KYM to 14422`, then the chips); `null` clears it. It
needs an IMEI on the case (`400 "Record the IMEI first (dial *#06#)."`), is stored with the advisor's
name, and goes when either IMEI changes. Lock pre-fills its KYM chip and reference from it — still
editable, still required to be `clear` at lock. The lock's own KYM answer (`checks.kym`, which must be
`clear`) supersedes `kymEarly` — a mis-tap there is corrected at the lock — and is stored back as
`kymEarly` for the record. GSMA does not cover India's CEIR: KYM stays mandatory.

**Blacklisted** (`imeiLookup.blacklist === "blacklisted"` — for any IMEI the case ever had — or
`kymEarly.status !== "clear"` when set):
`POST /api/test-sessions { caseId }` → `409 { "error": "This phone is reported lost or stolen. It can't be
traded in.", "reason": "blacklisted" }` and no session is made. On GSMA's `blacklisted` the lock refuses
with the same sentence (and the reason) whatever it sends, and it is the first of `lockBlockers`; a
non-clear `kymEarly` is not a lock blocker — the lock's own KYM answer decides. Show the sentence in a
red banner on the IMEI card and disable Start.

**The model at the phone:** a case whose model the IMEI named (`modelSource: "imei"`) is what the join
tells the phone (`identity.match: "exact"`), so an iPhone or a browser — which can't name itself — skips
the customer's picker; the storage is still asked when the phone can't measure it, and when it did
measure, Apply settles that model's storage from the reading (`variantSource: "measured"`) — no pick is
needed. Any other case (no IMEI, or a model staff, the phone or the customer named) joins exactly as
0.8.0: the phone's own answer, the picker when its code names nothing. The phone's own model
code still wins when it matched, except against a model the IMEI named: at Apply a code that disagrees
is a flag in `camera.flags` (`Model: phone code says Samsung Galaxy S23; the IMEI says Samsung Galaxy
S23 Ultra — check Settings › About phone.`), never an overwrite. A code that agrees makes
`modelSource: "phone"`.

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
poll also drives the camera-grading pulls from GradeIQ (§8) — throttled on the server — and **the
answer by itself** (below): when the session is `complete` and everything is in, this read puts the
results on the case first (as the polling advisor; it waits up to 4 s) and already answers `applied`.

**The answer, by itself** (owner, 2026-10-17: *"Reduce the flow"* — `lib/domain/autoApply.ts`).
SwapUp Store never taps Apply on the way to the answer. The server applies the session — the same
`applyTestSession`, every gate unchanged — once the phone has posted `complete`, the store camera's
grade is no longer pending (`cameraGradePending`), and, where the camera couldn't decide the screen
or the body, the advisor has tapped every row of "Check the phone" (§8b; applying first would end
the phone's test colours, and the answer's numbers would move after the customer saw them). It is
tried from the staff poll above, from `POST /api/device/complete`, and from the phone's own
`GET /api/device/status` poll (then recorded as the advisor who started the trade-in), so the case
is ready even with nobody on the Session screen. Audit `test_session.apply` carries `auto: true`.
`TestSessionView.autoApply` (staff only) says where it is:
`{state: "waiting", for: "tests"|"camera"|"certify", text}` · `{state: "ready"}` (being applied) ·
`{state: "refused", reason}` — Apply said no (e.g. "The case is past the counter, so the results
can't change it any more."); show the reason and a **Retry** (= `POST …/apply`); it is not tried
again until the session or its case changes · `{state: "applied"}` → open the answer ·
`{state: "off"}` (expired / cancelled). An older server sends no `autoApply`: show "Apply to case".
`GET /api/test-sessions?open=1` (Bearer) → `{ sessions: TestSessionView[] }` for the store
(grading from what is stored; no GradeIQ calls).
`POST /api/test-sessions/<id>/apply` (Bearer) — the manual Apply: the Retry after a refusal, "Apply
the results so far" for a phone that stopped mid-test (never held by "Check the phone"), or an older
server. It applies the mapped model, storage, the tested
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
recorded with the staff member's name. A screen sweep that then runs to the end still counts (its
frames prove the loop); if none runs, the LCD is recorded as not camera-checked at Apply. It also
releases the phone's Scan step (as below) — the one way an older SwapUp Store with no release
button lets a SwapUp Check ≥ 0.8.0 phone go on.
`POST /api/test-sessions/<id>/release-scan` (Bearer, no body) → `TestSessionView` — let the
customer's phone go on from its Scan step **without the camera**, by the signed-in staff member's
name (audited `test_session.scan_release`). The customer is never offered a skip: the phone stays
on Scan until the camera finishes (`handoffDone`) or this is pressed; `GET /api/device/screen` then
says `released: true`. `409` before the phone has joined. Offer it when `grading.canRelease`.
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
  scanFirst: boolean;                  // the joined phone is ≥ 0.6.0 (native or web-0.6.0+): it leads — Scan › Test › Done
  phonePhase: "identify"|"scan"|"battery"|"test"|"done"|"colours" | null;   // what the phone last said (POST /api/device/phase)
  phonePhaseAt: string | null;
  customerStarted: boolean;            // started from the store's counter code (§2c)
  imeiAgreement: "match"|"differs"|"unknown" | null;   // the phone's IMEI(s) vs the case's (no shared number = differs); staff only
  certify: CertifyBlock | null;        // "Check the phone" (§8b) — staff responses only
  autoApply: { state: "off" } | { state: "waiting"; for: "tests"|"camera"|"certify"; text: string } | { state: "ready" }
           | { state: "refused"; reason: string } | { state: "applied" } | null;   // the answer by itself (above) — staff only
};
type CertifyBlock = {
  needed: ("screen"|"body"|"liquid")[];   // the rows to show: screen when the camera's sweep didn't check it or its grade isn't final; body when it isn't final; liquid on that same card. [] when the camera decided both — no card
  rows: Record<"screen"|"body"|"liquid", { value: string; label: string; by: string; at: string; withColours: boolean } | null>;   // certified so far (the case's)
  choices: Record<"screen"|"body"|"liquid", { value: string; label: string }[]>;   // each row's chips, word for word, in order
  colours: "showing" | "waiting" | "old_app" | "off";   // the test colours on the customer's phone: showing now / waiting for the phone (≥ 0.8.0 shows them on its result screen) / an app before 0.8.0 can't / not needed
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
buy vs sell — the same four lines on the desk's case page ("Store margin · staff only", under the
answer) and in the store app
(`lib/domain/buySell.ts` is the reference implementation).

**Since 2026-10-17 this is the store's margin, staff only.** In the store app the card sits in a
collapsed "Store margin · staff only" row at the bottom of the answer screen (§3c), closed by
default; its box is relabelled **"Store's refurb cost"** (it was "Refurb cost · your quote" in the
app and "Refurb cost (quote)" on the desk), so it can't be confused with the answer's **Refurb
quote** — the CUSTOMER's repair price. The figures and the logic below are unchanged.

| Line | From the case (`GET /api/cases/<id>`) |
| --- | --- |
| Buy — pay the customer | `quote.amount` when `quote.status === "priced"` — the case quote, whichever source priced it (§3c "Where the trade-in comes from") |
| Store's refurb cost | `refurbCost.amount`, else `repair.listTotal ?? repair.customerPays` when `repair.status === "quoted"`, else ₹0 when `faults` is empty |
| Sell — after refurb | `marketSell.amount` (PriceIQ's refurbished-market listing less 2–5%), else `repairedQuote.amount` when `repairedQuote.status === "priced"` |
| Margin | Sell − Buy − Refurb, only when all three are known (negative = a loss) |

`marketSell` is `{ amount, listing, markdownBp, grade, gradeWanted, listings, week, ageDays, stale, note, why: null, source }`
or `{ amount: null, why, source }` (`source: "PriceIQ · refurbished market"`). `listing` is the
lowest refurbished-market listing at `grade` for that model + storage, from PriceIQ's live
`/api/market-grades` (server to server; the app never talks to PriceIQ); the markdown is 5% up to
₹15,000, 4% up to ₹30,000, 3% up to ₹50,000, 2% above (`lib/domain/marketSell.ts`). Market data over
14 days old is priced with `stale: true` and `note` "Refurbished market price, week 2026-W35, 52 days
old."; over 90 days old there is no price; PriceIQ unreachable → the last good answer with `note`
"PriceIQ unreachable, last answer 2026-10-18 08:30 UTC.". `grade` is the grade the phone comes out at after
refurb (`gradeAfterRefurb`); when the market lists none at it, the next lower listed grade is used
and `gradeWanted` keeps the one it should have been. Show it in one line under the sell price, the
same on the desk and the tablet (`lib/domain/buySell.ts` `marketSource`): "Refurbished market price
₹21,999 (Good) − 4% · PriceIQ", plus " · none at Superb" when a lower grade was used; the partner's
repaired price is "Partner's repaired price". The refurb box's reasons are the same words in both
apps: "Needs a look on the bench — enter your refurb cost.", "No repair price for this phone — enter
your refurb cost.", "No repair estimate yet — enter your refurb cost."

**Screens never name the buyback partner company** (owner, 2026-10-17): they say "the partner" or
print the partner's name the server sends (`quote.partner`; the demo programme's is "Buyback
Partner (demo)").

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

## 3c. The answer (`offer`) — refurb quote vs we pay + bonus

Owner, 2026-10-17: "Why asking questions when we have all tested data ... just refurb quote vs bonus
+ trade in price." 2026-10-18: "Current grade C. Market price for grade C is ₹25000 … We pay you
₹27000 + ₹10000 bonus if you exchange with a new device." After Apply the case carries **one
answer**, worked out on the server (`lib/domain/offer.ts` `buildOffer`, from the stored rows:
`cases.ts offerFor`) and printed the same way by the store app's answer screen, the desk's answer
card and the customer's phone (`offer.answer.lines`, below). The app never invents a word: it prints
these strings and owns only its labels.

| Label | Figure |
| --- | --- |
| **Refurb quote** | What the CUSTOMER pays to fix it: `repair.customerPays` from the price book, or the bench / service-centre quote (`manualRepair`), or ₹0 when covered. The figure `decide()` compares and the bonus's repair-ratio rule reads. **Never** the store's `refurbCost` (§3b). |
| **Market price** M | What the buyback partner pays for this phone in this condition — the case quote (below). The store's credit line holds M at lock; the partner pays M back. |
| **We pay you** W | M + the **SwapUp premium** P (`lib/domain/premium.ts`): 5% of M up to ₹15,000, 4% to ₹30,000, 3% to ₹50,000, 2% above, floored to the rupee — and never less than the band edge below pays (so W never falls when M rises: ₹15,001 → ₹15,750, as ₹15,000). Programme-funded like the bonus: a claim on `/admin/claims`, never a hold, never a chargeback. |
| **+ bonus** | The upgrade bonus for the new phone (its basis is M, never W). |

The verdict is `decision.headline`. `RULESET_VERSION` is **`2026-10-18.1`**: `decide()`'s as-is value
is what the customer is paid, W = M + P (a caveat says the premium comes only with a new phone); the
bonus is shown and never a reason. An open case whose stored decision has an older version is
re-decided once by the desk and the store app (`{action:"reprice"}` without `requote` — the partner is
not asked again).

### Where the trade-in comes from (`quote.source.kind`, since 2026-10-18)

Owner: *"price compare from price iq based on grade ...deduct based on % of failure or defects."*
2026-10-18: PriceIQ live, one 5%→2% markdown everywhere, SwapUp's % per defect, no sample prices,
never a made-up price. 2026-10-19 (0.9.1): never a typed one either — the price is the system's, and
staff change it only by changing the conditions (what's wrong, screen/body, issues, comes-with, age).
`reprice` asks in this order (`lib/server/tradeIn.ts`); the first that prices is the case `quote`, and
the lock holds exactly that amount on the store's credit line:

1. `priceiq` — PriceIQ's lowest refurbished-market listing for the model + storage at the phone's
   grade (rule G1 on the screen and body; none at it → the next LOWER grade, named), less the
   markdown (5% up to ₹15,000, 4% to ₹30,000, 3% to ₹50,000, 2% above — the sell price's own), less
   SwapUp's % for each defect (`DEFECT_DEDUCTIONS`), combined as a rate card combines them: each % of
   the listing, floored; capped at 85%; never below 6%; rounded down to ₹10. Asked live
   (`GET /api/market-grades`, cached an hour; a quote waits ≤ 6 s). Data over 14 days old prices with
   its age (`priceiq.stale`, `priceiq.note`); over 90 days old is no price; PriceIQ unreachable → the
   last good answer, `priceiq.note` "PriceIQ unreachable, last answer …". Scratches, scuffs, dents
   and a bent frame are the grade's — never deducted again. Defects: lines / cracked / dead screen,
   cracked back, won't switch on (priced on that alone), no calls, and each failed function (touch,
   battery, charging, cameras, speaker, mic, Wi-Fi/Bluetooth, fingerprint, buttons, vibration,
   liquid). Accessories and age are not defects. Full rules: `docs/GRADING.md` §6.
2. `partner_ratecard` — the partner's uploaded rate card. When PriceIQ was asked first and had no
   price, the quote says why in `priceiqWhy`. Since 2026-10-19 a card may price each grade
   (CSV `model_id,variant,max_price,good_price,fair_price,best_value_price`, the last three optional,
   max ≥ good ≥ fair ≥ best value per row): a row with grade prices prices the phone at its look's
   grade (A = max, B = good, C = fair, D = best value; an empty column → the next LOWER grade listed,
   none → max less the card's look %), takes no look off again and every other deduction once (a
   grade's price with nothing taken off is used exactly — the card's ₹10 step rounds only what it
   worked out: W42's grade B S23 Ultra 256GB is ₹33,574), and the
   quote carries `grade` (the grade the price is for; its first line reads "Market price grade C ·
   <card label>"). A 3-column row prices as before.
3. `none` — nothing priced it: `status: "unpriced"`, and `reason` is the specific why: an active card
   that doesn't list the phone → "This phone isn't on the rate card yet."; else PriceIQ's own why when
   it was asked; else "No rate card is active yet." (and `priceiqWhy`). The answer heads it "No market
   price yet" and says the reason under it, once.

A quote stored by an older build from a source that no longer exists is treated as expired on an
open case (`quoteExpired: true`) and re-asked. `partner_manual` (a quote 0.9.0 and older let staff type
in) stays a kind so its history still reads, but nothing writes it and an open case re-asks it.
`reprice` also re-asks a quote that is not priced (and storage chips none of which is priced), so a
rate card uploaded later reaches every open case on its next re-price — the desk's and the Store
app's quiet once-per-open re-price included.

**`PATCH {partnerQuote}` is refused** (since 0.9.1): anything but `null` → 400 "Prices can't be typed in
— change what's wrong to change the price.", before the case is read (nothing of the patch is saved, no
IMEI lookup). `{partnerQuote: null}` is accepted and changes nothing. Old Store builds that still send it
show that sentence.

```ts
type PartnerQuote = {
  status: "priced" | "unpriced" | "error"; amount: number | null;
  lines: { label: string; bp?: number; amount: number }[];   // they sum to amount
  source: { kind: "partner_manual" | "priceiq" | "partner_ratecard" | "none"; label: string; rateCardId?: string; effectiveFrom?: string };
  partner: string; partnerRef: string | null; quotedAt: string; validUntil: string | null; reason?: string;
  priceiq?: {                         // source.kind "priceiq"
    grade: "Superb" | "Good" | "Fair" | "Best Value"; gradeWanted: same;   // differ when a lower grade was used
    listing: number; markdownBp: number; defects: number;
    deductions: string | null;        // "SwapUp's % per defect" (null on a repaired value with none)
    week: string; listings: number;   // listings = PriceIQ's distinct prices at that grade
    ageDays?: number; stale?: boolean; // the market data's age when priced; stale = over 14 days
    note?: string | null;             // its age and/or "PriceIQ unreachable, last answer …"
  };
  priceiqWhy?: string;                // PriceIQ was asked first and had no price: why
  grade?: "Superb" | "Good" | "Fair" | "Best Value";   // a rate-card row with grade prices: the grade priced
};
```

A `priceiq` quote's `source.label` is "PriceIQ · Good − defects" ("PriceIQ · Good" with none); its
`lines` are the base ("Refurbished market price (Good) · PriceIQ"), "Below the market price" with its
bp, one line per defect (its name and bp), then any "Deductions capped" / "Raised to the card's
minimum for this model" / "Rounded down to ₹10". Beside it, `repairedQuote` is PriceIQ at the grade
after refurb less the same markdown and any defect the repair doesn't explain ("PriceIQ · Good after
refurb"). A partner gets a PriceIQ quote as one "Trade-in" line (no
`priceiq`, no `priceiqWhy`) and no PriceIQ `repairedQuote`, no `decision`, no `repair`. It is valid for 3 days (or the programme's `quoteValidityDays`), re-quoted
on expiry like a rate-card quote; storage chips are priced the same way, asked together.

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
  tradeValue: number | null;       // the market price M frozen at lock (what the line holds)
  premiumValue: number | null;     // since 2026-10-18: the SwapUp premium frozen at lock; null before lock,
                                   // on a case locked before premiums (paid M only), and for the partner
  // The partner also gets payable: null and upgrade.price: null — with them the premium could be worked out.
};

type VariantSource = "measured" | "catalogue" | "customer" | "advisor";
type OfferAsk =
  | { kind: "blocked";       title: string; text: string }
  | { kind: "model";         title: string; text: string }
  | { kind: "storage";       title: string; text: string;
      options: { variant: string; tradeIn: number | null }[];   // [] = no chip can be right (below)
      note: string | null }                                     // the chips' market data age / "PriceIQ unreachable, …" | null
  | { kind: "no_price"; title: string; text: string }   // text only — no control (0.9.0 and older: "partner_quote")
  | { kind: "repair_quote";  title: string; text: string }
  | { kind: "new_phone";     title: string; text: string };

type Offer = {
  open: boolean;                          // status is draft or quoted
  headline: string;
  reason: string | null;                  // one sentence under the headline
  recommendation: Recommendation | null;  // decision.recommendation (null when no decision)
  recommended: "repair" | "swap" | null;  // repair→"repair"; upgrade|no_repair→"swap"; either|cannot_say→null
  asks: OfferAsk[];                       // ordered: blocked, model, storage, no_price, repair_quote, new_phone
  storage: { variant: string | null; source: VariantSource | null; note: string | null };
  repair: {                               // THE refurb quote
    amount: number | null; covered: boolean; basis: "book" | "manual" | null;
    detail: string | null; why: string | null; nothingToRepair: boolean;
    coverage: "none" | "warranty" | "care_plus";
  };
  swap: {
    tradeIn: number | null; tradeInNote: string | null;   // tradeIn = the market price M (locked: trade_value)
    premium: { amount: number; bp: number } | null;       // the SwapUp premium on M; null without M, or locked before premiums
    wePay: number | null;                 // M + premium; null when tradeIn is null
    bonus: number | null; bonusBp: number | null; bonusWhy: string | null;
    total: number | null;                 // wePay + (bonus ?? 0) — CHANGED 2026-10-18 (was tradeIn + bonus)
    why: string | null;                   // why tradeIn is null
    tradeInDetail: {                      // how the trade-in was reached; null when tradeIn is null
      line: string | null;                // PriceIQ only, under the figure: "Refurbished market price ₹51,399 (Good) − 2% − 2 defects · PriceIQ 2026-W35" (+ ", 52 days old" over 14 days)
                                          //   (+ " · none at Superb" when a lower grade was used)
      lines: { label: string; pct: string | null; amount: number }[];   // behind a closed "Show details":
                                          //   PriceIQ from the markdown on (its base is in `line`); a rate card
                                          //   from its best-condition price; [] for a single-figure quote
      note: string | null;                // priceiqWhy — why PriceIQ didn't price it
    } | null;
    newPhone: { deviceId: string; label: string; price: number; suggested: boolean; why: string | null } | null;
                                          // label = model + storage, no brand ("Galaxy S26 Ultra 256GB");
                                          // the CaseView's upgrade.label keeps the brand
    customerPays: number | null;          // new phone − wePay − bonus (premium.ts exchange — what the lock charges;
                                          //   locked: payable); null when the new phone costs less than wePay + bonus
    vsRepair: number | null;              // customerPays − the refurb quote (+ = the swap costs more today)
  };
  actions: { repair: string | null; swap: string | null; walkAway: string | null }; // null = allowed, string = why not
                                          // swap: "The new phone costs less than we pay plus the bonus — choose another phone."
                                          //   when it does (the lock refuses it too; nothing is floored)
  signals: { text: string; points: "repair" | "upgrade"; strength: "strong" | "soft" }[];
  caveats: string[];
  answer: Answer;                         // since 2026-10-18 — the lines every screen prints (below)
};
```

### The answer's lines (`offer.answer`, since 2026-10-18 — `lib/domain/answer.ts`)

Every screen prints `lines` **as sent**, in order, each as `text` and, when `note` is set, ` · note`
in muted ink. Staff screens add their own extras under the line they belong to (the grade report
under `grade`, how the price was reached under `market`, `staffNotes` and the new phone under
`we_pay`/`bonus`, the repair detail under `repair`); they never print a figure the lines already carry.

```ts
type AnswerLine = { key: "grade" | "market" | "we_pay" | "bonus" | "repair"; text: string; note: string | null; amount: number | null };
type Answer = {
  ready: boolean;                 // the CUSTOMER may see the figures (staff print lines whatever this says)
  text: string | null;            // the customer's one sentence when !ready; null when ready
  final: boolean;                 // the case has left the counter: the figures are the ones locked (or last shown)
  headline: string;               // the customer's headline (staff keep Offer.headline)
  grade: { letter: "A"|"B"|"C"|"D"; word: "Superb"|"Good"|"Fair"|"Best Value"; note: string | null } | null;
  market: { amount: number; letter: …| null; word: … | null; source: string } | null;  // letter/word = the grade the line names
  premium: { amount: number; bp: number; rule: string } | null;                       // rule "2026-10-18.1"
  wePay: number | null;
  bonus: { amount: number; bp: number } | null;          // only with a new phone and amount > 0
  newPhone: { label: string; price: number } | null;     // label without the brand
  repair: { amount: number | null; covered: boolean; coverage: "none"|"warranty"|"care_plus"; nothingToRepair: boolean };
  lines: AnswerLine[];
  staffNotes: { market: string | null; we_pay: string | null; bonus: string | null };   // staff only
  test: boolean;                  // a test programme: every surface adds "Test programme — no real money"
};
```

| key | when | `text` | `note` |
| --- | --- | --- | --- |
| `grade` | the case has a condition | `Current grade C (Fair)`; with a defect `Current grade A` | the defects, at most two then `+N more` ("screen cracked", "back glass cracked", "doesn't switch on" alone…); never scratches, scuffs, dents or a bent frame |
| `market` | there is a market price | `Market price for grade C ₹25,000` when the price is FOR the grade the grade line shows; otherwise `Market price ₹25,000` (a lower grade's price, a cracked back priced at its grade A look but shown as B, or no grade known) | — |
| `we_pay` | with `market` | `We pay you ₹26,000`; traded `We paid you ₹26,000` | — |
| `bonus` | a new phone, a bonus > 0, a market price; not after "repair chosen" | `+ ₹6,199 bonus if you exchange with a new device`; traded `+ ₹6,199 bonus with the Galaxy S26 Ultra 256GB` | the new phone's label (open) |
| `repair` | something to repair, not traded | `or repair it for ₹34,096` · `or repair it free — covered by warranty` / `… Care+` · `or repair it — the advisor will quote the price`; repair chosen `Repair ₹34,096` / `Repair — covered by warranty` | — |

The grade is the worse of the look the trade-in is priced at (rule G1, defects set aside) and the
grade after refurb — display only, so a cracked back never reads better than the report's
after-repair grade. The market line names a grade only when the grade the price is FOR (the
listing's or the rate card column's grade; for a source with no grade, the look) is the grade the
grade line shows (R13). Otherwise it prints `Market price ₹X`, and `staffNotes.market` says what it
was priced at: "Priced at grade C — none listed at grade B." / "Priced at grade A less back glass
cracked." — a cracked back on a per-grade card (max 40,000 · good 30,000 · fair 25,000 · best value
20,000) reads `Current grade B · back glass cracked` · `Market price ₹34,000` · `We pay you ₹35,020`,
never "for grade B" (the card's grade B is ₹30,000).

| status | ready | final | lines | customer text when not ready |
| --- | --- | --- | --- | --- |
| `draft` / `quoted` | a market price from the **partner** (`partner_manual` or `partner_ratecard`), not lapsed, not blocked | false | grade, market, we_pay, bonus, repair | "The advisor is working out your price." — or, for a PriceIQ estimate, "The advisor is confirming your price." (staff note: "Estimate from the refurbished market — not shown to the customer.") |
| traded (`locked` … `not_received`) | true | true | grade, market, we_pay, bonus — from `trade_value`, `premium_value`, `bonus_value` | — |
| `repair_chosen` | true | true | grade, repair | — |
| `walked_away` | as the partner's price allows | true | as last worked out | "This case is closed." |
| `cancelled` | false | true | none | "This trade-in was cancelled." |

Headlines: open — decide()'s ("Repair it — it's covered", "Repair recommended", "An upgrade is worth
considering", "Either works — your choice", "Nothing to repair — a straight trade-in", else "Your
offer"); traded "Traded in"; "Repair chosen". Staff notes: `we_pay` "Includes ₹1,000 SwapUp premium
(4%)." (", lifted to what ₹15,000 earns" at a band edge; null when there is no premium); `bonus`
"Upgrade bonus · 4%" / "Upgrade bonus · capped at ₹6,000", or `swap.bonusWhy` with no bonus.

**Worked example (fixture F1):** S23 Ultra 256GB, cracked screen on a dented body, partner quote
₹25,000, the S26 Ultra 256GB at ₹1,54,999 with a 4% bonus → `Current grade C · screen cracked` ·
`Market price for grade C ₹25,000` · `We pay you ₹26,000` · `+ ₹6,199 bonus if you exchange with a new
device · Galaxy S26 Ultra 256GB` · `or repair it for ₹34,096`; `swap` = `{ tradeIn: 25000, premium:
{amount: 1000, bp: 400}, wePay: 26000, total: 32199, customerPays: 122800 }`. At lock: `trade_value
25000`, `premium_value 1000`, `premium_bp 400`, `payable 122800`, a hold of ₹25,000; the programme
claims ₹1,000 + ₹6,199. Cleared: no chargeback. Regraded to ₹22,000: a chargeback of ₹3,000 (M −
accepted, never W − accepted).

The offer is worked out for every status; `open` says whether it can still be acted on. Once the
case is closed (`repair_chosen`, `walked_away`, `locked` and later) `asks` is `[]` and every action
is "This case is closed.". A partner viewing a case gets `offer: null` (and `refurbCost: null`).

### The strings, word for word

`asks` (each appears only while the case is open):

| Kind | Title | Text | When |
| --- | --- | --- | --- |
| `blocked` | "Check this is the right phone" | `quoteBlocked` | the camera says this may not be the phone on the case |
| `model` | "Which phone is it?" | "The test couldn't tell — choose it on the full case." (no test was applied to the case: "Choose it on the full case.") | no model on the case |
| `storage` | "Which storage is it?" | "The phone couldn't measure it — see Settings › About phone." — only when a test ran and the phone read nothing. No test applied (a desk-only case), or the phone measured a size on the list that is no longer on the case: "See Settings › About phone › Storage." The phone measured a size that ISN'T on the model's list (`measuredStorage`, e.g. a 1TB Ultra on file as 256/512GB): "Phone measures 1TB, not on file — no trade-in price for that size." | a model, no storage. `options`: the what-if trade-in for each size, smallest size first, priced the way the trade-in itself will be (PriceIQ less defects, else the rate card — so the chip and the answer agree) (`tradeIn: null` when nothing prices that size, or none could be asked yet — e.g. the condition is incomplete). `note` is the first priced chip's market-data note (its age over 14 days, or "PriceIQ unreachable, last answer …"), else null — show it under the chips. **`options: []` when the phone measured an off-list size:** every listed size is one the phone has ruled out, so none is offered (and no what-if prices are asked) — show the text only: no button, no entry, never a guessed size. |
| `no_price` | "No market price yet" | `quote.reason` (the specific why: "This phone isn't on the rate card yet.", PriceIQ's own why, or "No rate card is active yet.") ?? "No market price yet." | model + storage, not blocked, the quote is unpriced or errored. **Text only** — no button, no sheet: nothing is typed in. Swap up stays refused with the same reason; Repair and "Customer walked away" stay choosable. (0.9.0 sent `partner_quote` here; installed apps drop the kind they don't know.) |
| `repair_quote` | "The repair needs a quote" | the first `repair.notes` entry, or `repairNotServiced` (fallback "No book price — enter the service centre's quote.") | a model, something to repair, and the book can't price it (`needs_inspection` / `unpriced` / brand not serviced) |
| `new_phone` | "Choose the new phone" | "No catalogue match — choose one to see the bonus." (the catalogue does have one — staff cleared the suggestion, or none ran on a desk-only case: "Choose the new phone to see the bonus.") | a model and no new phone (the suggestion found none: e.g. an iPhone at a Samsung centre) |

- **`headline`:** the title of the first ask that isn't `new_phone`; else `decision.headline`; else
  "Not enough to compare yet".
- **`reason`:** the first that applies — that ask's text; the first strong signal pointing the way of
  the recommendation; the first signal; for `no_repair` with no signals "The test found nothing
  wrong." (no test applied to the case: "No faults on the case."); `cannot_say` with nothing to ask → the first `decision.missing` entry (e.g. "No repaired value yet."); else null.
- **`storage`:** `source` and `note` are null whenever `variant` is null. `note`, when the source is
  `customer`: "Customer typed this — check Settings › About phone."
- **`repair.detail`:** covered → "Covered by warranty" / "Covered by Care+"; a manual quote →
  `Quote: ${reason}`; a book estimate → every line label joined with " + ", then "+ labour" if
  labour > 0, "+ GST" if GST > 0, "+ Care+ fee" if that fee > 0 (e.g. "Display assembly + labour + GST").
- **`repair.why`** (only when `amount` is null): "Nothing to repair."; "Choose the phone first.";
  otherwise the repair note, or `repairNotServiced`, else "No book price — enter the
  service centre's quote."
- **`swap.tradeIn`** is null whenever the trade-in can't be trusted — the camera blocks it, there is
  no model, or no storage — even if an older priced quote is still stored.
- **`swap.tradeInDetail`:** show `line` (when there is one) under the trade-in, then a closed "Show
  details" listing `lines` as "label · pct" and the rupees (`−₹9,251`; a give-back after the first row
  `+₹16,048`), then `note`. Never a partner's name: the labels are SwapUp's. The desk's answer card and
  the store app's answer screen show the same.
- **`swap.tradeInNote`:** a PriceIQ quote on market data over 14 days old → "Refurbished market price,
  week 2026-W35, 52 days old." (with " · PriceIQ unreachable, last answer …" when PriceIQ didn't answer
  and the last good answer priced it; that alone when the data is fresh); expired on an open case →
  "Quote expired — re-quoting." (every quote is the system's, so it is; a closed case's quote running out
  after the lock is no news: no note).
- **`swap.why`**, in order: `quoteBlocked`; "Choose the phone first."; "Tap the storage to see the
  trade-in." (the phone measured an off-list size: the storage ask's text — there is nothing to tap); `quote.reason` (fallback "No market price yet."); the first
  `conditionProblems` entry; "Record the condition." (no condition); "No trade-in price
  yet."
- **`bonusWhy`:** no new phone → "Choose the new phone to see the bonus."; a new phone but no bonus →
  "No bonus campaign today." `bonus` / `bonusBp` are a manager's
  override when there is one (`override.amount` / `override.bp`).
- **`actions.repair`:** closed → "This case is closed."; nothing to repair → "Nothing to repair.";
  no refurb quote → `repair.why`; draft → "Not priced yet."; else null.
- **`actions.swap`:** closed → "This case is closed."; no trade-in → `swap.why`; no new phone → "Choose the new phone." (the lock
  blocker's own words); not quoted → "Not priced yet."; else null. A swap the Lock screen is certain to refuse
  for a reason it can't fix there is refused here, with that reason. The IMEI, credit and
  PriceIQ / rate-card expiry blockers stay on the Lock screen (`lockBlockers`) — an expired PriceIQ or rate-card quote
  IS re-quoted by `reprice`. The lock's expired-quote blocker is "The trade-in price has expired — re-quote."
  (`EXPIRED_BLOCKER`) for every quote.
- **`actions.walkAway`:** closed → "This case is closed."; else null.

### Filled without asking

- **Storage** — at Apply (§4): the phone's measurement; else the model's only size (`catalogue`);
  else the size the customer picked on their own phone (`customer` — a claim, see the lock below). A
  measured size that isn't on the model's list fills nothing and is kept as `measuredStorage`; the answer
  says so ("Phone measures 1TB, not on file — no trade-in price for that size.") and offers no chip and no
  entry: there is no trade-in price for a size not on file, and none is guessed. `PATCH {variant: "1TB"}`
  stays refused (not on file).
  Still unknown → the `storage` ask: one row of chips, each with that size's trade-in. Those are
  **what-if** trade-in quotes (PriceIQ less defects, else the partner's rate card) (`whatIf: true`, never binding), asked by the re-price for each of the
  model's sizes while the storage is unknown and the condition is complete, consistent and not
  camera-blocked — again only when the description changed, there are none yet, or none is priced — and dropped the
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
  or unpriced quote. `faults`, `condition`, `modelId`, `variant` and the camera identity override still
  re-quote. A fault or condition change the store camera contradicts is refused 409 with the camera's
  sentence ("Camera confirmed "Cracked screen", photo 2 — removing it needs a reason."); send the same
  patch again with `cameraOverride: {reason}` (8+ characters, kept with the advisor's name) and it saves.
- **IMEI** — step 1 (§2d): asked first, on New trade-in (or the Session screen for a counter-QR
  trade-in), resolved once per case; Lock asks for it only when it was skipped.

### The calls

All exist and accept Bearer:
- `GET /api/cases/<id>`
- `PATCH /api/cases/<id>` with one of `{variant}`, `{upgradeDeviceId}`, `{coverage}`,
  `{manualRepair: {amount, reason} | null}`, `{faults}` / `{condition}` (with `cameraOverride: {reason}` when
  the camera refused it), `{imei}` (resolved once — §2d), `{kymEarly}` (§2d) → the whole `CaseView`. A staff `variant` is recorded as `variantSource: "advisor"`; only
  Apply can record `measured` / `catalogue` / `customer` (the public PATCH can't say where a size came from).
  **Re-saving the size already on the case changes nothing** (since the 2026-10-17 review): it keeps its
  `variantSource` — a size the customer typed stays `customer`, so the lock still asks for `storageSeen` —
  and the partner is not re-asked. Only a different size is the advisor's word (re-quoted). Apply's own word still counts on the same size: a
  measurement turns the customer's claim into `measured`.
- `POST /api/cases/<id>/action` with `{action: "reprice"}`, `{action: "choose_repair"}`,
  `{action: "walk_away", reason?}` or `{action: "lock", customer, checks}` (below).
- `GET /api/catalog/new-devices` → `{ devices: [{ id, brand, model, series, variant, price, supportEndYear }] }`.
- `GET /api/cases?status=draft,quoted&limit=10` — the cases still waiting on the customer.
- `POST /api/auth/handoff` `{ next: "/cases/<id>?view=answer" }` (§1).

### Taking the trade-in — `{action: "lock"}`

`{ action: "lock", customer: { name, phone, idType, idLast4 }, checks: { ownership, simRemoved,
imeiMatches, noFinanceLock, kym: { status, reference? }, imeiCheckAck?, storageSeen? } }`

**One hand-over confirm, four flags** (owner, 2026-10-17: *"Reduce the flow"*). SwapUp Store and the
desk show the four hand-over checks as ONE tick — "Owner confirmed · SIM out · IMEI matches · no
EMI/lock", with what each means under it — and send it as all four flags (`ownership`, `simRemoved`,
`imeiMatches`, `noFinanceLock`; `handoverChecks()` in the store app's `src/store/lock.ts` and the
desk's `components/counter/handover.ts`). The server is unchanged: each flag is still required, and
a lock missing any of them is `400 "Confirm first: owner confirmed, SIM and card out, …"`. A changed IMEI unticks the confirm (it covered "IMEI
matches"). The screen shows no money — the answer showed it.

**`checks.storageSeen: boolean`** (since 2026-10-17) — required when `variantSource === "customer"`:
the advisor saw the storage in Settings › About phone. Without it →
`400 "Confirm Settings › About phone shows 512GB."`
A claimed size is enough to SHOW a price; moving money needs it seen — the same rule as the IMEI, one
tick, only when the phone couldn't measure it. It is stored with the checks (`checks.storageSeen: true`)
and in the `case.lock` audit (`storage: {variant, source, seen}`). It is checked right after the
status (only a `quoted` case locks) and before the IMEI check digit and the lock blockers.

### Worked example (local seed: `org_samsung_svc`, PriceIQ answering the contract's figures for the Galaxy S23 Ultra 256GB, week 2026-W35, 52 days old)

**A tested Galaxy S23 Ultra 256GB.** SwapUp Check (SM-S918B, 256 GB measured) with the rear camera
failed; screen OK, body scuffs, liquid clean (rule G1: Good); battery health 76 %. Faults
`rear_camera`, `battery_drain`; grade "Needs repair", after repair Good. `GET /api/cases/<id>`:

- `quote.source` `{kind: "priceiq", label: "PriceIQ · Good − defects"}`, `quote.amount` **36490**,
  lines: Refurbished market price (Good) · PriceIQ 51,399 · Below the market price 200 bp −1,028 ·
  Battery drains / swollen 900 bp −4,625 · Rear camera faulty 1,800 bp −9,251 · Rounded down to ₹10 −5.
  `quote.priceiq` `{deductions: "SwapUp's % per defect", stale: true, ageDays: 52, note: "Refurbished
  market price, week 2026-W35, 52 days old."}`.
- `repairedQuote.amount` 50370 ("PriceIQ · Good after refurb"); `marketSell.amount` 50371.
- `offer.swap`: tradeIn 36490 · `tradeInDetail.line` "Refurbished market price ₹51,399 (Good) − 2% − 2
  defects · PriceIQ 2026-W35, 52 days old" · `tradeInNote` "Refurbished market price, week 2026-W35, 52
  days old."
- A flawless one: ₹53,499 (Superb) − 2% = ₹52,420.

**A model PriceIQ has no price for** (Galaxy Z Fold6 256GB) and no partner rate card:
`quote.status` "unpriced", `quote.source.kind` "none", `quote.reason` "No market price yet — enter a
quote.", `quote.priceiqWhy` "PriceIQ has no refurbished market price for the Galaxy Z Fold6 256GB.";
the answer asks for the partner's quote with that sentence. With the partner's rate card listing it,
`quote.source.kind` "partner_ratecard" and `tradeInDetail.note` says why PriceIQ didn't price it.

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
  Identify card. `reason` is the matcher's explanation. Never a price. `match: "exact"` → nothing is
  asked; `"family"` (a regional version) → the one-tap "Is this your phone?"; `"none"` → the picker.
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
  exactly the 18 tests it always had. It is also left out when the case already has a battery-health %
  from another source — an attached Phonecheck report (since 2026-10-17: the screenshot is asked only
  when nothing else read the battery; the phone lets the customer skip it either way).
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
     size gets the flag "Storage: customer said X, phone measures Y — measurement used."
  1b. the phone read a size that ISN'T on the model's list → nothing is patched, and no pick, single
     size or guess is used against the reading. Flag: "Storage: the phone measures 1TB, which isn't a size
     on file (the customer said 512GB — not used). No trade-in price for that size." (0.9.1 writes "Storage:
     phone measures 1TB, not on file (customer said 512GB — not used) — no trade-in price for that size.";
     older stored flags are reworded on boot.) The reading is kept as `measuredStorage` (§3c).
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
its queue until acknowledged → `{ ok: true, received: n, progress }`. Same phone, same answer
(since 2026-10-18): from the browser build (`appVersion` "web-…"), a `fail` on `speaker`, `vibration`
or `flash` — the customer's own count, buzz or light, where the native app measures and skips — and
on `multitouch`, `buttons` or `bluetooth` — the customer's Fail tap (or a browser's Web Bluetooth
saying no), where the native app doesn't run multi-touch or the buttons and reads Bluetooth off the
feature list, never failing them — is stored as `skip` with `detail.reason` "Not measured in the
browser": never a fault, a repair line or a deduction (`BROWSER_JUDGED`, lib/domain/diagnostics.ts).
Measured browser tests (touch, camera, display, connectivity…) keep their verdicts.

`POST /api/device/complete` `{}` → `{ ok: true, summary }`.

`GET /api/device/status` → `{ status, progress, storeName, caseRef, reportPath, grading, colours, answer }` (lets the
app show "The store has your results"; `colours: true` = show the test colours on the result screen
for the advisor — "The test colours for the advisor", below). Since 2026-10-17, once the session is `applied`:
`reportPath` = the path of the phone's public grade report, `"/r/<token>"` — open it on the
session's `server` origin ("See your phone's report", §9); `grading` = `{ status, label, grade,
letter, final }` of the version that link opens on (the latest issued one, never the live grade) —
the customer's "Grade: Good (B)". No reasons and no price. Both `null` before Apply, or when
nothing was reported. The app reads them through `src/check/report.ts` `customerReport`; after a
restart on the "store has your results" screen it reads the status once more for them.

`answer` (since 2026-10-18 — owner: the answer on the customer's phone too, native and browser
alike): `null` before Apply, for a closed ticket and when the case is gone; else the customer's
slice of `offer.answer` (§3c, `lib/domain/answer.ts customerAnswer`) — a **whitelist** copy:

```ts
type CustomerAnswer =
  | { ready: false; final: boolean; text: string; test: boolean }      // "The advisor is working out your price."
  | { ready: true; final: boolean; headline: string;
      grade: { letter; word; note } | null; market: { amount; letter; word } | null; wePay: number | null;
      bonus: { amount } | null; newPhone: { label } | null;
      repair: { amount: number | null; covered: boolean; nothingToRepair: boolean };
      lines: AnswerLine[]; test: boolean };
```

- **Read only.** It is built from the stored case rows: it never re-prices, never asks the partner,
  PriceIQ or GradeIQ, and never writes — a phone polling every few seconds never loops a partner with
  the IMEI. The response is `cache-control: no-store`.
- **Polling:** while `answer` is present and not `final`, poll every 5 s (the advisor may change the
  new phone or the storage at the counter); once `final`, stop (the figures are frozen at lock). An
  older server sends no `answer` key: keep the old 15 s.
- **Never in it:** the source, the premium (it shows only as We pay − Market price), any %, staff
  notes, the new phone's price, asks, the trade-in trace, PriceIQ's base/markdown/week, the store's
  sell price or refurb cost, the partner's name or reference, the campaign or its funder, the IMEI, the
  customer's name or mobile. The money in the whole response lives only under `answer`.

### Phone-led flow (SwapUp Check ≥ 0.6.0 — `docs/PHONE-LED-FLOW.md`)

Scan › Test › Done (with "Is this your phone?" first only when the match isn't exact), the phone moving itself. All Ticket-authenticated.

`POST /api/device/phase` `{ phase: "identify" | "scan" | "battery" | "test" | "done" | "colours" }` → `{ ok: true }`
on each step change. Only the store's screen reads it (`TestSessionView.phonePhase`, the camera
card's line); anything else → `400`. `colours` (≥ 0.8.0): the phone is showing the test colours on
its result screen for the advisor (below) — a certification tapped then records `withColours`.

**The test colours for the advisor (SwapUp Check ≥ 0.8.0).** The customer is never asked about
condition. When the store camera's colour sweep didn't check the screen, the advisor certifies it in
SwapUp Store while the phone shows the colours: `GET /api/device/status` says **`colours: true`**
once the phone's phase is `done` (or `colours`), the session isn't applied, and the screen is still
to certify. Then, on the result screen: white → black → red → green → blue → stripes, full-screen,
about 2.5 s each, looping, brightness up, caption "The advisor is checking your screen — keep it
face up"; poll the status about every 1.5 s, post phase `colours` while showing and `done` when
`colours` turns false (the advisor tapped Screen, or Apply). The customer taps nothing.

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
URL, else `413`) → `{ healthPct: number | null, outcome: "pass" | "fail" | "skip" }`. **`409` "Battery
reader isn't available — skip; the advisor checks it."**
also when GradeIQ answers that its reader is off (no AI key, or its AI refused the call — e.g. out of prepaid
credit): not the customer's screenshot, so never "try a clearer screenshot". The server
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
`{ state, pattern, shown, cosmeticDone, handoffDone, capture: { verdict, code, reasons[], attempt } | null, connectedAt, released, unreachable? }`
- `released` reaches the phone even when GradeIQ can't be read. For SwapUp Check ≥ 0.8.0 an
  unreadable GradeIQ is a normal answer with `unreachable: true` (pattern `idle`, `released` as it
  is) instead of a `503` — the phone says "busy" and keeps polling, never offers the customer a skip,
  and the advisor can still release it. Older apps keep the `503`.
- Read FRESH from GradeIQ on every call (2026-10-17): GradeIQ's camera page waits only 4 s for the
  phone to confirm white, so poll about every 350 ms once a camera page is connected, echo two frames
  after the colour is drawn, and re-send a lost echo after 600 ms.
- **No customer skip** (2026-10-17): stay on Scan until `handoffDone`, or until **`released`** is true
  (the advisor pressed "Go on without the camera", `POST /api/test-sessions/<id>/release-scan`, or
  overrode the camera). A camera page that never connects in **5 minutes** lets the phone go on by
  itself (no button; the advisor checks the screen by eye). Once the camera page is connected the
  phone shows no scan code — the front-glass photo must never carry it.
  Leaving Scan for any reason, echo `{ shown: "off" }` once — never leave a colour behind as the last
  echo (GradeIQ keeps it, and the next camera page would take it for the phone showing white).
- `state`: `disabled` or `failed` → skip the photo check and run the tests; `pending` → wait;
  `ready` → show `pattern` (`idle` | `white` | `black` | `red` | `green` | `blue` | `stripes`).
- `capture.verdict = "retake"` → the store's photos were rejected (show `reasons`; stay on the
  screen — the store retakes).
- Leave (to Done) when `handoffDone` is true, or 30 s after `cosmeticDone`; apps before 0.8.0 also
  offer "Finish without photos" after 90 s with no store camera page (a NEW `connectedAt` — a page loaded after the screen mounted —
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
echo is what unlocks the store's camera button. `shown: "off"` = the phone left its Scan step.

## 4b. Data clearing after acceptance (store side, via the desk case page)

After the customer accepts (case `locked`, or `in_pickup` while the phone is still at the store),
the customer factory-resets their own phone from its Settings and the store records what it saw:

`POST /api/cases/:id/action` `{ "action": "data_clear", "steps": { "accountsSignedOut": true, "resetDone": true, "setupScreenSeen": true, "noPreviousAccount": true }, "note": "optional, ≤200 chars" }`
→ the CaseView with `dataClear` `{label, steps, note, by, at}` and `dataClearState: "done"`.
Advisor / store manager only (403 otherwise); 400 lists unconfirmed steps; 409 if the case is not at the store
after acceptance or the record already exists. `dataClearState` is `done | attested | due | not_applicable`
(`attested` = an older case where the reset was ticked at hand-over). The record is always labelled
"Customer's factory reset, seen by the store — not a certified erasure". The customer app only
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
- `grading.message` follows `phonePhase`: "Phone identifying itself — scan code next.", "Scan the
  phone's code, or Take photos.", "Phone testing — grade coming." (or the grade, once settled). `cameraLocked` says why in the same terms.
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
  released: { by: string; at: string } | null;   // the advisor let the phone go on from Scan without the camera
  canRelease: boolean;             // offer "Go on without the camera" → …/release-scan (a scan-first phone on Scan, the camera not finished)
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
  displayCheck: { verdict: "pass"|"fail"|"unknown"; confidence; note; findings[] /* each with box when GradeIQ gave one */; patterns[]; captures[]; requested[]; missing[]; reason;
                  source: "gemini"|"stub"|null /* stub = its AI reader was off or failed; the frames are still kept */ } | null;
  lcd: { cameraChecked: boolean; verdict: "pass"|"fail"|"unknown"|null; reason: string|null;
         captured?: number; requested?: number;   // colours photographed, of how many asked
         aiOff?: true };                           // frames in, reader off: reason "captured N of M colours, AI reader off — check by eye"
  obstruction: { present: boolean; type: string; note: string } | null;   // a case on the phone → grade not used
  oem: { verdict: string; confidence: number|null; evidence: string[] } | null;
  identity: { verdict: "match"|"mismatch"|"unverified"; reasons: string[]; device: { make, model, match, reason } | null };
  photos: string[]; fetchedAt: string | null;
};
```

Rules the server enforces:
- **Camera lock fails closed.** `cameraUrl` and `screenUrl` are null until GradeIQ's `/screen`
  reports the customer's phone echoing (`shown` is a string). Unreadable `/screen` → `cameraLocked`
  says so; only `camera-override` with a reason unlocks them. A sweep that then runs to the end still
  counts — its frames prove the phone showed each colour; with no sweep the LCD is "not
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
lcdOverride, identity, identityOverride, overrides, devicefax), `certification` (§8b), `quoteBlocked`.
The DeviceFax JSON (photo URLs on the public GradeIQ origin) is kept on the test session for staff only.

## 8b. Check the phone — the advisor certifies (store side)

Owner, 2026-10-17: *"advisor certify lcd in its app instead of asking"*. The customer is never asked
about condition: the store camera tests it, and where the camera can't decide — no screen sweep, its
AI off, a grade that isn't final — the advisor looks and taps what they see, **by name**, on one card
in SwapUp Store ("Check the phone", **inside the camera step** of the Session screen, only when the
camera couldn't decide — the body and liquid rows as soon as the scan is over, the screen once the
phone's tests are done and it shows the colours). One tap per row; no forms, no confirm dialog;
tapping another chip replaces the earlier one. The **automatic** apply waits for every row on the
card (above, "The answer, by itself") while it can still be tapped (`canEdit`); a **manual** Apply is
never blocked: a row left untapped keeps the grade provisional, and the answer screen then shows the
card until it is tapped. Once every row is tapped the answer keeps it **closed, one tap away** —
"Checked by Asha · change" — until the trade-in is locked, so a wrong last tap (the answer opens
half a second after it) is put right on SwapUp Store's answer screen. (The desk has no per-row
certify control: change a row there — but it has the one-tap "All fine", below.)

**One tap — "All fine — screen OK, body like new"** (owner, 2026-10-19: "Skip and get on advisor app
fast"): ONE button at the top of the card, in SwapUp Store and on the desk, while the card is waiting
for a tap. It records the screen **OK**, the body **Like new** and the liquid indicator **Can't see**
(honest: nobody looked at it), by name, exactly as those three taps would — in one transaction, one
audit row per row (`allFine: true`) — and opens the answer. The chips stay for anything else. It
taps **only the rows nobody has tapped yet**: a row already certified keeps its tap (it was looked
at — a liquid "Tripped" tapped on SwapUp Store stays, with its water damage and its lower price),
and the liquid indicator only when the card asks for it (`needed`), as SwapUp Store's `allFineTaps`
skips it — so the desk's "All fine" never overwrites what the tablet recorded.

Which rows (`needed`) follow exactly what the SwapUp grade can only settle with a look
(`certifySignals` in `lib/domain/certify.ts`): the screen when the cosmetic grade isn't final, the
sweep didn't check the screen, or it failed it without being sure; the body when the grade isn't
final; both when the grade isn't conclusive or GradeIQ asks for a review; the screen / the body for
a part a final grade rated C or D (front / back or frame); the body for a cracked back or bent frame
the camera saw that isn't on the case. The Screen row **waits while the phone is still testing**
(the colours come after the tests): SwapUp Store holds its chips, and the server answers `409`
"Wait for the test colours — the phone is still testing." A Screen tapped before the colours showed
keeps them wanted, and the same tap again (once they show) records it on them.

`TestSessionView.certify` **and `CaseView.certify`** (staff only; the same block from the same code,
`certifyBlock` in `lib/server/cases.ts`, so the answer screen opened from Home shows the card too)
say what to show: `needed` (the rows), `rows` (certified so far), `choices` (the chips, word for
word), `testSessionId` (send it back with each tap), `canEdit` (false once the case is past the
counter: show the rows, no chips), `colours` — under Screen: `showing` → "The customer's phone is
showing the test colours", `waiting` → "Waiting for the customer's phone to show the colours…"
(also before the phone has joined), `old_app` → the phone can't show them (certify by looking at it;
the grade says so), `off` → nothing to wait for (certified, the camera's sweep checked it, or the
results are applied). `CaseView.certify` is `null` for a partner, and for a case nobody tested with
SwapUp Check and nobody certified.

| Row | Chips (`value` · label) | On the case |
|---|---|---|
| `screen` | `ok` OK · `scratches` Scratches · `lines` Lines or spots · `cracked` Cracked | screen flawless / scratched (display test passes) · `display_lines` (display fails) · `screen_cracked` (no display result) |
| `body` | `like_new` Like new · `scuffs` Scuffs · `dents` Dents · `back_cracked` Back cracked · `bent` Bent | body flawless / scuffed / dented · `back_cracked` · `frame_damage` |
| `liquid` | `clean` Clean · `tripped` Tripped · `cant_see` Can't see | nothing · `water_damage` · nothing (the report says it wasn't checked) |

`POST /api/cases/<id>/action` `{ "action": "certify", "row": "screen"|"body"|"liquid", "value": "<chip value>", "testSessionId": "ts_…" }`
— or `{ "action": "certify", "allFine": true, "testSessionId": "ts_…" }` for the three taps above —
(`testSessionId` optional — default the case's latest session) → the CaseView, with `certification`
`{ screen?|body?|liquid?: { value, label, by, at, withColours } }` and the new `grading`, `faults`,
`condition` and re-priced `offer`.
- Faults it adds carry source `advisor`; changing the row takes off only the faults that row added
  (and only when nothing else found them). The screen and body take the certified value but never
  better than the case's faults or what the camera confirmed — the camera's finding stands (DS10).
- `withColours` = the phone's phase was `colours` within the last 10 minutes.
- Works before and after Apply, until the trade-in is locked. Before Apply the case has no
  condition yet: a tap records the row (and puts on any fault it means) but never invents the rest of
  a condition nobody looked at — `condition` stays `null`, and Apply folds the certified screen and
  body into the condition it makes. The same value tapped again changes
  nothing (no audit row). Every change is audited `case.certify` `{row, value, prev, withColours,
  testSessionId, faultsAdded, faultsRemoved}`; the grade report gets a version (`certified`).
- Errors: `403` "Only store staff certify a phone." (not advisor / store manager) · `404` the case or
  that session isn't in scope · `409` past the counter · `400` unknown row, or "Tap one of: OK,
  Scratches, Lines or spots, Cracked."
- After the last tap the answer opens by itself (the session's `autoApply` goes `ready` → `applied`),
  recorded as whoever tapped last (else whoever released the Scan step, else who started it).

## 9. The SwapUp grade and the grade report (+ Phonecheck)

One grade for a tested phone, from **every** phone check SwapUp has — SwapUp Check (the customer's
phone testing itself) and, at a store that owns one, a **Phonecheck** station — merged worse-of by
one engine (`lib/domain/grading.ts`; rules, scales and Phonecheck set-up in `docs/GRADING.md`).
**The grade never moves a price** and the report carries **no money**.

**Both scales, always together.** The SwapUp grade (Superb > Good > Fair > Best Value) and its
letter, a one-to-one translation: A = Superb, B = Good, C = Fair, D = Best Value (`null` whenever the
grade is). Call it the **SwapUp grade** and the page the **grade report** — on every screen. The
server writes the label; clients render it as sent (splitting off `" · provisional"` at most) and
never rebuild the letter:

| `status` | `label` |
| --- | --- |
| `graded` (final) | `"Superb (A)"`, `"Good (B)"`, `"Fair (C)"`, `"Best Value (D)"` |
| `graded` (provisional) | `"Good (B) · provisional"` |
| `needs_repair` | `"Needs repair"` |
| `incomplete` | `"Not fully tested"` |
| `cannot_grade` | `"Can't grade"` |
| `not_tested` | `"Not tested"` |

Wherever the letter shows, show this line once beside it (it is also `body.grade.letterScale`):
"A = Superb, B = Good, C = Fair, D = Best Value — not CTIA." Never call it a CTIA grade. GradeIQ's camera letter (Premium–D) is a different thing
and stays staff-only (§8) — never beside this grade.

### `CaseView.grading` (every `GET`/`PATCH /api/cases/<id>` and `/action` response)

```ts
CaseView += {
  grading: {
    status: "not_tested" | "cannot_grade" | "needs_repair" | "incomplete" | "graded";
    label: string;                 // both scales, ready to show (table above)
    grade: "Superb" | "Good" | "Fair" | "Best Value" | null;   // only when graded
    letter: "A" | "B" | "C" | "D" | null;                     // null whenever grade is
    final: boolean;                // graded and nothing provisional
    why: string | null;            // the one-line reason (reasons[0])
    report: { path: string; version: number; sha256: string; issuedAt: string; final: boolean } | null;
                                   // path "/r/<token>" (staff: latest) or "/r/<token>?v=<n>" (partner: frozen)
    phonecheck: { canPull: boolean; why: string | null } | null;   // staff: show "Phonecheck results" only when canPull; why = why not
  } | null;                        // null only for the partner when no report was issued
};
```

Staff get the **live** grade while the case is at the counter (`draft`/`quoted`); once the trade-in
is locked, the grade **is** the version frozen at lock (the receipt's, the pickup's and the
partner's), with `report.path` pinned to it (`?v=<n>`). The partner gets only what the frozen
version says, and `phonecheck: null`. Show the grade line **outside** the price tiles — the tiles
stay partner money.

**Partner fixes (2026-10-17).** For a partner viewer every case response now carries
`refurbCost: null`, `offer: null` and `marketSell: { amount: null, why: "Not shown to the partner.",
source }` — the PriceIQ sell price is the store's margin and used to reach the partner. Its
`camera` also comes without the store camera's own grade: `grade: null`, `gradeRange: null`,
`flags: []` (GradeIQ's Premium–D letter is staff-only; beside the report's A–D it would read as a
second SwapUp grade). The camera's faults stay — they are on the case.

### `GET /api/cases/<id>/grading-report` (Bearer; any role that can see the case)

```ts
{
  live: Grading | null,           // staff only; the engine's full output (tests, battery, reasons, provisional, disclosures, repairs…)
  issued: Envelope | null,        // staff: the latest version; partner: the lock version (else a backfill)
  versions: { version, sha256, issuedAt, reason, final }[],   // staff: all; partner: just that one
  path: "/r/<token>" | "/r/<token>?v=<n>" | null,
  staff: StaffExtras | null,      // staff only
}
type Envelope = { schema: "swapup.grading-report/v1"; version: number; issuedAt: string; reason: Reason;
                  final: boolean; sha256: string; body: ReportBody };     // ReportBody: lib/domain/gradingReport.ts
type Reason = "swapup_check" | "phonecheck" | "edited" | "traded_in" | "backfill";
type StaffExtras = {
  imei: string | null; imei2: string | null;                                // full, staff only
  camera: { gradeiqLetter, components[], score, flags[], disagreements[], gradeiq: { report, devicefax } | null } | null;
  phonecheck: { recordId, source, aiRead, links: { a4, erasure, dhr }, testerGrade, imeiOverride } | null;
  outOfDate: boolean;             // the live grade moved since the latest version
  afterRefurb: { grade, letter, label } | null;   // the after-refurb grade the store's sell price uses
};
```

A partner gets `404` before the trade-in is locked, like the case. **Versions:** a new one only when
the body changes — Apply (`swapup_check`), a Phonecheck attach (`phonecheck`), any case edit
(`edited`), and at lock the frozen one (`traded_in`, `final: true`). After lock nothing re-issues. A
case tested before this existed gets v1 (`backfill`) on first read. Never tested → no report.

### The public link (no sign-in)

`GET /api/r/<token>[?v=n]` → `Envelope` (latest, or version n), `cache-control: no-store`; `404` for
an unknown token or version; no list of versions. The body has no money, no customer and a masked
IMEI. **Verify:** `sha256 === sha256(canonicalJson(body))` (keys sorted recursively; an integrity
fingerprint, not a signature). `GET /api/r/<token>/photo/<n>[?v=]` → that version's photo `n`
(`body.camera.findings[].photo`), streamed by SwapUp; `404` otherwise. The HTML page is `/r/<token>`.

### Phonecheck on a case (Bearer, `advisor` / `store_manager`, case `draft`/`quoted`)

`GET /api/cases/<id>/phonecheck` → `{ configured: {ok, why}, station, stationFrom: "store"|"server"|null,
canPull, why, aiReader: {ok, why}, records: PcSummary[] }` — the records of this phone (by IMEI) this
store may use. `aiReader.ok` false = the AI reader is off — not set up (`GEMINI_API_KEY` unset), or
Google refused the account in the last 15 minutes (out of prepaid credit, 402; key refused, 401 /
403: "AI reader off — out of credit; upload the Phonecheck JSON."): grey the "report PDF or photo" upload and show `why` before a file is chosen. The JSON
upload always works. (`ok` true doesn't promise Google answers — the first refusal is a `503` on
the upload, in words; after it the reader reports itself off and makes no call.)

`POST /api/cases/<id>/phonecheck` →
`{ case: CaseView, record: PcSummary | null, outcome: "attached" | "not_found" | "stale", note, extracted? }`
— `note` is the server's own sentence for staff when the outcome needs one; show it when present.

| Body | Does |
| --- | --- |
| `{ mode: "pull", imei? }` | Phonecheck's newest check of the phone (`GetDeviceInfo`), stored and attached. `409` while Phonecheck is switched off (`why` names what is missing); `not_found` = never tested on that account; `429` more than once per 15 s / 10 a day per case; `502`/`504` Phonecheck refused / was slow (the message says which). |
| `{ mode: "upload", record }` | The Phonecheck JSON (one record or an array, ≤ 256 KB). Always provisional ("uploaded by staff"). |
| multipart `file` (PDF, JPEG, PNG or WebP, ≤ 8 MB) | The **report itself** — read by AI (Gemini) into the same record; anything not legible stays empty. Provisional ("read by AI — check the figures"). `extracted` = what the AI read, to show staff. `503` with a clear sentence when the AI reader isn't set up or Google refuses (e.g. out of credit) — the JSON upload still works; `422` nothing usable read; `429` one read per case per 10 s. |
| `{ mode: "upload_file", file: "data:<mime>;base64,…", name? }` | The same, for clients without multipart. |
| `{ mode: "attach", recordId }` | A stored record (e.g. one Phonecheck pushed). |

Upload / attach also take `confirmMismatch: true` + `reason` (≥ 8 chars, **store manager only**) for
a report whose IMEI isn't the case's. Without it: `409 { error, outcome: "mismatch", record }` — the
error names both numbers; keep `record.id` to attach with the override (the grade then says so).
A report already on another open case → `409`. Attaching **adds** the failed tests as faults
(source `"phonecheck"`), never removes any, only ever makes the condition worse (and never invents
one), fills the model / storage / IMEI only where the case has none, and re-prices like any edit.

```ts
type PcSummary = {
  id: string; source: "pull" | "webhook" | "upload"; aiRead: boolean;
  imei: string; imei2: string | null; reportNo: string | null;
  testedAt: string | null; testedAtWhy: string | null; receivedAt: string;
  phone: string | null; modelNo: string | null; variant: string | null;
  working: "yes" | "no" | "pending" | null; passed: number; failed: string[]; pending: string[];
  batteryHealthPct: number | null;
  testerGrade: string | null;      // as the tester chose it in Phonecheck — NEVER the grade
  deviceLock: "on" | "off" | null; parts: "genuine" | "not_genuine" | "unknown" | null; erased: boolean | null;
  station: string | null; tester: string | null;
  links: { a4: string | null; erasure: string | null; dhr: string | null };   // staff only
  attached: { caseId; caseRef; at; by; imeiOverride: boolean } | null;
};
```

`GET`/`PUT /api/stores/<storeId>/phonecheck` `{ station: "Teja-D04" | null }` → `{ station,
serverDefault, configured }` — the store's Phonecheck **station** login (PUT/POST: store manager of
the store, or the programme admin; the master account name never works). Same shape as `/wifi`. On
the desk it is the "Phonecheck station" card on `/store`.

`POST /api/phonecheck/webhook` — for Phonecheck, not the apps (`docs/GRADING.md`). `GET` on it →
`{ ok, service: "phonecheck", secured }`.

Pickups (`GET /api/pickups/<id>`): `items[].grading = { label, final, version, path } | null` — the
SwapUp grade frozen at hand-over, linked to exactly that version. It never changes a regrade.
