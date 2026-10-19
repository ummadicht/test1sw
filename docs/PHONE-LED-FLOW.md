# Phone-led flow — GradeIQ v2's order inside SwapUp Check (supersedes TWO-PASS-CAMERA for app ≥ 0.6.0)

Owner, 2026-10-17 (after reviewing swapmore.com/apps/gradeiq/v2): "I like the sequence where the
phone app controls everything, then the vision model, then functional. Use graphify, understand,
and make it part of the apps." Decisions on the design (scratchpad v2-design.md, built from the
GradeIQ graph + code):
1. **Scan QR = exactly like GradeIQ v2** — the customer's phone shows GradeIQ's own camera link
   (`cameraUrl(gradeiqId)`, the normal single pass, no `pass` param); any camera app opens it.
   Risk accepted by the owner: whoever holds that link can write to the GradeIQ session and see
   GradeIQ's /report. (SwapUp's rule "the GradeIQ id never reaches the phone" is lifted for this link only.)
2. **Both can start a trade-in** — the advisor (as today, find-by-mobile → QR) AND the customer alone,
   from a permanent per-store **counter QR**.
3. **Battery health affects the price** — a battery-health screenshot step (GradeIQ's /ocr reads the %);
   below 80 % is the `battery_drain` fault.

GradeIQ needs NO change: the single pass (photos → front glass dimmed → screen sweep → Settings photo →
handoffDone) is exactly GradeIQ v2's await2nd handoff. Pass 1/2 (`?pass=`) stay for SwapUp Store's
own "Take photos" fallback on older flows.

## The customer's phone (SwapUp Check ≥ 0.6.0) — Scan › Test › Done

**Reduced (owner, 2026-10-17: "Reduce the flow").** A step rail on every screen: **Scan · Test ·
Done**. Nothing is asked unless no test can tell: "Is this your phone?" (the one-tap confirm below)
only for a `family` match — an `exact` match goes straight to Scan, `none` gets the picker; the storage
only when the phone couldn't measure it; no IMEI, no name or mobile, no condition questions; the battery
screenshot only when the case has no other battery reading (an attached Phonecheck report — the join
then leaves `battery_health` out of the plan), and it is always skippable. The numbered list below is
the full contract; where it says more is asked, this paragraph wins.

1. **Join** (unchanged): store QR / link / 6-char code / deep link — or the store's **counter code**.
2. **Identify**
   - "Let's check this phone." Card: "**Samsung Galaxy S23 Ultra · 256 GB**" + "Your phone calls itself SM-S918U"
     (from the join response's `identity`). Buttons "Yes, that's my phone" / "No — choose my phone".
   - **Storage on the confirm card** (2026-10-17, the answer screen — owner: "Why asking questions when we
     have all tested data ... just refurb quote vs bonus + trade in price."). When the phone couldn't
     measure its storage (`identity.variant` null — every browser run, a failed disk read) and the model
     comes in more than one size (`identity.variants`), the card asks under the hero: "How much storage?",
     one option per size, "Settings › About phone shows it." "Yes, that's my phone" waits for a size; the
     quiet link "Not sure — the advisor will check" goes on without one. The size is sent as
     `picked: { modelId: identity.modelId, variant }` with `identityConfirmed: true`. A phone that MEASURED
     its storage is never asked, even when the size it read isn't on the model's list (a 1TB S23 Ultra on file
     as 256/512GB): the server then sends `identity.variants: []`, so the card never offers only sizes the
     phone has ruled out (2026-10-17 review fix).
   - No match / "No" → picker: brand → model (search when > 12) → storage; answers as tappable crumbs;
     "Confirm phone". From `GET /api/device/models`. Recorded as a CLAIM ("customer picked").
   - IMEI: "Dial *#06# — your phone shows its IMEI." Buttons "Open dialler" (`tel:*%2306%23`), "Paste";
     IMEI 1 (+ IMEI 2 optional); check-digit pill (checkImei); "Continue" (blocked on a bad check digit) /
     "Skip — the advisor will scan it".
   - Customer-started sessions (counter code) also ask: "Your mobile number" (optional, 10 digits) and name
     (optional) — sent with declare.
   - `POST /api/device/declare` gains `imei2`, `identityConfirmed`, `picked: {modelId, variant}|null`,
     `customerName`, `customerPhone`.
3. **Scan** (PairingScreen, FIRST again): idle state shows a big **QR of GradeIQ's camera link**
   (`GET /api/device/camera-link` → `{ url }`) + "Show this to the advisor — their tablet scans it, photographs
   your phone and checks its screen (about 2 minutes)." + status line. When the camera drives patterns → the
   full-screen colours as today; when GradeIQ asks for the **Settings photo**, show "Open Settings › About phone
   so the camera can read it" + "Open Settings" (`Linking.sendIntent('android.settings.DEVICE_INFO_SETTINGS')`,
   fallback SETTINGS); leave on handoffDone.
   **No customer skip (2026-10-17, ≥ 0.8.0)** — the customer is never asked anything about condition,
   nor whether to skip the camera: the phone stays on Scan until `handoffDone`, or until
   `GET /api/device/screen` says `released: true` (the advisor pressed "Go on without the camera" in
   SwapUp Store — `POST /api/test-sessions/<id>/release-scan`, by name). Leaving Scan for any reason it
   echoes `shown: "off"` once, so no colour is left behind as its last echo. Poll about every 350 ms
   once a camera page is connected (the server reads GradeIQ fresh on every poll — GradeIQ gives the
   phone only 4 s to confirm white), echo two frames after drawing a colour, re-send a lost echo after 600 ms.
4. **Battery health** (new): per-platform guide (Samsung: Settings › Battery › Battery information — or
   Samsung Members › Diagnostics › Battery status; Pixel: Settings › Battery › Battery health; other
   Android: Settings › Battery). "Take a screenshot of it, then choose it here." **Choose screenshot**
   (expo-image-picker, images only, quality 0.6, max ~1600 px) → `POST /api/device/battery {image}` →
   "Battery health **87 %**" (or "Couldn't read it — try a clearer screenshot" / "Skip"; a 409 means the reader
   is off — "the advisor checks the battery instead").
5. **Test**: GetReady → automatic tests → swipe squares → charger (unchanged).
6. **Result**: "Checks complete — the advisor will confirm your price." Ref, store, Passed / Failed /
   Not tested, "Screen and glass: checked by the store's camera" (or by the advisor), battery health %.
   After Apply the result screen shows the answer, written by the server (`GET /api/device/status` →
   `answer`, MOBILE-API §4): Current grade · Market price for grade X · We pay you · + bonus if you
   exchange · or repair it — the same lines on the native app and in the browser, and the same as the
   advisor's. Before it is priced: "The advisor is working out your price." No partner name, no store
   margin. The clear-your-phone guide shows once it is traded in.
   **The test colours (≥ 0.8.0)**: while `GET /api/device/status` says `colours: true` (the camera's sweep
   didn't check the screen and the advisor hasn't certified it), the result screen shows white → black →
   red → green → blue → stripes full-screen, about 2.5 s each, looping, brightness up, "The advisor is
   checking your screen — keep it face up", and posts phase `colours`; back to `done` when it turns false.
   The customer taps nothing; the advisor taps Screen on "Check the phone" (MOBILE-API §8b).

`nativeStep`: identify → scan → battery → auto → actions → done (resume-safe: `identifiedAt`,
`pairing`, `battery` records in CheckState). `POST /api/device/phase {phase}` on each step change.
**Browser build** (iPhones / no APK): the same order where it can — Identify (no model code → picker),
Scan (PairingScreen on web: no brightness control → "Turn your brightness all the way up"; Wake Lock if
available), Battery (file input via expo-image-picker web), then today's interactive tests, Done.

## SwapUp server

- **Migration 9**: `test_sessions.phone_phase TEXT`, `phone_phase_at TEXT`; `stores.counter_code TEXT` (unique when set).
- `GET /api/device/camera-link` (Ticket): `{ url: cameraUrl(gradeiq_id) }` when `gradeiq_state = ready`; 409
  "The camera check isn't ready yet" otherwise (the phone retries). The full pass, no `pass` param.
- `POST /api/device/phase` (Ticket) `{ phase: "identify"|"scan"|"battery"|"test"|"done"|"colours" }` → `{ok}`; staff view `phonePhase`.
- **Migration 14** (2026-10-17): `cases.certification TEXT` (what the advisor certified by eye — MOBILE-API §8b),
  `test_sessions.scan_release TEXT` (the advisor let the phone go on from Scan without the camera).
- **The advisor certifies** (`{action:"certify"}`, MOBILE-API §8b): the staff session view's `certify` block lists
  the rows and the chips; `GET /api/device/status` `colours` tells the phone to show the test colours.
- The battery reader being off (GradeIQ's `/ocr` answers `ocr.source: "error"`, e.g. its AI out of credit) is a
  409 "Battery reader isn't available — skip; the advisor checks it." to the phone — never "try a clearer screenshot".
- Join response gains `identity: { label, match: "exact"|"family"|"none", reason, variant, modelId, variants }` (matchModel;
  no prices). `variants` (2026-10-17) = the matched model's storage sizes from `trade_models`, `[]` when no model
  matched — what the confirm card's "How much storage?" offers. Also `[]` whenever the phone reported its disk
  size (`storageVariant(totalDiskBytes)` is not null), on the list or not: the phone already answered, and
  `reason` says what it read ("Storage reads 1000.2 GB (1TB), which is not a storage option on file…").
- `GET /api/device/models?brand=` (Ticket) → `{ brands: string[] } | { models: [{ id, brand, model, variants }] }` from trade_models.
- `POST /api/device/declare` extended as above. Apply: fill `imei2`; a declared IMEI that differs from the
  case's keeps the case IMEI and adds a note/flag; `picked` sets the model only when the match is none and the
  case has no model or already has that one (labelled "customer picked"); customerName/customerPhone fill the
  case's customer only when empty.
- **Storage at Apply** (2026-10-17, `storageFromTest` in `lib/domain/phoneLed.ts`): the phone's measurement
  always wins (a different size the customer picked is only flagged) — it is the disk reading of the session's
  device, so it counts however the model was named (code match or the customer's pick). A measured size that
  isn't on the model's list fills nothing and is never replaced by a pick, the model's single size or a guess:
  flagged "Storage: phone measures 1TB, not on file — no trade-in price for that size." and kept on the case (`measuredStorage`, migration 12),
  so the answer says the same instead of "couldn't measure" (MOBILE-API §3c). A size the case already has is kept; a
  model sold in one size takes it; otherwise the customer's pick of that model's size fills it as a CLAIM —
  even when the model code matched — flagged "Storage: the customer said X — the phone couldn't measure it.
  Check Settings › About phone before the trade-in." and recorded `variantSource: "customer"`, so locking the
  trade-in needs the advisor's "Settings › About phone shows X" tick (`checks.storageSeen`). Nothing → the
  answer screen asks with one row of priced chips. The case remembers where its storage came from
  (`variantSource`: measured | catalogue | customer | advisor). "No — choose my phone" followed by the SAME
  model is agreement, not an identity dispute: no "…isn't right" flag.
- Apply also suggests the new phone (`lib/domain/upgrade.ts`) unless staff already chose one, so the case
  comes back with the answer (`offer`, MOBILE-API §3c).
- `POST /api/device/battery` (Ticket) `{ image: dataURL ≤ 3 MB }` → forwards to GradeIQ
  `POST /api/sessions/{id}/ocr { frames: [image] }` → reads `ocr.batteryHealth` → stores result
  `battery_health: { outcome: pct ≥ 80 ? "pass" : "fail" (pct > 0) | "skip" (unreadable), detail: { healthPct, method: "battery screenshot read by GradeIQ" } }`
  → `{ healthPct | null, outcome }`. Add `battery_health` to DEFAULT_PLAN (not critical) and
  `FAIL_FAULT.battery_health = "battery_drain"` (the fault's because: "Battery health 72 % (screenshot)").
- **Counter code**: stores get a permanent 6-char code (CODE_ALPHABET; never equal to DEMO_CODE).
  `GET /api/stores/counter-code` (store_manager/advisor of the store) → `{ code, joinUrl }` (created on first
  read); `POST /api/stores/counter-code/regenerate` (store_manager). Joining with it works like the standing demo
  code, generalised: this install's own open session at that store, else a new session + case
  (created_by = a store manager, audit `via: "counter code"`). `/j/<counter code>` page: the store's name.
- `scanFirstApp(device)`: native Check ≥ 0.6.0 or web ≥ 0.6.0. For those sessions gradingView sends
  `photosUrl: null` (no photos-first), and messages by phonePhase ("Phone identifying itself — scan code next.", "Scan the phone's code, or Take
  photos.", "Phone testing — grade coming.").
  Older apps: unchanged.

## SwapUp Store (≥ 0.6.0) — reduced (owner, 2026-10-17: "Reduce the flow")

1 **New trade-in** (the customer's mobile) → 2 **Connect the customer's phone** (Wi‑Fi + test code) →
3 **ONE camera pass** — the customer's phone shows GradeIQ's camera link as a QR, this tablet's camera
app scans it, and the camera page photographs the phone and sweeps its screen in one go ("Take photos"
opens the same page from here; "Go on without the camera" (`grading.canRelease`) replaces the
customer's skip). Where the camera couldn't decide, **Check the phone** (`TestSessionView.certify`,
MOBILE-API §8b) opens inside this step: Body and Liquid indicator at once, Screen once the phone's
tests are done and it shows the colours, one tap each, by name → 4 **The answer, by itself**: when
the tests and the camera grade (and those taps) are in, the server applies the session with no
"Apply to case" tap (`TestSessionView.autoApply`, MOBILE-API §3 — Apply's gates unchanged; a refusal
shows its one-line reason and a Retry; "Apply the results so far" stays for a phone that stopped
mid-test) and the Session screen opens the answer → 5 **Swap up** opens ONE "Take the trade-in"
screen: the IMEI only if missing, name + mobile prefilled, ID type + last 4, the KYM result, and ONE
hand-over confirm ("Owner confirmed · SIM out · IMEI matches · no EMI/lock") that still sends all four
flags. Repair / Walked away end the visit from the answer.

Gone from the Session screen: the separate photo pass and screen-check pass (two-pass layout — an older
SwapUp Check gets the same single camera pass after its tests), the Identify card, the tests card, the
result cards (summary, device, camera AI, what the customer said — the answer and the grade report
carry them) and the Apply step.

- Settings: **Counter QR** card (manager: show QR + code + "Print" + "New code"; advisor: view).
- Customer-started trade-ins appear on Home like any session (they're the store's sessions); Home flags
  "Check the phone" while the answer waits for the advisor's taps, and "Not on the case" after a refusal.
