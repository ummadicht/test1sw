# Integration contract: GradeIQ as SwapUp's grading engine

Status: researched 2026-10-16 as a proposal; **the decisions in §6 were taken and the SwapUp
server side is built** (`su/lib/server/gradeiq.ts`, `gradeiqBridge.ts`, `su/lib/domain/gradeiqMap.ts`).
Not deployed. The SwapUp Check pattern-echo screen and the Store app's camera button are not built yet.

Path prefixes used below:
- `giq/` = /Users/ammar/projects/gradeiq
- `su/` = /Users/ammar/projects/swapup
- `sum/` = /Users/ammar/projects/swapup-mobile
- `ciq/` = /Users/ammar/projects/retail-portal (CounterIQ)

## 0. Where things stand today

- **SwapUp does not use GradeIQ or Pandas today.**
  - `su/app`, `lib`, `components`, `docs` and `scripts` contain no reference to either (grep).
  - `sum/src/diagnostics/grading.ts:1` says it is a "Verbatim port of GradeIQ web lib/grading.ts", but nothing imports it (grep). It is dead code.
  - The only other traces are names: `sum/src/shared/storage.ts:7-8`, and an unused `ingestUrl` setting at `sum/src/shared/types.ts:44-51`.
  - SwapUp grades phones with its own `summarise()` (`su/lib/domain/diagnostics.ts:262-343`). It prices through the buyback partner, not GradeIQ (`su/README.md`, "Trade-in value").
- **GradeIQ's "Pandas-style cascade" is one Gemini call.** That call returns the intake check, 5 component grades, the device identity and the OEM-parts verdict. The final grade is then worked out by ordinary code (`giq/lib/visionAgents.ts:405-448, 612-667`; `giq/lib/inspectionCatalog.ts:268-271`). The per-specialist function `runSpecialist` has no callers (`visionAgents.ts:332-403`). Don't sell it to anyone as a set of independent agents.
- **Where GradeIQ actually runs (checked today, read-only):**
  - pm2 `gradeiq` has been online for 42 days on **104.197.168.25** (the denovo-erp VM), listening on :3700.
  - That is the same VM as pm2 `swapup` on :4500 (`su/deploy/deploy.sh:9`).
  - From that VM, `http://127.0.0.1:3700/apps/gradeiq/v2` returns 200, and an unknown session id returns 404.
  - `swapmore.com` resolves to 35.253.69.52, which proxies `/apps/gradeiq` to the VM above. Responses carry two `via: Caddy` headers.
  - `~/projects/ESTATE.md:18` and `giq/deploy/deploy.sh:16` still name 35.253.69.52. Both are out of date.

## 1. What GradeIQ gives SwapUp

| Product | Where it lives in GradeIQ | Use in SwapUp |
|---|---|---|
| Functional grade | `functional_grade` = `Working` / `Faulty` / `''` (`giq/lib/grading.ts:51`) | **Show it, but don't make it the verdict.** It says `Working` when critical tests were skipped or unsupported (§5 #2). SwapUp's own `incomplete` / `faults_found` / `all_passed` stays authoritative. |
| AI cosmetic grade and defects | `cosmetic_grade` (Premium/A/B/C/D) and `cosmetic` (VisionCascadeResult, `giq/lib/visionAgents.ts:120-141`) | **Yes.** This is the new capability. Each finding has a type, severity, confidence, photo index and box. Each component has a grade and confidence. Also returned: score, coverage, conclusive, gradeRange, needsHumanReview, obstruction, oem, device identity. |
| Camera LCD check | `screen.displayCheck` {verdict, confidence, findings, captures, requested, missing, reason} (`giq/app/api/sessions/[id]/display/route.ts:57-70`) | **Yes.** It is kept separately from SwapUp's own dead-pixel self-test. |
| Overall grade | `overall_grade`, e.g. `B · Working` / `B · FAULTY` (`giq/lib/grading.ts:69-78`) | **Display only.** It is a text concatenation. The cap the code comment promises does not exist (`grading.ts:66-68`). |
| DeviceFax | JSON: `GET /api/report/{id}/export` (`giq/app/api/report/[id]/export/route.ts:37-78`). Printable HTML: `GET /api/sessions/{id}/passport` | **Snapshot the JSON when results are applied to the case. Don't show the HTML to customers until §5 #6 is fixed.** |
| Price, offer, trust | `/offer`, `/value`, `offer` column | **Never.** SwapUp's price comes from the partner. |

### Environment variables (SwapUp server only)

| Variable | Value | Why |
|---|---|---|
| `GRADEIQ_BASE_URL` | `http://127.0.0.1:3700/apps/gradeiq` | Same VM, so server-to-server calls skip both public proxy hops. The basePath is compiled in (`giq/next.config.ts:5-10`), so `/apps/gradeiq` is required even on localhost. |
| `GRADEIQ_PUBLIC_URL` | `https://swapmore.com/apps/gradeiq` | For the camera-page link on the store device, the passport link, and turning stored photo paths (`/api/uploads/...`) into public URLs. SwapUp already builds links on the server (`su/lib/server/testSessions.ts:105-116`). No `NEXT_PUBLIC_` copy is needed, which avoids CounterIQ's build-time-URL failure (`ciq/deploy-spectrum.sh:40-48`). |
| `GRADEIQ_CLIENT` | `swapmore-in` (decided, §6) | The existing INR tenant until GradeIQ gets a dedicated `swapup` one (§5 #3). Any unknown value silently becomes `default` (EUR) (`giq/app/api/sessions/route.ts:18`), so SwapUp rejects a create whose echoed `client` differs. |
| `GRADEIQ_CHANNEL` | `retail` | Reuses the retail capture journey CounterIQ already exercises. `/value` keys its price-withholding on this channel (`giq/app/api/sessions/[id]/value/route.ts:29-38`). |
| `GRADEIQ_TIMEOUT_MS` | 5000 (create: 20000) | Create can wait on IMEI and Phonecheck lookups (`giq/app/api/sessions/route.ts:31-38`). |
| `GRADEIQ_ENABLED` | `1` / `0` | `0` is a labelled kill switch back to today's flow, where the advisor checks condition by eye. It is **not** a demo mode. |

- There is no demo or pilot variable, and none should be added. These are the CounterIQ patterns not to copy: `ciq/lib/gradeiq.ts:12` (demo is on unless set to 0), `:46-50` (a pilot session shared by every purchase), `:65` (`demo_` ids), and `:123-138` (`demoAssessment`).
- **Deploy gate:** `su/deploy/deploy.sh` should run `curl $GRADEIQ_BASE_URL/api/sessions/00000000-0000-4000-8000-000000000000` on the VM and require a 404. Any other answer fails the deploy. That curl returned 404 today.

### Calls SwapUp makes (server only; only the camera page talks to GradeIQ directly)

| # | Call | When | Body | Read back |
|---|---|---|---|---|
| 1 | `POST /api/sessions` | After a SwapUp test session commits | `{"client":"swapmore-in","channel":"retail","segment":"c2b","model":"<SwapUp model label, only if the case has one>"}` — **never an IMEI** (decided, §6) | `id` (UUID) and `client`. **Reject the session if `client` ≠ `GRADEIQ_CLIENT`.** The response shape is at `route.ts:132`. Never send `demographic`: an invalid value makes GradeIQ return 500 (`giq/lib/profiles.ts:159-164`). `c2b` is a valid segment (`profiles.ts:13, 123`). |
| 2 | `POST /api/sessions/{id}/device` | Phone joins; customer declares the IMEI | `{"device":{"source":"swapup-check","brand":…,"model":modelName,"os":"Android <osVersion>","storageGB":<only from an exact SwapUp variant match>,"imei":"<declared>"},"model":"<SwapUp label, only when match = exact>"}` | Nothing. Note that it fills `imei` and `model` only when they are empty, and runs **no** IMEI lookup (`giq/app/api/sessions/[id]/device/route.ts:35-44`). |
| 3 | `POST /api/sessions/{id}/functional` | After each `/api/device/results` batch | `{"functional":{…all 18 ids…},"merge":true}`. Always the **full** mapped map, always `merge:true`. | `verdict`. A body without `functional`, or without `merge`, **wipes** every stored result (`functional/route.ts:17, 20-22`). |
| 4 | `GET` / `POST /api/sessions/{id}/screen` | Proxied for the customer's phone during the photo check | POST `{"shown":"<pattern>"}` | `{pattern, shown, cosmeticDone, handoffDone, capture, connectedAt}` (`giq/app/api/sessions/[id]/screen/route.ts:113-130`). An unknown id returns `idle`, not 404 (`:100`). |
| 5 | `GET /api/sessions/{id}` | After `cosmeticDone`, until the grade is final | — | `cosmetic_grade`, `cosmetic.*`, `functional_grade`, `overall_grade`, `screen.capture`, `screen.displayCheck`, `identity`, `photos`. **Ignore `offer`, and drop `staged`**: it holds base64 copies of every photo (`cosmetic/route.ts:146-153`), so each response can be megabytes. |
| 6 | `GET /api/report/{id}/export` | At Apply (by itself once the tests and grade are in, or the advisor's Retry) | — | DeviceFax JSON with its signature. It contains no price and no `staged`. Its photo URLs are built from the request's own origin (`export/route.ts:32-35`), so rewrite them to `GRADEIQ_PUBLIC_URL`. |
| 7 | `POST /api/sessions/{id}/ocr` (since 2026-10-17) | SwapUp Check ≥ 0.6.0 uploads a battery-health screenshot (`POST /api/device/battery`) | `{"frames":["data:image/…;base64,…"],"kind":"battery"}` — one frame | `ocr.batteryHealth` (1–100, else nothing legible). Timeout `GRADEIQ_OCR_TIMEOUT_MS`, default 30 s: one vision call, and the route answers with the **whole session** (`staged` photos included) beside `ocr`. See §7 for what GradeIQ does with the screenshot. |

**Calls SwapUp must never make:**

| Call | Why not |
|---|---|
| `POST /offer`, `POST /accept` | Unauthenticated. `/offer` re-runs a paid Phonecheck lookup (`offer/route.ts:17-19`). |
| `GET /value` | Its trust score counts "no tests run" as 70 (`giq/lib/trust.ts:40-45`). |
| `POST /grade-manual` | Anonymous, and overwrites the AI grade (`grade-manual/route.ts:8-35`). |
| `POST /reprocess` | Needs a GradeIQ staff cookie (`reprocess/route.ts:55-57`). |
| `GET /api/customers/sessions/{id}` | Returns 500 on prod because `KEYCLOAK_ISSUER` is unset (`giq/lib/serviceToken.ts:10-11`). |
| `POST /event` | Returns 500 when `detail` is over 500 characters (`event/route.ts:24-27`). |
| Iframing `/report/{id}` | It renders GradeIQ's own price and an Accept button for every channel (`giq/app/report/[id]/page.tsx:174-177`; `OfferPanel.tsx:23, 35`). |

## 2. The flow at a SwapUp counter

**Roles**

| Who | Runs | Job |
|---|---|---|
| **Customer's phone** (the phone being traded) | SwapUp Check: Android app, or `/app/check/` in a browser | Joins, answers the damage questions, **shows the screen patterns the camera asks for**, then runs the 18 functional tests. |
| **Store device** | SwapUp Store: app, or `/app/store/` | Creates the session, shows the join QR, **opens GradeIQ's camera page `/v2/cam/{id}` and photographs the customer's phone**, watches results, applies them to the case. |
| **SwapUp server** | `su/` | The only thing that calls GradeIQ's API. The GradeIQ UUID never reaches the customer's phone — **except** that SwapUp Check ≥ 0.6.0 shows the camera link as its scan code (§7, owner's decision 2026-10-17). |

**Steps**

1. **The advisor taps "New customer trade-in".**
   - `createTestSession` runs (`su/lib/server/testSessions.ts:198-219`).
   - After the insert commits, the server creates the GradeIQ session (call 1) in the background, so a slow GradeIQ never blocks the counter.
   - It stores `gradeiq_id` and `gradeiq_state` (`pending`, then `ready` or `failed`).
2. **The customer joins** through the Wi-Fi QR and the test QR (`joinByCode`, `testSessions.ts:348-378`). The server forwards the device report (call 2).
3. **The customer answers the damage questions** (`deviceDeclare`, `testSessions.ts:391-397`). A declared IMEI is forwarded with call 2.
4. **Photo check, customer's phone first.**
   - SwapUp Check enters a "Lay your phone on the counter" screen.
   - It polls a new ticket-authenticated `GET /api/device/screen` about every 700 ms, shows the requested pattern full-screen, and posts `{shown}` to a new `POST /api/device/screen`.
   - The SwapUp server proxies both to GradeIQ (call 4). This copies what GradeIQ's own `/v2` page does (`giq/app/components/V2Flow.tsx:242-265, 276, 796-808`).
   - When GradeIQ's `/screen` returns `shown` as a string, the customer's phone is ready (the same test CounterIQ uses, `ciq/lib/gradeiq.ts:221`). Only then does the Store app enable "Take photos".
5. **The store device takes the photos.**
   - It opens `{GRADEIQ_PUBLIC_URL}/v2/cam/{id}` in Chrome.
   - The camera page runs: a prep gate (case off, screen wiped) (`V2Cam.tsx:300-304`); 6 manual stills; torch-lit copies on Chrome/Android only (`:562-640`); a black screen on the customer's phone for the front-glass shot (`:891-897`); the screen sweep (white, black, stripes, red, green, blue) (`:1176-1199`); and a photo of the Settings screen (`:1287-1386`).
   - It uploads everything once, in the background (`:1100-1113`), then posts `handoffDone:true` **only after the sweep and the Settings photo** (`:1116-1125`).
6. **Functional tests.** When `/screen` shows `handoffDone` (or 30 s after `cosmeticDone`, as `V2Flow.tsx:254-262` does), SwapUp Check leaves the paired screen and runs the 18 tests. Each batch goes to `/api/device/results` as today and is forwarded (call 3). The AI grade (Flash 8–30 s, then Pro in the background, per the comments at `cosmetic/route.ts:209-210, 385-386`) is computed while the customer is testing.
7. **Complete.** The Store app shows four things: SwapUp's verdict, the GradeIQ cosmetic result (final or provisional), the camera LCD check, and every place where the customer, the tests and the camera disagree.
8. **Apply** (by itself — SwapUp applies the session once the tests and the camera grade are in; MOBILE-API §3). The DeviceFax JSON is snapshotted (call 6), and the faults and condition are merged as described in §3.

**Why the customer's phone must come first.**
- The LCD check is a closed loop between the two phones.
- If the camera starts before the customer's phone is echoing patterns, the sweep gives up after 4 s (`V2Cam.tsx:1189-1195`). The front shot also loses its black-screen step.
- The photos still pass and a grade still comes back, but **the LCD was never checked, and nothing says so.** CounterIQ shipped exactly this bug (`ciq/lib/gradeiq.ts:172-187`).
- ~~Photos come before the tests~~ — **changed 2026-10-16 (owner: "this is the customer's app"):
  SwapUp Check now runs its tests FIRST and shows the photo screen LAST**, so the customer never
  sits waiting for the store's camera; the advisor has the whole test run to open the camera page.
  The closed loop above still holds: the camera stays locked until the phone echoes. GradeIQ has
  no ordering guard — `functional/route.ts` merges at any time, and `persistCosmetic`
  (`cosmetic/route.ts:418-436`) folds whatever functional results already exist into the
  assessment. Costs: the AI grade (8–30 s) now runs after the tests instead of during them, and
  GradeIQ's camera page still says the phone "can proceed to its functional tests" at the end.
- **Two camera passes — photos first, screen check last (2026-10-17, `su/docs/TWO-PASS-CAMERA.md`).**
  Owner's counter order: customer (found by mobile) → photos → Wi‑Fi + QR → the phone downloads/opens
  SwapUp Check → it tests itself → the store camera checks the screen colours → continue. Only the
  sweep needs the phone, so GradeIQ's camera page takes a `pass`:
  - **Pass 1, `/v2/cam/{id}?pass=photos`** — angles, torch twins and the cosmetic grade; no sweep, no
    Settings photo, never drives a pattern on the phone. Ends with `/screen {cosmeticDone:true}` and
    **no** `handoffDone`. SwapUp offers it as `grading.photosUrl` the moment the GradeIQ session is
    `ready` — before the phone has joined, so it is not behind the camera lock.
  - **Pass 2, `/v2/cam/{id}?pass=screen`** — after the tests, with the phone on its photo screen: the
    existing closed-loop `displaySweep()` (`/display` report), then `/screen {handoffDone:true}`.
    `grading.screenUrl`, behind the same fail-closed lock as before (deviceReady or an override).
  - No `pass` = the single pass as before; `grading.cameraUrl` keeps it for SwapUp Store ≤ 0.4.x.
  - The closed loop still holds: the sweep only runs against a phone that is echoing. What moved is
    the photos, which never needed the phone. SwapUp Check ignores a `cosmeticDone` / `capture` that
    was already on `/screen` when its photo screen mounted (pass 1's), so it waits for pass 2.
  - The pull window now opens at the LATER of the photos and the handoff (§3.3).

**Fail closed, not open.**
- CounterIQ unlocks the camera whenever `/screen` can't be read (`ciq/lib/gradeiq.ts:215` plus `RetailDesk.tsx:1269`).
- SwapUp must do the opposite and show "Can't confirm the customer's phone is ready".
- An override needs a name and a reason, and is recorded as **"LCD not camera-checked"**.

**Practical requirements**

- **Open the camera page in Chrome, not in the Store app's WebView.**
  - `WebScreen` opens any other site outside the app (`sum/src/store/screens/Web.tsx:39-46`) and sets no camera grant (`:94-100`).
  - Use `Linking.openURL`. The page needs HTTPS. The torch works only in Chrome on Android, and iOS never gets torch photos (`V2Cam.tsx:562-640`).
- **Prefer a button on the staff device over a QR code.** The camera URL carries the GradeIQ UUID, which is the only key to that session, so it should not be shown where the customer can photograph it.
  - **Overruled for SwapUp Check ≥ 0.6.0 (owner, 2026-10-17, §7):** the customer's phone now shows exactly that URL as a QR, as GradeIQ v2 does. The risk below is accepted, not removed.
- **The pattern-echo screen is new work in SwapUp Check**, in both the native and the web build. GradeIQ assumes its own `/v2` page plays that role.
- **Unclear:** the Settings-screen photo step needs the customer's phone to leave Check and open Settings. I could not confirm whether a journey config can switch this step off. The Check app should at least offer an "Open Settings › About phone" button during it. (SwapUp Check ≥ 0.6.0 does — `docs/PHONE-LED-FLOW.md` step 3.)

## 3. How results flow

### 3.1 Session lifecycle

- **One GradeIQ session per SwapUp test session.** Store `gradeiq_id` on the `test_sessions` row (`su/lib/server/testSessions.ts:53-74` needs new columns).
- **Retries can create duplicates.** GradeIQ has no idempotency key; the `external_id` it reads does not exist (`giq/lib/pandasResult.ts:98`). So allow one create in flight per test session. After an ambiguous timeout, create a new session and record the orphaned id.
- **Reissue or cancel** (`testSessions.ts:269-289`): abandon the old GradeIQ session. A new code means a new GradeIQ session, because the photos belong to that phone.
- **Send an IMEI at create only if the case already has one.** Every create with a 15-digit IMEI makes paid Phonecheck calls; the v2 ESN check uses up a licence (`giq/lib/phonecheck.ts:501-508`).

### 3.2 Forwarding functional results

- **Send the full map every time.** After `deviceResults` commits (`testSessions.ts:399-410`), enqueue one forward per session, one request at a time. Each request sends the **whole** SwapUp map, already merged and ordered by `at` (`su/lib/domain/diagnostics.ts:447-456`), with `merge:true`.
- **Why the full map:**
  - GradeIQ reads the session before awaiting the request body (`functional/route.ts:13, 16`), so overlapping posts can lose results.
  - It has no `at`, so a stale retry would otherwise win.
  - Sending the full map serially makes every forward idempotent and self-healing.
- **Never forward inside the database transaction.**
- **Outcomes:** `pass`→`pass`, `fail`→`fail`, `skip`→`skip`, `unsupported`→`skip`. GradeIQ would store any string as-is (`functional/route.ts:17-22`), and the passport would then render an item state its type doesn't allow (`giq/lib/passport.ts:33, 229`). SwapUp keeps `unsupported` and all `detail` on its own side; GradeIQ ignores `detail`, including the camera `side` (`functional/route.ts` never reads it).

**Test id mapping.** The 18 ids and the 6 critical flags are identical on both sides: `giq/lib/tests.ts:22-155` and `su/lib/domain/diagnostics.ts:77-96`.

| id | SwapUp name | GradeIQ name | Critical | Problem |
|---|---|---|---|---|
| touch | Touchscreen | Touchscreen | yes | — |
| multitouch | Multi-touch | Multi-touch | no | — |
| display | Display / dead pixels | Display / dead pixels | yes | **Shared key.** The camera sweep overwrites it, and an inconclusive AI check becomes `skip` (`display/route.ts:52-54`). Send `display` = the worse of (SwapUp self-test, `screen.displayCheck.verdict`), with fail > pass > skip. Show both results separately. |
| motion | Gyroscope / accelerometer | same | no | — |
| mic | Microphone | Microphone | yes | — |
| speaker | Speaker | Speaker | yes | Mode differs (`tests.ts:79`); grading ignores mode. |
| voice | **Earpiece** | **Voice / microphone** (`tests.ts:84-91`) | no | **Same id, different hardware.** DeviceFax mislabels it as the microphone. |
| camera | Cameras (front + rear) | same | yes | `detail.side` is dropped. SwapUp keeps it for the front/rear fault (`diagnostics.ts:287-291`). |
| flash | Flashlight | Flashlight | no | Native test; not on DeviceFax. |
| faceid | **Biometrics** (any platform) | **Face ID**, iOS only (`tests.ts:104-112`) | no | **Hidden on Android** in the passport (`passport.ts:225-226`). |
| vibration | Vibration motor | Android only (`tests.ts:121`) | no | Fine for the Android app. A browser Check on iPhone would be hidden. |
| buttons | Hardware buttons | same | no | — |
| battery, charging, connectivity, sensors, bluetooth, nfc | as named | as named; native only (`tests.ts:145-153`) | charging: yes | **Counted in GradeIQ's verdict but never listed on DeviceFax** (`passport.ts:225-231`) or in the Pandas payload (`pandasResult.ts:83-91`). |
| battery_health | Battery health (≥ 0.6.0) | — (GradeIQ has no such test) | no | **SwapUp-only, never forwarded** (`gradeiqFunctionalMap` skips it). It is GradeIQ's own `/ocr` reading of a screenshot (call 7), which GradeIQ already keeps in its session's `ocr`. So the "18 ids" above stay 18 on the GradeIQ side. |

Two comments wrongly claim the names are identical: `sum/src/diagnostics/catalog.ts:1-5` and the gradeiq-mobile catalog.

### 3.3 Pulling the assessment

- **While photos are being taken:** while the Store app is watching, `GET /screen` (light) every 2 s. It shows `capture.verdict` (for example `retake` with reasons) and `cosmeticDone`.
- **After `cosmeticDone`:** `GET /api/sessions/{id}` every 5 s until the grade is final, for at most 180 s. Then stop and keep the last snapshot.
  - **The 180 s run from the LATER of `cosmeticDone` and `handoffDone`** (as SwapUp first saw each — `pullWindowStart` in `su/lib/domain/gradeiqMap.ts`). With two camera passes the screen check comes minutes after the photos; a window counted from the photos alone would have closed before the LCD verdict existed. The handoff reopens it, so the verdict (and a grade still refining) get their own 180 s. No photos accepted = no window; Apply still pulls once.
  - Between the passes, a grade that is already final is not pulled again (each pull downloads the whole session, photos and all); the pulls resume at the handoff until the LCD verdict is in.
- **A cosmetic grade is final only when all of these hold:**
  - `cosmetic_grade` is not empty.
  - `cosmetic.tierUsed` ≠ `stub`.
  - `cosmetic.refining` is not `true`.
  - `screen.capture.verdict` = `ok`.
  - No `obstruction.present` (a case on the phone).
  - Not a stand-in: `cosmetic.pendingVerification` is not set (2026-10-18). GradeIQ's "Pro busy → Flash
    stands in" grade is read as a **provisional** grade only — from `cosmetic_grade`, or from
    `cosmetic.grade` when `cosmetic_grade` is empty — "Stand-in grade, pending verification — not used
    yet." It is shown, never applied, never final (`readSnapshot` / `finality`).
- **Always show `conclusive`, `gradeRange` and `needsHumanReview`** next to the letter. The code itself records cases where Flash and Pro disagreed (`visionAgents.ts:1037-1059`).
- **GradeIQ's `status` can't be trusted.** A session with only a cosmetic grade still reads `open` (`giq/lib/recompute.ts:9-14`). Ignore it.
- **Snapshot stored on the SwapUp row:**
  - `fetchedAt`
  - `cosmetic_grade`, `tierUsed`, `visionModel`, `refining`, `conclusive`, `gradeRange`, `coverage`, `score`
  - `specialists` (each with grade, confidence and findings)
  - `obstruction`, `oem`, `device`
  - `screen.displayCheck`
  - `identity` {verdict, flags}
  - photo URLs
  - the DeviceFax JSON, added at Apply

### 3.4 Mapping GradeIQ cosmetic results onto SwapUp condition answers and faults

**"Confirmed" means** confidence ≥ 0.7, not `uncorroborated`, and the finding has a box. That is the same bar GradeIQ's own structural rule uses (`visionAgents.ts:704-737`).
- The AI may only make a SwapUp answer **worse**. This is the same rule as `mergeCondition` (`su/lib/domain/diagnostics.ts:359-372`).
- SwapUp's condition types are in `su/lib/domain/condition.ts:46-60` and its faults in `:140-157`.
- GradeIQ's finding types are `scratch | crack | chip | dent | scuff | wear | discoloration | deadpixel` (`giq/lib/inspectionSchema.ts:25-36`). Its components are `front | back | frame | cameras | display` (`visionAgents.ts:58`).

| GradeIQ evidence | SwapUp condition (at least) | SwapUp fault | Notes |
|---|---|---|---|
| `front`: confirmed `crack`, or confirmed `chip` that is moderate or severe | screen `cracked` | `screen_cracked` | Physical damage, so it affects warranty (`condition.ts:141`). |
| `front`: unconfirmed crack, or minor chip | no change | — | Flag: "Camera may have seen a crack or chip. Look at photo N." |
| `front`: moderate or severe `scratch`/`scuff`/`wear`, or front grade B/C with such findings | screen `scratched` | — | GradeIQ's A means "faint micro-scratches" (`giq/lib/gemini.ts` rubric), so A and Premium leave screen `flawless`. |
| `display` component, from screen-on frames only: confirmed `deadpixel`/`discoloration`; **or** `screen.displayCheck.verdict = fail` | screen `lines_or_spots` | `display_lines` | Without screen-on frames, the code drops the display grade (`visionAgents.ts:497-521`). |
| `displayCheck` missing, `unknown`, or `missing[]` not empty | no change | — | "LCD not camera-checked" plus `displayCheck.reason`. |
| `back`: confirmed `crack`/`chip` | body `back_cracked` | `back_cracked` | — |
| `back`: moderate or severe `scratch`/`scuff`/`wear` | body `scuffed` | — | — |
| `frame`: confirmed `dent` | body `dented` | — | SwapUp has no dent fault. |
| `frame`: confirmed `crack`, or a severe dent whose label or location describes a bend | body `bent` | `frame_damage`, **suggested only** | There is no "bend" finding type. `frame_damage` has no part and needs inspection (`condition.ts:147`). |
| `frame`: moderate or severe `scuff`/`scratch`/`wear` | body `scuffed` | — | — |
| `cameras`: confirmed `crack`/`chip` on lens glass | — | `rear_camera` or `front_camera`, **suggested only** | Decide with the functional `camera` result and its `side`. |
| `obstruction.present` (case or cover) | no change | — | The grade is not used. "Remove the case and retake." Pricing in GradeIQ also blocks on this (`giq/lib/pricing/engine.ts:399-411`). |
| `oem.verdict = suspect_aftermarket` | no change | — | Note: "possible non-original part". SwapUp has no field for this. |
| component grade `''` (not assessed) | no change | — | List it: "The camera did not see the <component>." |
| D grade with no confirmed structural finding | no change | — | Needs a human: show `needsHumanReview`. |

- The grade letter and score are **shown to staff, never priced**. The partner prices SwapUp's condition answers.
- AI-derived faults enter the case only at Apply, alongside the tested faults (`applyTestSession`, `testSessions.ts:256`). Each is tagged with `source: camera_ai`, so the case model needs a per-fault source.

### 3.5 Disagreements: keep every source, overwrite none

Store four layers separately and show them side by side:
- what the customer declared (`declared`, existing column);
- what the phone tested (`results`, existing);
- what the camera saw (`gradeiq_snapshot`, new);
- what the advisor finally recorded.

| Case | Final condition | Shown |
|---|---|---|
| Customer said "not cracked"; camera confirmed a crack | `cracked` (worse wins) | "Customer: not cracked · Camera: cracked (86%, photo 1)", with a link to the boxed photo. |
| Customer said "cracked"; camera saw no crack | `cracked`. **The AI never downgrades a customer's damage declaration.** | "Camera did not see a crack. Check by eye." |
| Self-test display pass; camera sweep fail (or the reverse) | `lines_or_spots` | Both results, labelled. |
| Advisor records something better than camera-confirmed damage | Allowed only with a name and reason, stored as an override | The AI value stays visible. `conditionFloor` (`condition.ts:209-221`) should treat camera-confirmed structural faults like any other fault. |
| Camera `device.match = mismatch`, or `identity.verdict = mismatch` | Blocks the quote, server-side | Rule R7 from the CounterIQ review. **A missing identity counts as `unverified`, never as a pass** (CounterIQ got this wrong: `ciq/lib/identityGate.ts:135-136`). |

## 4. Failure behaviour

| Situation | How SwapUp detects it | Store app shows | Customer's phone | Case |
|---|---|---|---|---|
| GradeIQ unreachable or 5xx at create | Timeout or error on call 1 | "Camera grading unavailable. Check condition by eye." with a Retry button | Tests run as today | Condition is advisor-recorded, marked `source: advisor` |
| Wrong tenant echoed | `client` ≠ `GRADEIQ_CLIENT` | Same as above, and an alert to admin | — | No GradeIQ data used |
| Customer's phone not paired | `/screen` has no `shown` | Camera button locked: "Open SwapUp Check on the customer's phone first" | Paired screen | — |
| `/screen` unreadable | Error on call 4 | "Can't confirm the phone is ready." Override needs name and reason | — | "LCD not camera-checked" |
| Photos rejected | 422 at the camera page (`cosmetic/route.ts:101-134`); `screen.capture.verdict = retake` with reasons | The camera page shows the retake. The Store app shows the reasons | — | Nothing until it is accepted |
| Case on the phone | `cosmetic.obstruction.present` | "Remove the case and retake" | — | Grade not used |
| No vision key, quota hit, or provider error | `tierUsed = stub`, `cosmetic_grade = ''` (`visionAgents.ts:301-330, 448-460`) | "Camera grading failed — check by eye." | — | **No grade.** GradeIQ's own pricing would still price it at a 0.6 factor (`pricing/engine.ts:64-66`), which is one more reason never to call `/offer` |
| Coverage below 50% | No grade (`visionAgents.ts:620-634`) | "Too little of the phone visible — retake." | — | No grade |
| Not conclusive | `conclusive = false`, `gradeRange` | "Camera grade B–D. Confirm by eye." | — | The advisor's answer must be no better than confirmed findings |
| Pro pass stuck on `refining` | Still `refining` 180 s after the later of `cosmeticDone` and the handoff (§3.3). This is a known GradeIQ bug (`cosmetic/route.ts:262-267, 318, 374-376`), and vision calls have no timeout (`giq/lib/visionProvider.ts:117-257`) | "Final check didn't finish — confirm by eye." | — | The Flash result is stored as provisional; it is never shown as final |
| LCD sweep aborted | `displayCheck.reason`, or `missing[]` not empty | "LCD not camera-checked: <reason>" | — | Display condition comes from the self-test and the advisor only |
| Functional forward fails | HTTP error on call 3 | Small "GradeIQ out of sync, retrying" | Unaffected: SwapUp's own results are authoritative | Retry with backoff; full map, so no gap |
| GradeIQ goes down mid-session | Errors on calls 4–6 | Keep the last snapshot with its time | — | The snapshot is used only if it was final |

**No invented grades, ever:**
- SwapUp has no demo or fallback grading path, and no variable that could enable one.
- An absent grade means "not camera-graded". It never becomes a letter, a fault or a condition.
- Do not port `ciq/purchase.ts:648-656`, which builds a grade from a hash of the session id.
- Do not port `ciq/purchase.ts:662, 677`, which hard-code `functionalTested:true`.
- Operator clicks never become "tested".

## 5. Gaps, risks and unknowns, ranked

Each item says whether it needs a GradeIQ code change, a SwapUp code change, or a decision from you.

1. **Every GradeIQ session write is anonymous (GradeIQ change).**
   - Anyone holding the UUID can set any grade with `conclusive:true` (`grade-manual/route.ts:8-35`), overwrite results (`functional/route.ts:13-34`), or mark the session accepted (`accept/route.ts:67-69`).
   - The middleware leaves `/api/sessions/*` open by design (`giq/middleware.ts:4-8, 53-55`).
   - An `api_keys` table exists (`giq/lib/db.ts:76-93`), but no code issues or checks keys.
   - SwapUp's mitigation keeps the UUID on the server and the staff device only. That does not stop anyone who has seen the camera URL.
   - **Since 2026-10-17 that mitigation is gone for SwapUp Check ≥ 0.6.0 sessions**: the customer's phone shows the camera URL as its scan code (§7). The owner accepted this.
2. **The functional verdict says `Working` when critical tests were never run (GradeIQ change).**
   - One pass plus all-critical-unsupported still grades `Working` (`giq/lib/grading.ts:51`).
   - Until GradeIQ adds "critical without pass/fail means incomplete", SwapUp's `summarise` stays the authority (`su/lib/domain/diagnostics.ts:336-340`).
3. **There is no `swapup` tenant (GradeIQ change plus your decision).** The tenant list is a hard-coded union (`giq/lib/clients.ts:12, 22-31`), and anything else silently becomes `default`/EUR (`sessions/route.ts:18`). You need to choose the currency and journey config. Pricing is irrelevant if SwapUp never prices through GradeIQ.
4. **The background grade can hang (GradeIQ change).** `refining` can stay true forever, and provider calls have no timeout (§4). SwapUp's 180 s cap is a workaround. SwapUp cannot re-grade, because `/reprocess` is staff-only.
5. **The live vision key is unverified (your check).**
   - `GEMINI_API_KEY` exists in the live `.env.local`. Whether it is valid and has quota, and whether a settings-table override (`gemini_key`, `vision_provider`, `pro_only`) is set, were not verified; the readers' production DB read was denied.
   - The model ids are hard-coded and also unverified: `gemini-3.6-flash` and `gemini-3.1-pro-preview` (`visionProvider.ts:46-58`).
   - A dead key looks like an ordinary "no grade" (`stub`).
6. **DeviceFax is not yet honest enough for customers (GradeIQ change).**
   - It says "All tested functions pass." even when non-critical tests failed (`passport.ts:395-399`).
   - It is marked `verified` with no tests run (`:326-331`).
   - It lists only the 11 browser tests (`:225-231`).
   - It mislabels `voice` and hides `faceid` on Android.
7. **`display` is one shared key with a race (GradeIQ change).**
   - The `/display` sweep overwrites `functional.display`.
   - It reads the session before a slow AI call (`display/route.ts:19, 33, 52-54`), so results posted during that call are lost.
   - SwapUp's worse-of rule (§3.2) is a workaround. The clean fix is a separate key, or not overwriting.
8. **There is no "assessment final" signal (GradeIQ change).** Today SwapUp infers it from five fields (§3.3), and `status` can't express a cosmetic-only result (`recompute.ts:9-14`).
9. **Customer-phone pairing has to be built (SwapUp change).** It needs the native and web pattern-echo screen in SwapUp Check and the `/api/device/screen` proxy in SwapUp. Without them, the LCD is never camera-graded.
10. **Identity is weak (GradeIQ change).**
    - An IMEI added through `/device` is never looked up (`device/route.ts:35-44`).
    - The binding verdict can never reach "proven", because no route writes the nonce or continuity evidence (`giq/lib/identity.ts:355-367`; `giq/lib/deviceBinding.ts:303-308`).
    - SwapUp's Samsung model-code match (`diagnostics.ts:14-16`) remains the model authority. GradeIQ's `mismatch` result is used only to block.
11. **Bandwidth and privacy.**
    - `GET /api/sessions/{id}` returns `staged` base64 photos that are never cleared (`cosmetic/route.ts:146-153`).
    - Photos are public with immutable caching (`giq/app/api/uploads/[file]/route.ts:5-25`).
    - A GradeIQ field filter, or clearing `staged`, is needed.
12. **No idempotency or rate limits (GradeIQ change).** Retries duplicate sessions (§3.1). Each create with an IMEI makes paid Phonecheck calls, and each cosmetic upload spends Gemini quota, all unauthenticated.
13. **Camera on the store device (SwapUp change; unverified).** The plan is Chrome via `Linking.openURL`. Running it in a WebView would need a camera grant `WebScreen` doesn't set (`Web.tsx:94-100`). I did not check torch behaviour in a Chrome Custom Tab.
14. **Settings-screen photo step (unclear).** I could not confirm whether it can be switched off per journey (`V2Cam.tsx:1287-1386`).
15. **Photo sides depend on order.** The prompt assigns sides by photo index (`inspectionCatalog.ts:24, 311-322`), and the recorded angle labels are not passed in. So the `swapup` journey must not reorder or disable capture steps.
16. **Deploy drift (your action).** `giq/deploy/deploy.sh:16` and `ESTATE.md:18` target 35.253.69.52. Run as written, the script would update the **stopped** copy and leave live GradeIQ on 104.197.168.25 unchanged.
17. **Low impact for this integration:**
    - `lens-verify` always throws away the AI answer, because it reads `out.shots` instead of `out.json.shots` (`lens-verify/route.ts:95-99`). SwapUp doesn't use GradeIQ's camera test.
    - `/video` accepts a body of any size (`video/route.ts:14-24`).
    - The Pandas results endpoint hard-codes USD (`pandasResult.ts:121-126`).

**Decisions needed from you:** answered — see §6.

## 6. Decisions (2026-10-16) and how they are built

Product direction: *SwapUp is built on GradeIQ fundamentals but extends beyond the browser to
native app testing, all automatically without any questions — simple.* Every SwapUp test session
is backed by a GradeIQ session; the customer's phone is tested automatically; cracks, scratches
and the LCD come from GradeIQ's AI vision through the **store** device's camera on `/v2/cam/{id}`
while the customer's phone echoes the screen patterns.

| Decision | Built as |
|---|---|
| **Tenant:** `GRADEIQ_CLIENT` defaults to `swapmore-in` (the existing INR tenant); a dedicated `swapup` tenant later. | `gradeiqConfig()`; a create whose echoed `client` ≠ `GRADEIQ_CLIENT` fails as "wrong tenant" (no auto-retry, audit `gradeiq.tenant_mismatch`, the stray GradeIQ id recorded in `gradeiq_orphans`). Every pulled snapshot is checked too. |
| **No paid Phonecheck lookups:** never send an IMEI at create. | `createSession()` sends `client/channel/segment/model` only. The customer's declared IMEI goes with call 2 (`/device`), which runs no lookup. |
| **Camera-confirmed structural damage is added automatically at Apply** (source `camera_ai`); weaker sightings are flags only. | Confirmed = confidence ≥ 0.7, not `uncorroborated`, has a box, **from a FINAL grade** (§3.3). `mapCamera()` in `gradeiqMap.ts`; `applyTestSession` unions the faults, floors the condition, writes `cases.fault_sources` and `cases.camera_check`. |
| **DeviceFax JSON is snapshotted for staff only.** | Call 6 at Apply → `test_sessions.gradeiq_devicefax`, photo URLs re-rooted on `GRADEIQ_PUBLIC_URL`, `offer`/`staged` dropped. Never shown to customers; the HTML passport is not used. |
| **GradeIQ is never asked for a price.** | The client has no function for `/offer`, `/value`, `/accept`, `/grade-manual` or `/reprocess`. The grade letter is shown to staff, never priced; the partner prices SwapUp's condition answers. |
| **No demo or fallback grade path exists or can be enabled.** | No such code or variable. `GRADEIQ_ENABLED=0` is a labelled kill switch (`state: disabled`, "check the condition by eye"): no GradeIQ data is used at all, not even a snapshot pulled before the switch was thrown. |

Implementation choices worth knowing (each stricter than or clarifying §3):
- **Frame cracks count only when severe**, as GradeIQ's own structural rule says (`visionAgents.ts:727-729`); a moderate frame crack is a flag. Chips on the front or back glass count from `moderate` up (§3.4 row 1); a confirmed crack of any severity counts.
- **The LCD sweep is its own AI call.** A *confirmed* `displayCheck` fail adds `display_lines` even while the cosmetic grade is provisional. Confirmed (`displayFailConfirmed`, 2026-10-17) = confidence ≥ 0.7 **and** a moderate/severe finding, or the model's own outright fail with no findings — because GradeIQ reports "fail" for ANY finding but keeps the model's own confidence, which may be a pass's (`gradeiq lib/displayCheck.ts:144-150`). Anything weaker is a flag that says why (minor marks only / low confidence). Missing patterns, `unknown` or no sweep → "LCD not camera-checked"; frames in but GradeIQ's reader off (`source: "stub"`) → "captured N of M colours, AI reader off — check by eye" (`lcd.aiOff`). A camera override never erases a sweep that ran — GradeIQ takes white only after the phone's echo and every other colour only once it SEES it in the locked screen box, so the frames prove the loop; it is the reason only when no sweep ran (§8).
- **`display` worse-of** is recomputed on every forward from the latest snapshot, so when the sweep's verdict arrives the full map is re-sent with the worse value (fail > pass > skip).
- **A provisional grade is never applied**: what it would have added becomes "Not final, so not added: … Check it by eye."
- **The case view never carries the GradeIQ id** (`CaseView.camera` omits `gradeiqId`; it stays on the row): partners can read locked cases, and the id is the only key to GradeIQ's anonymous writes. A pulled snapshot whose `client_id` is not `GRADEIQ_CLIENT` — including an empty one — is refused.
- **Identity:** either GradeIQ check saying `mismatch` blocks the partner quote server-side (`reprice` asks for no quote; `CaseView.quoteBlocked`; also a lock blocker) — even from a provisional grade, because it protects the store. Only a **store manager** can accept the phone (`PATCH /api/cases/<id>` `{cameraOverride:{identity:true, reason}}`). Missing identity = `unverified`, never a pass.
- **Advisor overrides:** removing a `camera_ai` fault or recording a better screen/body than the camera's floor → 409 unless the PATCH carries `cameraOverride: { reason }` (≥ 8 chars, name stored, audited). "Fill condition from faults" applies the camera floor too.
- **Apply now merges the condition** (`mergeCondition`, then the camera floor) instead of rebuilding it from faults, so a worse answer the advisor recorded survives — what `mergeCondition`'s comment always promised.
- **Camera lock (fail closed):** `cameraUrl` (single pass) and `screenUrl` (pass 2) are withheld until GradeIQ `/screen.shown` is a string. An unreadable `/screen`, or a customer phone that can't run Check, can be overridden with `POST /api/test-sessions/<id>/camera-override {reason}`; the name and reason are kept on the session and on the case's camera record; Apply decides from what the sweep did (§8). `photosUrl` (pass 1) is not locked: the photos need nothing on the phone. `photosDone` = `cosmeticDone` seen; `screenDone` = an LCD verdict exists or `handoffDone` was seen.
- **Pull cadence:** only while staff poll `GET /api/test-sessions/<id>`: `/screen` at most every 2 s (the customer's phone: a fresh read on every one of its polls — §8); the whole session every 5 s from `cosmeticDone` until final **and** the LCD verdict is in, for at most 180 s from the later of `cosmeticDone` and the handoff (§3.3); a retake restarts the window. `timedOut` and `gradePending` use the same window. The staff GET waits ≤ 1.5 s for this, then answers from what is stored.
- **Forwarding:** per session, one request at a time, outside every transaction; a body is sent only when its hash differs from the last one GradeIQ acknowledged — except that every new screen sweep forces a full re-send, because the sweep rewrites GradeIQ's `display` and drops results posted during its AI call (§5 #7). Failures back off 2 s → 60 s and show `outOfSync`. A create retries twice (5 s, 20 s) and then waits for Retry. A server restart is recovered lazily on the next staff or device poll.
- **Deploy gate** (`su/deploy/deploy.sh`): the VM must get a 404 **with GradeIQ's JSON body** `{"error":"not found"}` — a wrong basePath also answers 404, but with an HTML page. Skipped only when `/etc/swapup.env` says `GRADEIQ_ENABLED=0`. Missing `GRADEIQ_*` lines are appended; existing ones are never changed.
- **Local dev:** GradeIQ's dev server has no `NEXT_PUBLIC_BASE_PATH`, so it serves at the root: `GRADEIQ_BASE_URL=http://127.0.0.1:3700`, `GRADEIQ_PUBLIC_URL=http://localhost:3700` in `su/.env.local` (gitignored).

Still open: the SwapUp Check pattern-echo screen (native + web) and the Store app's camera button / grading card (`sum/`); a UI for override reasons on the web desk (today the 409 explains, but the desk has no reason field); everything in §5 that needs a GradeIQ change.

## 7. The phone-led flow (2026-10-17, `su/docs/PHONE-LED-FLOW.md`)

Owner, after reviewing GradeIQ v2: "the phone app controls everything, then the vision model, then
functional". SwapUp Check ≥ 0.6.0 runs **Identify › Scan › Test › Result**. **GradeIQ is not changed.**

**The camera link now reaches the customer's phone — said plainly.**
- `GET /api/device/camera-link` (Ticket) returns `cameraUrl(gradeiqId)` — `/v2/cam/<uuid>`, the full
  single pass, no `pass` — and the phone shows it as a QR on its Scan screen. Any camera app opens it;
  the store tablet normally does. This is GradeIQ v2's own await2nd handoff (`giq/app/components/V2Flow.tsx`),
  so the single pass (photos → dark front glass → screen sweep → Settings photo → `handoffDone`) needs
  nothing new in GradeIQ.
- Consequence, accepted by the owner, not mitigated: **whoever holds that link** — the customer, or
  anyone who photographs their screen — can write to the GradeIQ session (`/screen`, `/cosmetic`,
  `/display`, `/functional`, an anonymous `/grade-manual` with `conclusive:true`) and open GradeIQ's
  `/report/<uuid>`, which shows **GradeIQ's own price and an Accept button** (§1 "never" table, §5 #1, #6).
  The seller is the person holding the phone, and the seller gains from a better result.
- What still limits the damage: SwapUp only takes camera damage that makes the phone **worse**
  (confirmed, final, §3.4), an identity mismatch still blocks the quote, the LCD lock still fails
  closed, and SwapUp never reads GradeIQ's price. A grade the seller overwrote through
  `/grade-manual` would, however, be read by SwapUp's pulls like any other grade.
- No other device response carries the id; SwapUp Check < 0.6.0 never calls the route. Each
  session's first issue is audited (`test_session.camera_link`).
- For those sessions the store gets no `photosUrl` (no photos before the phone joins); the pull window
  and `cameraGradePending` are unchanged — the single pass posts `handoffDone` (with `cosmeticDone`)
  only after the sweep and the Settings photo (`V2Cam.tsx`, end of the pass), and the window runs
  from the later of the two, so it opens then, while the phone tests itself.

**Battery health (call 7, GradeIQ's `/ocr`).** The phone uploads a screenshot of its battery-health
screen to SwapUp (`POST /api/device/battery`); SwapUp forwards it to `/ocr` and records
`battery_health` itself: ≥ 80 % pass, below 80 % fail → the `battery_drain` fault, which the buyback
partner prices; nothing legible → skip (untested). GradeIQ's own price reads only Phonecheck's battery
figure, never this OCR % (`giq/lib/offer.ts:218`, `giq/lib/pricing/session.ts:25`); in SwapUp it
does reach the price, through the fault. What `/ocr` does on GradeIQ's side, by its
design (`giq/app/api/sessions/[id]/ocr/route.ts`):
- it keeps the screenshot in its **public** uploads (`/api/uploads/<id>-ocr-…jpg`) and in `ocr.shots`;
- it is one vision call; with no vision key (`source: "stub"`) or a failed call (`source: "error"`,
  e.g. `gemini 402: …`) it reads nothing — SwapUp answers the phone 409 "the battery reader isn't
  available for this check" (never "try a clearer screenshot", never GradeIQ's text) and records
  nothing — never a pass;
- if an **IMEI is legible in the screenshot**, it replaces the session's IMEI (recording
  `identity.imei_mismatch` first) and runs `lookupImei` — a **paid Phonecheck ESN check**. The
  battery screens the app points at (Samsung Battery information / Samsung Members, Pixel Battery
  health, Android Battery) don't show an IMEI; a screenshot of About phone would.
- SwapUp keeps no copy of the screenshot.

**Identity** stays SwapUp's: the model is matched on the phone's own model code (`matchModel`); a
customer's manual pick is a claim used only when nothing matched and the case has no model; a
typed IMEI never replaces the case's — a disagreement is a flag (SwapUp's copy of GradeIQ's
`identity.imei_mismatch`). SwapUp still sends no IMEI at create.

## 8. The four live cases, and the advisor certifying (2026-10-17)

Owner, on a real phone against the live server: *"Why question asked in swap check up when they are
already tested … why report not same level of gradeiq … why colors not captured by screen and advisor
certify lcd in its app instead of asking".* The last four tested cases (SU-AND-00014, 00020, 00023,
00026) all came back camera status `failed`/`none`, no grade, and LCD "not camera-checked" for one of
three reasons — none of them caused by the AI outage (all three happen before any AI call):

| Live reason | Where it comes from | What it really was |
|---|---|---|
| "the camera never got a clear view of the lit screen (on a folding phone, unfold …)" | `giq/app/components/V2Cam.tsx:1326-1340` | GradeIQ's own pixel search never locked onto a lit white screen (one box around every bright pixel; < 5 % or > 85 % of the frame finds nothing; 20 s, no retry). |
| "the phone never confirmed it was showing the test patterns" | `V2Cam.tsx:1292-1298` | No echo of white within 4 s — the phone had left its Scan step (the customer's 90 s "Skip the camera check"), or the relay was too slow. |
| "the camera was unlocked by <advisor> before the customer's phone showed the patterns" | SwapUp, `gradeiqMap.ts` / `cases.ts` (fixed) | SwapUp's own label for an override — it also overwrote any sweep that DID run. |

GradeIQ's Gemini key returning **HTTP 402** (prepaid credit) explains the missing **grade** (its
cosmetic grade falls back to its stand-in, `tierUsed: "stub"` → SwapUp "Camera grading failed") and
would be the next blocker once colours are captured (its display check returns `unknown`/`stub`).

**What SwapUp changed (server, 2026-10-17):**
- **The customer is never asked about condition.** `summarise` no longer turns unanswered damage
  questions into "check it by eye" notes; one note says the advisor certifies. An old browser
  check's "yes" still counts (it can only make the phone worse).
- **The advisor certifies, by name, one tap per row** — `{action:"certify"}` on the case (MOBILE-API
  §8b): screen (while the phone shows the test colours), body, liquid indicator. It moves the faults,
  the condition and the display test; the grade reads it (`docs/GRADING.md`, rules PV1/PV13/DS9/DS10).
- **The phone shows the colours for it:** `GET /api/device/status` says `colours: true` once its tests
  are done and the screen is still to certify (no camera sweep checked it); the phone posts phase
  `colours` while it shows them, so the certification records `withColours`.
- **A camera override never erases a sweep that ran** (`mapCamera`), and `markLcdOverride` no longer
  pre-marks the case — Apply decides.
- **The AI being off is said:** the snapshot keeps the display check's `source`; frames with
  `source: "stub"` read "captured N of M colours, AI reader off — check by eye" (`lcd.aiOff`), never
  "Not captured". The battery reader's `ocr.source: "error"` (GradeIQ's `gemini 402: …`) is a 409
  "Battery reader isn't available — skip; the advisor checks it." to the phone — never its text.
- **Fitting GradeIQ's 4 s window:** the phone's `/api/device/screen` reads GradeIQ fresh on every poll
  (no 0.5 s reuse; an in-flight read is shared only if it started ≤ 120 ms ago, and an older read
  that finishes late never overwrites a newer one or the phone's own echo).
- **No customer skip on Scan:** the phone stays on Scan until the camera finishes, or the advisor
  releases it by name (`POST /api/test-sessions/<id>/release-scan` → `/api/device/screen` `released`).
  Leaving Scan, the phone echoes `shown: "off"` (GradeIQ stores any string), so a phone that left
  while showing white can never satisfy the next camera page's wait for white.
- **The report is as rich as GradeIQ's** (`docs/GRADING.md` §4): every photo by angle with its marks
  boxed, part by part in words, the colour frames, identity/OS/colour, battery cycles, parts, locks,
  why the camera didn't grade, who checked it — read from the snapshot SwapUp already pulls (new in
  `readSnapshot`: `screen.angleLabels`, each specialist's `notes`, `cosmetic.device.colour`, the
  display findings' `box` and `source`). No GradeIQ change was needed for it.

### Needed from GradeIQ

GradeIQ is read-only to SwapUp's builders; these are written up for the owner — exact file and change.
Ranked by what unblocks the live cases first.

1. **`app/components/V2Cam.tsx:1293` — give the phone time to confirm white.** `waitForShown("white", 4000)`
   → 15 000 ms, re-posting `{pattern:"white"}` every 2 s while it waits, and on failure offer
   "Try again" (re-run `displaySweep`) instead of reporting at once. At `:1349` the per-colour
   `waitForShown(p, 2600)` → 6000 ms. (SwapUp Check relays the echo through SwapUp's server: phone →
   SwapUp → GradeIQ and back, two hops each way, from India to a US VM.) The phone's side is already
   as tight as it can be (SwapUp Check 0.8.0, `swapup-mobile/src/diagnostics/auto/pairing.ts`): it
   polls every 350 ms once a camera page is there, echoes two frames after a colour lands, re-sends a
   lost echo after 600 ms — and on its result screen it follows a camera page that comes back (a
   retake, "Take photos anyway"), so a "Try again" after the tests can still get its colours.
2. **`V2Cam.tsx:225-247` (`findLitScreen`) — find the screen, not every bright pixel.** Take the
   largest single connected bright region (flood-fill on the 64×48 grid) instead of one box around
   all pixels > 150; analyse only the part of the frame the preview shows (the `object-cover` crop
   at `:1729`); threshold relative to the frame's own brightness; lower the 5 % minimum to ~1.5 %
   (a Flip's cover screen, or framing from a distance). Raise the search at `:1303` from 20 s to
   40 s with on-screen feedback ("move closer", "too bright").
3. **`V2Cam.tsx:1342-1366` — re-find the screen near the locked box for each colour,** so a hand that
   moves between colours doesn't lose it.
4. **`V2Cam.tsx:1326-1340` and `:1061` — keep evidence of a failed sweep.** Post the coverage, the
   box, the colour statistics and one small frame with the reason in the `/display` body; don't stop
   the rotation video before the sweep. Today a failed sweep leaves nothing to check frame by frame.
5. **`app/api/sessions/[id]/screen/route.ts:115` — return `shownAt`** (already stored at `:33`), and
   make `waitForShown` accept only an echo newer than its own pattern request. That makes a stale
   echo impossible on GradeIQ's side too (SwapUp Check now sends `shown:"off"` when it leaves).
6. **`lib/displayCheck.ts:92-125` — name the failure.** Keep `res.status`; on a failed call return
   `error: "gemini <status>"` and, for 402/429, the note "AI out of credit/quota — frames saved,
   check by eye", as `lib/deviceOcr.ts:85-111` already does. Same in `lib/gemini.ts:158-164`, which
   treats 402 as a general error. (SwapUp already reads `source: "stub"` + frames as "AI reader off".)
7. **`app/api/sessions/[id]/display/route.ts:19, 57-75` and `cosmetic/route.ts:396` — re-read before
   writing.** Both write back a copy of `screen` read at the start of a slow request, which can wipe
   an echo or a `handoffDone` written meanwhile.
8. **Top up the Gemini prepaid credit** (owner action) — until then every camera grade is the
   stand-in and every colour sweep is unread; SwapUp degrades to the advisor certifying.
9. Optional: `app/api/sessions/[id]/grade-manual/route.ts:7-35` writes "Graded manually by
   operator/customer" with no name. Accepting `by` would let SwapUp mirror a certification into
   DeviceFax. SwapUp's own report doesn't need it.

**Not determinable from code** (needs the production rows, read-only): which path each of the four
cases took — per session `phone_phase`, the phone's scan record (did it skip?), `appVersion`
(`web-…` = the browser check, which still asked the damage questions — SU-AND-00026 declared
`{screenCracked:false, backCracked:false, liquid:false}`, which only the browser flow sends), whether
an override was recorded, and GradeIQ's event log; and whether the live `swapmore-in` / `retail`
journey still grades after the screen check (`gradeAtEnd`).

