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

## The customer's phone (SwapUp Check ≥ 0.6.0) — Identify › Scan › Test › Result

A step rail on every screen: **Identify · Scan · Test · Result**.

1. **Join** (unchanged): store QR / link / 6-char code / deep link — or the store's **counter code**.
2. **Identify**
   - "Let's check this phone." Card: "**Samsung Galaxy S23 Ultra · 256 GB**" + "Your phone calls itself SM-S918U"
     (from the join response's `identity`). Buttons "Yes, that's my phone" / "No — choose my phone".
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
   fallback SETTINGS); leave on handoffDone (and the existing grace/escapes: 90 s no camera, stalls).
   Copy for the skip button: "Skip the camera check" → "The advisor then checks the screen by eye."
4. **Battery health** (new): per-platform guide (Samsung: Settings › Battery › Battery information — or
   Samsung Members › Diagnostics › Battery status; Pixel: Settings › Battery › Battery health; other
   Android: Settings › Battery). "Take a screenshot of it, then choose it here." **Choose screenshot**
   (expo-image-picker, images only, quality 0.6, max ~1600 px) → `POST /api/device/battery {image}` →
   "Battery health **87 %**" (or "Couldn't read it — try a clearer screenshot" / "Skip").
5. **Test**: GetReady → automatic tests → swipe squares → charger (unchanged).
6. **Result**: "Checks complete — the advisor will confirm your price." Ref, store, Passed / Failed /
   Not tested, "Screen and glass: checked by the store's camera" (or by eye), battery health %.
   Never a price or a grade letter. After Apply: the existing "store has your results" + clear-your-phone guide.

`nativeStep`: identify → scan → battery → auto → actions → done (resume-safe: `identifiedAt`,
`pairing`, `battery` records in CheckState). `POST /api/device/phase {phase}` on each step change.
**Browser build** (iPhones / no APK): the same order where it can — Identify (no model code → picker),
Scan (PairingScreen on web: no brightness control → "Turn your brightness all the way up"; Wake Lock if
available), Battery (file input via expo-image-picker web), then today's interactive tests, Done.

## SwapUp server

- **Migration 9**: `test_sessions.phone_phase TEXT`, `phone_phase_at TEXT`; `stores.counter_code TEXT` (unique when set).
- `GET /api/device/camera-link` (Ticket): `{ url: cameraUrl(gradeiq_id) }` when `gradeiq_state = ready`; 409
  "The camera check isn't ready yet" otherwise (the phone retries). The full pass, no `pass` param.
- `POST /api/device/phase` (Ticket) `{ phase: "identify"|"scan"|"battery"|"test"|"done" }` → `{ok}`; staff view `phonePhase`.
- Join response gains `identity: { label, match: "exact"|"family"|"none", reason, variant, modelId }` (matchModel; no prices).
- `GET /api/device/models?brand=` (Ticket) → `{ brands: string[] } | { models: [{ id, brand, model, variants }] }` from trade_models.
- `POST /api/device/declare` extended as above. Apply: fill `imei2`; a declared IMEI that differs from the
  case's keeps the case IMEI and adds a note/flag; `picked` used only when the match is none and the case has
  no model (labelled "customer picked"); customerName/customerPhone fill the case's customer only when empty.
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
  `photosUrl: null` (no photos-first), and messages by phonePhase ("identifying itself", "showing its scan
  code — scan it with your camera, or Take photos", "testing itself — the camera grade is being worked out").
  Older apps: unchanged.

## SwapUp Store (≥ 0.6.0)

- Scan-first session layout (when the server sends no `photosUrl` and the phone is scan-first):
  1 Customer's phone joins (QR / code, as today) → 2 **Identify** (what the customer confirmed/picked, IMEI 1/2
  with check pill, "IMEI differs from the one recorded") → 3 **Scan** ("The customer's phone shows a QR — scan it
  with this tablet's camera app", plus "Take photos" = open `cameraUrl` here, existing gate/override) → 4 Tests
  (+ battery health %) → Summary → Apply → Continue pricing.
- Settings: **Counter QR** card (manager: show QR + code + "Print" + "New code"; advisor: view).
- Customer-started trade-ins appear on Home like any session (they're the store's sessions).
