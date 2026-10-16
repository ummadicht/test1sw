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
`POST /api/auth/handoff` (Bearer) `{ next: "/cases/<id>" }` → `{ url }` — a one-time URL
`/api/auth/handoff/<nonce>` valid 60 s that sets the web session cookie and redirects to
`next`. Load that URL in the WebView.

## 2. Store Wi‑Fi (the network the customer's phone joins)

`GET /api/stores/<storeId>/wifi` (Bearer, counter roles of that store) →
`{ wifi: { ssid, password, security: "WPA"|"WEP"|"nopass", hidden } | null, qr: "WIFI:T:WPA;S:…;P:…;H:false;;" | null }`

`POST /api/stores/<storeId>/wifi` (store_manager / org_admin) `{ ssid, password, security, hidden }`
→ same shape. `{ ssid: "" }` clears it. Special characters `\ ; , : "` are escaped in `qr`.

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
`{ session: TestSessionView, caseId }`.
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
  declared: { screenCracked: boolean|null; backCracked: boolean|null; liquid: boolean|null; imei: string|null } | null;
  progress: { done: number; total: number };
  summary: DiagnosticSummary | null;   // computed whenever results change
  grading: GradingView | null;         // camera grading (§8) — staff responses only
};
type DiagnosticSummary = {
  model: { modelId: string|null; label: string|null; variant: string|null; match: "exact"|"family"|"none"; why: string };
  faults: { id: FaultId; because: string; sources: ("tested"|"declared")[] }[]; // SwapUp fault ids (lib/domain/condition.ts)
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
`200 { ticket, session: { id, caseRef, storeName, plan, server } }`
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

`POST /api/device/results` `{ results: [{ testId, outcome, detail?, at }] }` — batch;
idempotent per `testId` (the latest `at` wins). The app sends after every test and retries
its queue until acknowledged → `{ ok: true, received: n, progress }`.

`POST /api/device/complete` `{}` → `{ ok: true, summary }`.

`GET /api/device/status` → `{ status, progress, storeName, caseRef }` (lets the app show
"The store has your results").

**Photo check** (between the damage questions and the tests — §8). "Lay your phone on the
counter": poll about every 700 ms, show `pattern` full-screen, echo what is on screen.

`GET /api/device/screen` →
`{ state, pattern, shown, cosmeticDone, handoffDone, capture: { verdict, code, reasons[], attempt } | null }`
- `state`: `disabled` or `failed` → skip the photo check and run the tests; `pending` → wait;
  `ready` → show `pattern` (`idle` | `white` | `black` | `red` | `green` | `blue` | `stripes`).
- `capture.verdict = "retake"` → the store's photos were rejected (show `reasons`; stay on the
  screen — the store retakes).
- Leave for the tests when `handoffDone` is true, or 30 s after `cosmeticDone`.
- `503 { error }` → the server can't reach GradeIQ just now: keep the screen, keep polling.
- Never carries the GradeIQ session id or the camera URL.

`POST /api/device/screen` `{ shown: "<pattern actually on screen>" }` → `{ ok: true }`. The first
echo is what unlocks the store's camera button.

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

Store-app flow: wait for `grading.deviceReady` → button **Take photos** opens `grading.cameraUrl`
in Chrome (`Linking.openURL`, not the WebView: the page needs the camera, HTTPS and, on Android,
the torch) → watch `grading.capture` / `grading.assessment` → Apply.

```ts
type GradingView = {
  state: "disabled" | "pending" | "ready" | "failed";
  message: string;                 // one line for the top of the card
  error: string | null;
  canRetry: boolean;               // show Retry → POST …/grading-retry
  deviceReady: boolean;            // the customer's phone is echoing patterns
  cameraConnected: boolean;
  cameraUrl: string | null;        // GradeIQ /v2/cam/<id> — ONLY when deviceReady (or overridden); never in a QR
  cameraLocked: string | null;     // why the camera button is locked
  canOverride: boolean;            // offer "Start without the customer's phone" → …/camera-override {reason}
  override: { by: string; reason: string; at: string } | null;
  screenReadable: boolean;
  pattern: string | null; cosmeticDone: boolean; handoffDone: boolean;
  capture: { verdict: string; reasons: string[] } | null;   // e.g. "retake" + reasons
  sync: { state: "idle" | "in_sync" | "sending" | "retrying"; error: string | null; forwardedAt: string | null };
  outOfSync: boolean;              // show "GradeIQ out of sync, retrying" — SwapUp's own results stay authoritative
  assessment: AssessmentView | null;
  disagreements: { topic: "screen"|"back"|"display"|"identity"; customer: string|null; tested: string|null;
                   camera: string; final: string; message: string; photoIndex: number|null; box: Box|null }[];
  timedOut: boolean;               // stopped waiting 180 s after the photos were accepted
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
- **Camera lock fails closed.** `cameraUrl` is null until GradeIQ's `/screen` reports the
  customer's phone echoing (`shown` is a string). Unreadable `/screen` → `cameraLocked` says so;
  only `camera-override` with a reason unlocks it, and the LCD is then "not camera-checked".
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
