# The SwapUp grade and the grade report

Owner, 2026-10-17: *"Phone check api and report grading based on diagnostic"* — grade from **both**
sources (SwapUp Check now; Phonecheck when its keys are on the server, plus its webhook and
uploads), and show **both** scales.

One engine (`lib/domain/grading.ts`) turns every phone check SwapUp has into **one grade**, with the
reasons — the **SwapUp grade**. A versioned, public-safe **grade report** says what was tested and why
the phone got its grade. Every screen uses those two names, and none names the buyback partner company.

| | |
| --- | --- |
| Engine (pure) | `lib/domain/grading.ts` — `grade(input)`, ruleset `GRADING_RULESET_VERSION` |
| Phonecheck parser (pure) | `lib/domain/phonecheck.ts` — `readPhonecheck`, name map, AI-extraction schema |
| Report body (pure) | `lib/domain/gradingReport.ts` — `buildReportBody`, `canonicalJson` |
| Report lifecycle, who sees what | `lib/server/gradingReport.ts` |
| The advisor certifies (pure) | `lib/domain/certify.ts` — `certifyRow`, `certifyNeeded`; served by `certifyCase` (`lib/server/cases.ts`) |
| Phonecheck pull / webhook / upload / attach | `lib/server/phonecheck.ts` |
| AI reader for an uploaded report | `lib/server/phonecheckOcr.ts` |
| API | `docs/MOBILE-API.md` §9 |
| Tests | `lib/domain/grading.test.ts`, `phonecheck.test.ts`, `gradingReport.test.ts`, `certify.test.ts`; `lib/server/grading.server.test.ts` (the services on a throwaway database), `lib/server/certify.server.test.ts` (the owner's case: GradeIQ's AI out of credit, the advisor certifying, the report) |

**The grade's verdict never moves a price.** Prices read the condition answers: the partner's rate
card (`lib/domain/ratecard.ts`), and PriceIQ's trade-in, which prices what the phone LOOKS like by rule
G1 — the same rule the grade uses (`cosmeticGrade`, kept beside the grade's words in
`lib/domain/marketSell.ts`) — but never the engine's status, provisional flags or tests. Nothing that
prices imports the engine (test G49, which now also covers `priceiqTradeIn.ts`). The report carries
no money at all. How the grade's words price a trade-in: §6.

---

## 1. Two scales, one grade

| SwapUp grade | Letter |
| --- | --- |
| Superb | A |
| Good | B |
| Fair | C |
| Best Value | D |

- **The SwapUp grade is the headline.** Its words are the refurbished market's, because the buyback
  partner buys the phone and PriceIQ's sell price is keyed by exactly these grades. It says so in one
  line: *"SwapUp grade, as tested at the store — not the buyer's own inspection."* (`SCALE_NOTE`); the
  report prints *"Superb > Good > Fair > Best Value · tested at the store, not by the buyer"*
  (`REPORT_SCALE`).
- **The letter is a strict one-to-one translation of it** — never derived from anything else, and
  `null` whenever the SwapUp grade is null (needs repair, not fully tested, can't grade, not tested).
- **The server writes the label; the apps print it as sent.** `label` (`"Good (B)"`,
  `"Good (B) · provisional"`, `"Needs repair"` …) is the only place the letter rule lives
  (`GRADE_LETTER`); a client splits off `" · provisional"` at most.
- Labels carry both: `"Good (B)"`, `"Good (B) · provisional"`. Everywhere the grade shows, this line
  shows once beside it: *"A = Superb, B = Good, C = Fair, D = Best Value — not CTIA."*
- **Never a CTIA grade.** CTIA needs measured scratch sizes, a fixed light level and timed
  inspection; SwapUp measures none of them.
- **Not GradeIQ's letter.** The store camera's Premium–D stays staff-only, and the report's reason
  texts never quote it (it would read as this A–D).

## 2. Statuses

Precedence: **not_tested > cannot_grade > needs_repair > incomplete > graded**. Every rule that
fires leaves a reason; `reasons[0]` is the one-line why.

| Status | Label | Grade |
| --- | --- | --- |
| `graded` | "Superb (A)" … / "… · provisional" | the cosmetic grade (G1) |
| `needs_repair` | "Needs repair" | none — every SwapUp grade assumes no functional defect. `afterRepair` = the grade once repaired, when every reason is a recorded fault with a part |
| `incomplete` | "Not fully tested" | none — `ceiling` = the best it can be if the untested key tests pass |
| `cannot_grade` | "Can't grade" | none — the evidence can't be trusted |
| `not_tested` | "Not tested" | none |

`final` = graded **and** no provisional reason. A provisional grade is still the grade; it says what
a person should check.

## 3. The rules (ruleset 2026-10-17.2)

Evidence is merged per test, **worse-of**: any source failed → failed; else any passed → passed;
else every source "not on this phone" → not on phone; else not tested. Skip never counts as a pass.
Battery health = the **lowest** reading (the phone's battery screen, Phonecheck).

**The advisor's certification is evidence too** (`certification`, 2026-10-17.2 — owner: *"advisor
certify lcd in its app instead of asking"*). When the store camera can't decide, the advisor taps
what they see on "Check the phone" in SwapUp Store, by name: the **screen** (OK · Scratches · Lines
or spots · Cracked) while the customer's phone shows the test colours, the **body** (Like new ·
Scuffs · Dents · Back cracked · Bent), the **liquid indicator** (Clean · Tripped · Can't see).
- On the case (`certifyRow`): Lines or spots → `display_lines`, Cracked → `screen_cracked`, Back
  cracked → `back_cracked`, Bent → `frame_damage`, Tripped → `water_damage`, each with source
  `advisor`; the screen and body take the certified value, **never better than the faults or the
  camera's confirmed floor**. Changing a row takes off only the faults that row put on. Before Apply
  the case has no condition and a tap doesn't invent one; Apply folds the certification into the
  condition it makes (`withCertification`).
- In the grade: the screen row is the display test from source `advisor` — OK / Scratches pass,
  Lines or spots fail, Cracked nothing — merged worse-of (a camera-confirmed fail beats an advisor's
  OK). **A certification adds to a test; it never stands in for one** (no other evidence → still
  "Not tested").
- The customer is never asked about condition. An older browser check's damage "yes" still adds its
  fault (source `declared`, printed "Customer said"); "no" or no answer is nothing.

| Code | Fires when | Effect |
| --- | --- | --- |
| NT1 | no evidence at all | not tested |
| CG1 | the test ran on an emulator | can't grade |
| CG2 | the case has no condition answers | can't grade |
| CG3 | the camera says it may not be the phone on the case, no manager override | can't grade |
| CG4 | Phonecheck says Working = No without naming a failed test | can't grade |
| NR1 | a **key** test failed (touch, display, mic, speaker, camera, charging) | needs repair |
| NR2 | the case records a fault other than frame damage | needs repair |
| NR3 | it doesn't switch on, or calls don't work | needs repair |
| NR4 | screen lines/spots, cracked or dead; back cracked | needs repair |
| NR5 | a condition issue is ticked | needs repair |
| NR6 | battery health under 80 % | needs repair (battery) |
| NR7 | a non-key test failed that is a SwapUp fault (multi-touch, earpiece, buttons, battery) | needs repair |
| NR8 | swollen battery | needs repair + DS1 |
| IC1 | a key test has no pass or fail | not fully tested (a reason only, when it already needs repair) |
| G1 | the grade: worse of screen (flawless → Superb, scratched → Good) and body (flawless → Superb, scuffed → Good, dented → Fair, bent → Best Value), never better than the case's faults allow | — |
| PV1 | not camera-graded, camera grade not final, or camera grading failed — **and the screen and the body aren't both certified** (one certified: "Body not camera-graded or certified.") | provisional |
| PV2 | the camera grade is not conclusive (cleared once screen and body are certified) | provisional |
| PV3 | the camera grade needs a person to review it (cleared once screen and body are certified) | provisional |
| PV4 | the camera saw frame or lens damage that isn't on the case (a frame / back suggestion is cleared once the body is certified; a lens stays) | provisional |
| PV5 | battery health not read | provisional |
| PV6 | a test failed that isn't a SwapUp fault (flash, biometrics, sensors…, a Phonecheck-only test) and the matching issue isn't ticked | provisional |
| PV7 | the Phonecheck results were **uploaded** by staff, not fetched | provisional |
| PV8 | a manager attached a Phonecheck report with a different IMEI | provisional |
| PV9 | Phonecheck failed a cosmetic check the case records no damage for | provisional |
| PV10 | a final camera grade rated the front, back or frame low while the grade is Superb or Good (cleared when the matching row is certified: front → screen; back, frame → body) | provisional |
| PV11 | the camera's LCD sweep failed unconfirmed while the display test passed (cleared when the screen is certified) | provisional |
| PV12 | the Phonecheck report was **read by AI** from an uploaded PDF / photo — "check the figures" | provisional |
| PV13 | the screen was certified OK / Scratches **without** the test colours on the customer's phone (an app before 0.8.0, or tapped before they showed) | provisional |
| DS1 | swollen battery — do not charge | disclosure |
| DS2 | a part isn't original (Phonecheck Parts, or the camera suspects aftermarket) | disclosure |
| DS3 | activation lock on — the customer signs out before hand-over (not a test failure) | disclosure |
| DS4 | recorded better than the camera saw, by whom and why | disclosure |
| DS5 | a manager overrode the camera's identity doubt | disclosure |
| DS6 | a test failed but the case doesn't record the fault | disclosure |
| DS7 | tested in a web browser | disclosure |
| DS8 | Phonecheck reads the phone as another model on file (the case is kept) | disclosure |
| DS9 | the liquid indicator couldn't be seen — "not checked", by whom | disclosure |
| DS10 | a FINAL camera confirmed worse than the advisor certified (the camera's finding stands — not where a recorded reason overruled it, DS4), or saw a bent frame / cracked back the advisor then checked by eye | disclosure |

Owner decisions still open (spec §9): the one "scratched" bucket maps to Good (the refurbished
market splits scratches by count); battery under 80 % is "Needs repair", not a lower grade.

## 4. The report

- **Live** grading is worked out on every read from the case: its condition, faults and camera
  record; the SwapUp Check session the camera record names (once Apply wrote it); the newest
  attached Phonecheck record; the GradeIQ snapshot (per-part grades, OEM verdict) only from a final grade.
- **Issued versions** (`grading_reports`): a new version only when the public body changes. Issued by
  every case edit (`updateCase` — so Apply says `swapup_check` and a Phonecheck attach `phonecheck`),
  by a certification (`certified`), and inside the lock transaction (`traded_in`, **final**:
  the partner's evidence at pickup and clearance). **After lock nothing re-issues.** A case tested
  before this existed gets v1 (`backfill`) on first read. Never tested → no report.
- **The body** (`swapup.grading-report/v1`) carries no money, no customer, a masked IMEI, no GradeIQ
  letter / id / URL, no Phonecheck links, no raw photo URL (photos are proxied by index).
- **As rich as the store camera's own report** (owner, 2026-10-17). The schema stays
  `swapup.grading-report/v1` with **optional additions**, so a version issued before them renders as
  it always did (a case still at the counter gets a new version on its next edit; a traded-in case
  keeps its frozen, thinner version — as designed):
  - `camera.photos` — every exterior photo **but the front glass**, in order, with its angle
    (GradeIQ's `angleLabels`, else its capture order: Front glass, Back, Left side, Right side, Top
    edge, Bottom / ports) — whatever the grade's finality. The front glass faces the camera with the
    phone's screen on it, which may still show its scan code (the GradeIQ session id): that photo is
    never on the public report, and a mark framed on it is said without it (`photo: null`).
    `camera.findings[].box` — each FINAL-grade mark boxed on its photo;
    `camera.parts` — FINAL only, each part in words ("No marks", "2 light marks", "Wear", "Damage:
    cracked glass", "Not seen by the camera") with the AI's one-line note, letters taken out — **never
    the camera's letter or score**; `camera.why` — one fixed sentence when it didn't grade ("The
    automatic grader is off…", "A case or cover was on the phone…"); `camera.checkedBy`.
  - `screen` — the colour test: each colour asked for with its frame (crops of the lit screen only),
    what's missing, the reader's marks with their boxes (only when it really read them), and `why`
    (`lcdWhy`: "The store camera couldn't see the lit screen." / "The customer's phone didn't show
    the colours." / "The camera was started before the customer's phone was ready (<name>)." /
    "Colours photographed; the automatic reader is off.") — **never GradeIQ's own text**.
  - `certification` — what the advisor checked by eye, one line per row, by name; `faults[].certifiedBy`.
  - `phone.os`, `phone.colour`, `phone.identity` (the camera's identity check); `battery.cycles`;
    `locks` (activation lock, rooted, MDM — with the register they print as one Locks group); `parts`
    (Phonecheck's word, and a FINAL camera's with its evidence).
  - Battery health prints once (its own section), not again as a test line; "Store camera report
    DFX-…" only when its photos or its grade are on the report.
  - Never on it: the AI vendor, its errors (402), GradeIQ's name, letters, score, tier, its
    instructions to staff ("unfold it…"), lens frames (the front lens shows the customer), Settings
    screenshots (the full IMEI), GradeIQ's signature, an IMEI barcode.
  - Risk to know: photos are streamed from GradeIQ's store each time the report opens, not copied;
    if GradeIQ's uploads are lost, frozen reports lose their pictures (the words stay).
- **The hash** is `sha256(canonicalJson(body))`; the stored body is exactly that text, so anyone can
  recompute it from `/api/r/<token>?v=n`. It is an integrity fingerprint, not a signature.

| | Live grade | Versions | Staff extras |
| --- | --- | --- | --- |
| advisor / store manager / programme admin / platform | yes | all | full IMEI, GradeIQ letter + links, camera flags and disagreements, Phonecheck links, out-of-date flag, after-refurb grade |
| partner (once traded in) | no | the lock version only (a backfill for older cases) | no |
| anyone with the link `/r/<token>` | no | latest, or `?v=n`; never a list | no |
| the customer's phone (`GET /api/device/status`, once applied) | no | the link, and the latest version's grade line (`{status, label, grade, letter, final}`) | no |

Once a trade-in is locked, the grade line on the case (`CaseView.grading`) is the frozen version for
staff too — the same one the receipt, the pickup and the partner show, linked to exactly that
version. The partner's case view never carries the store camera's own GradeIQ letter, range or flags
(`camera.grade` / `gradeRange` null, `flags` empty), nor the store's money (`refurbCost`, `offer`,
`refurbEconomics`, `marketSell.amount` null).

## 5. Phonecheck

A cable-connected desktop station. It only applies to a store that has its own Phonecheck account and
station, never to the customer's phone. Three ways a record arrives, one way it reaches a case:

- **Pull** — staff press "Phonecheck results": one `POST {base}/GetDeviceInfo`, form-encoded
  (`apiKey`, `username` = the store's **station** login, `imei`, `IMEI`). 404 / "No Data Found" =
  never tested on that account (not a failure). At most one pull per case per 15 s, ten a day.
- **Webhook** — `POST /api/phonecheck/webhook`; stored, **never** attached by itself. Phonecheck
  sends it only after testing finished **and the erase passed**, so at the counter the pull is the
  main path. A newer copy of a check already on an open case re-issues that case's report.
- **Upload** — the JSON, or the report as a **PDF / photo read by AI** (Gemini, the key and model
  GradeIQ uses). Always provisional (PV7; an AI read also PV12).

**Attach** (advisor or store manager, case at the counter): the record's IMEI must be the case's; a
case with no IMEI takes Phonecheck's (read by cable). A different IMEI needs a **store manager** and
a reason (PV8). Failed tests become faults (source "phonecheck"); nothing is removed; the condition
only gets worse and is never invented from a cable test; the model and storage fill only what the
case lacks; the case re-prices like any edit. `Grade` is kept verbatim as "the tester's grade" and
**never** used. `DeviceLock` (not `MDM`) is the activation lock. One row per Phonecheck check (the A4
report number): a newer copy replaces it, an older or equal one is stale; Phonecheck's own copy beats
a staff upload of the same check.

### Set-up (it ships switched OFF)

With `PHONECHECK_*` unset everything else works, and the pull says exactly what is missing.

| Env var (server only) | |
| --- | --- |
| `PHONECHECK_API_KEY` | Cloud Portal › General Settings › API Key. Unset → switched off. |
| `PHONECHECK_CONTRACT_CONFIRMED` | `1` only after Phonecheck confirms `GetDeviceInfo` reads are **not charged per IMEI**. Until then no pull is made. |
| `PHONECHECK_USERNAME` | Fallback **station** login when a store has none of its own. |
| `PHONECHECK_API_BASE` | Default `https://clientapiv2.phonecheck.com/cloud/cloudDB`. EU per Phonecheck's docs: `https://eu-clientapiv2.phonecheck.com/cloudDB` (not run). |
| `PHONECHECK_WEBHOOK_SECRET` | ≥ 24 characters. Unset → the webhook answers 503 to everything. |
| `PHONECHECK_TIMEOUT_MS` | Default 8000. |
| `PHONECHECK_TZ` | The Phonecheck account's UTC offset, e.g. `+05:30` — used **only** for a record without `UpdatedTimeStamp` (its `DeviceUpdatedDate` has no zone; DeNovo's account stamps +04:00). No default: unset → the test time is unknown, and said so. Never the server's own zone. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | The AI reader for uploaded reports (default model `gemini-2.5-flash`). The key goes in the `x-goog-api-key` header, never the URL; never logged or returned. Unset → that upload answers 503 and `GET /api/cases/<id>/phonecheck` says so up front (`aiReader: {ok: false, why}`, the desk greys the button); the JSON upload still works. A key Google refuses (out of prepaid credit: 402) is a 503 in words on the upload — and from then on, for 15 minutes, the reader reports itself off with that reason ("AI reader off — out of credit; upload the Phonecheck JSON.") and makes no call; a 401 / 403 the same ("Google refused its key"). A different key is tried at once. |

1. **Approved IPs.** In the Phonecheck portal add the VM's IP **104.197.168.25** to the API key's
   Approved-IPs list. Once one IP is listed, every other IP is refused (a 403).
2. **Station login.** Each store's manager sets its Phonecheck **station** login on the store — the
   "Phonecheck station" card on the desk's `/store` page (`PUT /api/stores/<id>/phonecheck {station}`),
   e.g. `Teja-D04`. The **master account name always gets a 401** — it must be a station login.
3. **Contract.** Ask Phonecheck whether `GetDeviceInfo` reads are metered per IMEI; only then set
   `PHONECHECK_CONTRACT_CONFIRMED=1`.
4. **Webhook (optional).** Portal › Third Party API › Add New › POST to
   `https://<swapup>/api/phonecheck/webhook` with a header param `X-PC-Secret: <PHONECHECK_WEBHOOK_SECRET>`
   (or `Authorization: Bearer …`). Never a `?secret=` query. Body: JSON or form-encoded, ≤ 512 KB, one
   record, an array, `{devices}`, `{data}` or `{deviceInfo}`, ≤ 100 records → `200 {ok, received,
   stored, stale, rejected}`; `500` only on a database error (Phonecheck retries only on
   500/502/504/408). The push shape is not pinned by anything observed — check the first real one.
5. **Live check.** One real pull by IMEI on a test case.

**Calls SwapUp never makes:** any IMEI / ESN / blacklist / iCloud service (paid, and none covers
India's CEIR register), `GetAllDevices`, scheduled syncs, the v2 / Cloud Dash APIs, the Remote App.

### Phonecheck test names → SwapUp tests

Matched case-insensitively after stripping a manual `M-`. A group passes only when one name passed
and none failed or is pending; anything less is untested. The camera passes only with a front **and**
a rear pass. Phonecheck almost never reports the charging port (once in 3,227 records), so
Phonecheck-only evidence usually reads "Not fully tested" — the data cable proves nothing about it.

| SwapUp test | Phonecheck names |
| --- | --- |
| touch | Digitizer N Pattern, Digitizer |
| multitouch | MultiTouch |
| display | LCD, Display |
| mic | Microphone, Front Microphone, Video Microphone, Bottom/Front/Rear Mic Quality |
| speaker | Loud Speaker, Loudspeaker Quality, Loudspeaker Ringtone |
| voice | Ear Speaker, Earpiece, Earpiece Quality, Earpiece Ringtone |
| camera | front: Front Camera (+ Quality, Focus), Front Video Camera · rear: Rear / UltraWide / Telephoto Camera (+ Quality, Focus), Rear Video Camera |
| flash · faceid · vibration | Flashlight · Face ID, Fingerprint Sensor, True Depth · Vibration |
| buttons | Power / Volume Up / Volume Down / Home / Action / Back / Menu Button, Flip Switch, Camera Control (+ Button, Slide, Swipe) |
| battery | Battery Drain, Battery Warning |
| charging | Charging (Wireless Charging is **not** the port) |
| connectivity · bluetooth · nfc | WiFi, GPS, WiFi+GPS, Network Connectivity, Sim Reader (Test) · Bluetooth · NFC |
| motion · sensors | Gyroscope, Accelerometer, Screen Rotation · Proximity Sensor, Light Sensor, Barometer |
| *status, never a failure* | Device Lock, MDM, Knox, Jailbreak/Root, eSIM-only device, Beta OS, Grading |
| *cosmetic → PV9* | Cosmetics, Glass Condition, Back Glass Condition, Frame Condition, Camera Lens Condition, Secondary Glass Cracked |
| *anything else* | shown verbatim; a failure → PV6 |

`battery_health` comes from `BatteryHealthPercentage` (1–100; "0" or blank = not read), the same 80 % line.

## 6. Pricing — the trade-in from PriceIQ at the grade

Owner, 2026-10-17: *"Ask simple repair quote and price compare from price iq based on grade
...deduct based on % of failure or defects."* Owner, 2026-10-18: PriceIQ **live** (no snapshot
file); **one margin below the market price everywhere** — the 5%→2% markdown, in SwapUp and in
GradeIQ; **SwapUp's % per defect** everywhere (GradeIQ copies the table, "same as SwapUp"); old data
shown with its age over 14 days and no price over 90; no sample prices of any kind; never a made-up
price. The answer compares the **refurb quote** (what the customer pays to fix it) with
**trade-in + bonus**. Never a typed price (0.9.1): staff change it only by changing the conditions.
The trade-in is priced in this order (`lib/server/tradeIn.ts`), and whatever wins is the case quote
— the figure the answer shows and the lock holds on the store's credit line:

1. **PriceIQ** (`source.kind: "priceiq"`, `lib/domain/priceiqTradeIn.ts`, asked live by
   `lib/server/priceiq.ts` — `GET /api/market-grades`, cached an hour, a quote waits ≤ 6 s):
   - **base** — PriceIQ's LOWEST refurbished-market listing for the model + storage at the phone's
     grade by rule G1; when the market lists none at that grade, the next LOWER grade, named
     ("· none at Superb") — never a higher one;
   - **less the markdown** — 5% up to ₹15,000, 4% to ₹30,000, 3% to ₹50,000, 2% above: the same
     `sellFromListing` the store's sell price takes, so a phone with no defects is bought for the sell
     price rounded down to ₹10;
   - **less a % for each defect** — SwapUp's table (`ratecard.ts DEFECT_DEDUCTIONS`, cap 85%,
     minimum 6% of the listing, ₹10 step), combined as a rate card combines them
     (`ratecard.ts combineDeductions`): each % of the listing, floored to the rupee; the total capped
     (the give-back is its own line); never below the minimum; rounded DOWN;
   - **old data** — market data over 14 days old still prices, WITH its age ("Refurbished market
     price, week 2026-W35, 52 days old." under the figure); over 90 days old it is no price
     (`priceiqWhy` "PriceIQ's prices for the … are from 2026-W29 (91 days old) — too old to price.");
   - **PriceIQ unreachable** — the last good answer, labelled "PriceIQ unreachable, last answer …".
2. **The partner's uploaded rate card** — when PriceIQ has no price. The quote carries `priceiqWhy`
   (e.g. "PriceIQ has no refurbished market price for the Galaxy Z Fold6 256GB.") and the answer's
   Show details says it.
3. **None** (`source.kind: "none"`) — "No market price yet", and the reason: "This phone isn't on the
   rate card yet.", PriceIQ's own why, or "No rate card is active yet." Never a guess.

**What is a defect.** The grade already prices the look — scratches, scuffs, dents, a bent frame —
so those are never deducted again. Deducted once each: a screen with lines, cracked or not working; a
cracked back; a phone that won't switch on (priced on that alone — nothing else can be assessed);
no calls; and each failed function — touch, battery (health under 80 % is `battery_drain`),
charging, rear and front camera, speaker, mic, Wi-Fi/Bluetooth, fingerprint, buttons, vibration,
liquid. A defect does not lower the grade as well: a cracked screen on an otherwise flawless phone
is Superb less the cracked-screen %. Accessories and age are not defects (the market price is
already this model's, at its age).

**One grade** (owner, 2026-10-22: "grade match"). The grade the trade-in is priced at
(`marketSell.ts tradeInGrade`) is the grade every answer shows and the grade the phone comes out at
after refurb (`gradeAfterRefurb` is the same function): the refurb replaces exactly what the grade
leaves out — a screen with lines, cracked or dead, a cracked back glass — and touches nothing the
grade sees. So a cracked back on a flawless frame is grade A everywhere: shown A, priced off grade A
less the back-glass %, after repair A. The answer's market line names that grade and works the
deduction out: "Market price for grade A ₹34,000 · ₹40,000 less ₹6,000 for back glass cracked".

**The repaired value** (for the repair-vs-swap comparison, beside a PriceIQ trade-in) is priced the
way the trade-in is, so the two compare like with like: PriceIQ at the grade the phone comes out at
after refurb (`gradeAfterRefurb`), less the same markdown, less a % for every defect the repaired
faults DON'T explain (`healedCondition` — a ticked Wi-Fi issue nobody quotes a repair for stays
deducted). Where PriceIQ has none, the partner's rate card may supply it, else there is none.

**A failed test is priced even though nobody ticks a box.** Wi-Fi / Bluetooth, fingerprint and
vibration are not SwapUp faults, but a failed test (SwapUp Check or Phonecheck) puts its condition
issue on the case at Apply (`DiagnosticSummary.issues`, `withIssues`), so the trade-in deducts it.

**The partner never sees the store's figures.** For a partner the case view drops the store's answer
(`decision`, `repair`, `manualRepair`, `offer`), its SELL price, and a PriceIQ quote's base and
markdown (its lines collapse to one "Trade-in" line; `priceiq` and `priceiqWhy` are not sent); a
PriceIQ `repairedQuote` is not sent at all.

**Worked example** (the contract's acceptance phone): Galaxy S23 Ultra 256GB, SwapUp Check with the
rear camera failed, screen OK / body scuffs (rule G1: **Good**), battery health 76 %. Faults
`rear_camera`, `battery_drain`. PriceIQ: Superb ₹53,499 · Good ₹51,399 · Fair ₹49,399 · Best Value
₹47,199 (lowest listings, week 2026-W35).

| Line | % | ₹ |
| --- | --- | --- |
| Refurbished market price (Good) · PriceIQ | | 51,399 |
| Below the market price | 2% | −1,028 |
| Battery drains / swollen | 9% | −4,625 |
| Rear camera faulty | 18% | −9,251 |
| Rounded down to ₹10 | | −5 |
| **Trade-in** | | **36,490** |

The answer's trade-in line: "Refurbished market price ₹51,399 (Good) − 2% − 2 defects · PriceIQ
2026-W35, 52 days old" — the store margin's own words for the same base, with the data's age.
Repaired value ₹50,370 (Good − 2%, nothing left to deduct); the store's sell price ₹50,371. A
flawless one: ₹53,499 (Superb) − 2% = ₹52,420. The customer's receipt says only "Trade-in for its
condition and faults".

Tests: `lib/domain/priceiqTradeIn.test.ts` (table-driven: no listing, lower-grade fallback, no
defects, several defects past the cap, a dead phone, the minimum, rounding, every condition adds up),
`lib/server/tradeIn.server.test.ts` (the source order through the real services, against a stand-in
PriceIQ), `lib/server/priceiq.server.test.ts` (the client: key, timeout, cache, 404, unreachable).
