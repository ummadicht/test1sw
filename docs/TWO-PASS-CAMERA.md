# Two camera passes — photos first, screen check last

Owner, 2026-10-17: the store flow is **customer (found by mobile) → photos → Wi‑Fi + QR → the
customer's phone downloads/opens SwapUp Check → it tests itself → the tablet's camera checks the
screen colours → continue.** Chosen: "Second camera pass" (AI screen check after the tests) and
"Find by mobile".

Why two passes: GradeIQ's camera page did everything in ONE pass — exterior photos, then the LCD
sweep (the customer's phone shows white/black/red/green/blue for the camera), then a Settings photo.
The sweep needs SwapUp Check open on the phone, which it can't be before the phone has joined. So:
**pass 1 = photos** (no app needed), **pass 2 = screen** (after the tests, phone on its photo screen).

## GradeIQ (~/projects/gradeiq) — additive; no `pass` = exactly today's behaviour

- `/v2/cam/<id>?pass=photos|screen` — `app/v2/cam/[id]/page.tsx` reads `searchParams.pass` and passes
  `pass?: "photos" | "screen"` to `<V2Cam>`. Anything else / absent → today's full pass.
- **pass=photos:** the journey's angles, torch twins and cosmetic grading as today, but: no display
  sweep, no Settings scan, never drives patterns on a "primary" (no `setPatternOnPrimary` calls — there
  is no phone app yet; the front-glass shot must not wait for the primary to dim), and at the end POST
  `/screen {cosmeticDone: true, pattern: "idle"}` **without `handoffDone`** (handoffDone is what tells
  the customer's phone its photo screen is finished — it must only come from pass 2). Done screen: "Photos
  done. Next, the customer's phone tests itself — you'll photograph its screen at the end."
- **pass=screen:** a short prep ("Hold the camera over the customer's phone screen"), then `start()`
  opens the camera and goes straight to the existing `displaySweep()` (closed loop with the phone's
  echo, `/display` report), then POST `/screen {handoffDone: true, pattern: "idle"}`. No angles, no
  `/cosmetic` submit, no rotation video. Done screen: "Screen checked."
- `connected: true` on load stays (each page load re-stamps `connectedAt` — SwapUp relies on that).
- GradeIQ tests/typecheck must stay green; nothing else in GradeIQ changes.

## SwapUp server (~/projects/swapup)

- `lib/server/gradeiq.ts`: `cameraUrl(id, pass?)` appends `?pass=…`.
- `gradingView` (gradeiqBridge.ts) adds:
  - `photosUrl` — `cameraUrl(id, "photos")`, offered as soon as `state === "ready"` and the session is
    open-or-waiting (`waiting|opened|joined|testing|complete`), **no device gating** (the phone isn't
    connected yet — that's the point). Staff-only, like `cameraUrl`.
  - `screenUrl` — `cameraUrl(id, "screen")`, under the SAME gate as today's `cameraUrl` (deviceReady or
    an override).
  - `photosDone` (cosmeticDone seen) and `screenDone` (a displayCheck exists, or handoffAt).
  - `cameraUrl` stays exactly as today (full pass, gated) for SwapUp Store ≤ 0.4.x.
  - Messages for the new states, e.g. after pass 1: "Photos accepted — next, connect the customer's
    phone. The screen check comes after its tests."
- **Pull window:** today it runs 180 s from `gradeiq_cosmetic_done_at`. With photos first, the tests
  take minutes, so pass 2's LCD verdict would never be pulled. The window must run from the LATER of
  cosmetic-done and `handoffAt` (pass 2's end) — `pullWindowOver`, `pullDue`, `storedFinality`
  (timedOut) and `cameraGradePending` all use that. Keep a test-free but obvious helper.
- **Customers:** `GET /api/customers?phone=<10 digits>` (advisor/store_manager; same org only) →
  `{ customer: { name, phone } | null, history: [{ caseId, ref, status, storeName, device, createdAt }] }`
  newest first, max 10, from `cases.customer` JSON (check how createCase/lockTradeIn store the phone —
  normalise to digits). 400 for a bad number. `lib/server/customers.ts` + route.
- Docs: GRADEIQ-INTEGRATION.md (two passes), MOBILE-API.md (photosUrl/screenUrl/photosDone/screenDone,
  /api/customers).

## SwapUp Check (~/projects/swapup-mobile/src/check + src/diagnostics/auto/pairing.ts)

The order on the phone is unchanged (get ready → tests → actions → photo screen → done). Pass 1 now
happens BEFORE the phone joins, so when the photo screen mounts, GradeIQ's `/screen` may already
carry `cosmeticDone: true` and a `capture` verdict from pass 1. Today `trackPoll` treats those as
"camera connected" and leaves 30 s after cosmeticDone ("grace") — it would walk off the photo screen
before pass 2 ran. Fix: baseline them like `connectedAt` — only a cosmeticDone / capture that APPEARS
(or changes) after this screen mounted counts as connected or starts the grace clock. `handoffDone` is
unaffected (pass 1 never sets it). Tests in flow.test.ts for both cases (stale cosmeticDone at mount
→ no grace, still 90 s offer; fresh cosmeticDone → grace as today).
Copy on the photo screen: "Tests done — lay it on the counter, screen up" / "Last step: the advisor's
tablet checks the screen."

## SwapUp Store (~/projects/swapup-mobile/src/store)

- **New trade-in** (`NewTradeIn.tsx`): mobile number FIRST; at 10 digits → `GET /api/customers?phone=`
  → returning customer: name filled in + "N earlier trade-ins" (latest one listed); else a name field.
  Then create (same POST as today).
- **Session screen order** (`Session.tsx`, `CameraParts.tsx`, `SessionParts.tsx`):
  1. **Photograph the phone** — `photosUrl`, available at once ("Take photos"; opens in Chrome/new tab as
     today via openCameraPage). Shows the GradeIQ result when it lands. A "Skip photos" link records
     nothing and moves on (the case then has no camera grade — say so).
  2. **Connect the customer's phone** — the Wi‑Fi QR + test QR + code (today's cards), visually AFTER
     step 1; emphasised once photos are done or skipped.
  3. **The phone tests itself** — today's live progress.
  4. **Check the screen** — `screenUrl`; locked until the phone shows its photo screen (today's
     fail-closed rule + override, now only for this pass); "Check the screen" opens the camera.
  5. Summary → Apply (still waits for `gradePending`) → Continue pricing.
  Fall back to today's single `cameraUrl` card when the server sends no `photosUrl` (older server).
- Docs: swapup-mobile/docs/AUTO-TESTS.md + README; swapup/docs/FLOW.html steps 4–8.
