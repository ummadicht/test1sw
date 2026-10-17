# Store tablet — signed in for the store, advisor by name + PIN

Owner, 2026-10-17: *"advisor doesn't scan but already logged per store — it's almost [always an]
iPad / Android tab[let]"*, then chose: **the tablet stays signed in for weeks; the advisor picks
their name and a 4-digit PIN** (so hand-over checks, KYM, data-clear ticks name the right person).

Before this: SwapUp Store signed a PERSON in for 12 h (username + password), so a shared counter
tablet either asked for a password every day or recorded everything under whoever signed in.

## Model

- **Store tablet** = a device enrolled by a store manager. It holds a long-lived, revocable
  **device token** bound to ONE store. The device token alone can do exactly three things: list
  that store's counter staff, unlock one of them with their PIN, and set a PIN with the person's
  password. It can't read or change any case.
- **Unlock** = device token + staff member + their PIN → the SAME 12 h staff Bearer token as
  `/api/auth/token` today. Everything after unlock is unchanged (cases, test sessions, desk
  hand-off, audit "by <name>").
- The tablet **locks** (back to "Who's serving?", staff token dropped) when someone taps **Switch /
  Lock**, after **15 minutes idle** on Home / New trade-in / Settings, and on app restart. The
  device token stays.
- **PIN** = 4 digits, per person, scrypt-hashed like passwords (`hashPassword`). Not all one digit
  (1111) and not a straight run (1234, 4321, 0123, 9876 …). 5 wrong PINs for one person on one
  tablet → that person is locked on that tablet for 10 minutes (other staff unaffected).
  A person with no PIN (or who forgot it) sets one on the tablet with their account password.
- A manager **removes** a tablet (lost, replaced) from SwapUp Store Settings or the desk's /store
  page → its device token stops working at once (every request re-checks the table).

## Data — migration 7 (`lib/server/db.ts`, additive)

```sql
CREATE TABLE store_devices (
  id TEXT PRIMARY KEY,                 -- "dev_" + newId
  store_id TEXT NOT NULL REFERENCES stores(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,                  -- "Counter tablet 1"
  token_hash TEXT NOT NULL UNIQUE,     -- sha256 hex of the device token; the token itself is never stored
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,                   -- written at most once a minute
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE INDEX store_devices_store ON store_devices(store_id);
CREATE TABLE pin_attempts (
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  PRIMARY KEY (device_id, user_id)
);
ALTER TABLE users ADD COLUMN pin_hash TEXT;
ALTER TABLE users ADD COLUMN pin_set_at TEXT;
```

Device token format: `sdt_` + 32 random bytes base64url. Sent as `Authorization: Device <token>`
(never Bearer — `getSession()` must keep ignoring it).

## Pure rules — `lib/domain/storeTablet.ts` (+ `storeTablet.test.ts`, node --test)

- `pinProblem(pin: unknown): string | null` — null when OK; otherwise a sentence:
  not 4 digits → "The PIN is 4 digits."; all same digit / ascending or descending run of 4
  (wrapping not needed) → "Pick a PIN that isn't a run or one repeated digit."
- `PIN_MAX_FAILURES = 5`, `PIN_LOCK_MS = 10 * 60_000`
- `afterWrongPin(failures: number, now: number): { failures: number; lockedUntil: number | null; triesLeft: number }`
- `isLocked(lockedUntil: string | null, now: number): boolean`
- `deviceNameProblem(name: unknown): string | null` — 2–40 chars after trim.
- `TABLET_IDLE_MS = 15 * 60_000` (exported for docs/clients; the client keeps its own copy).

## API (all JSON; errors `{ error }` via `handle()`)

### Staff (Bearer staff token)
- `POST /api/store-devices` — **store_manager only** (their own store). Body `{ name }`.
  → `201 { deviceToken, device: { id, name, createdAt }, store: { id, name, code, city } }`.
  Audit `store_device.create`. The token is returned once and never again.
- `GET /api/store-devices` — store_manager (own store); org_admin with `?storeId=` (scope-checked).
  → `{ devices: [{ id, name, createdAt, createdBy: name|null, lastSeenAt, revokedAt }] }` newest first, revoked included.
- `POST /api/store-devices/<id>/revoke` — store_manager of that store, or org_admin of its org.
  → `{ ok: true }`. Idempotent. Audit `store_device.revoke`.
- `POST /api/me/pin` — advisor / store_manager. Body `{ password, pin }` → `{ ok: true }`.
  Wrong password → 403 "That password isn't right."; bad PIN → 400 with `pinProblem`.

### Tablet (Authorization: Device <token>)
Unknown / revoked token → **401** "This tablet was removed from the store. A manager can set it up again."
A store whose status is `rejected` → 403.
- `GET /api/tablet` → `{ device: { id, name }, store: { id, name, code, city, status }, org: { name, demo },
  staff: [{ id, name, role, roleLabel, hasPin }] }` — active advisors + store managers of THIS store,
  sorted by name. Touches `last_seen_at`.
- `POST /api/tablet/unlock` `{ userId, pin }` → `{ token, expiresAt, user }` (exactly `tokenLogin`'s
  shape: `userPayload(u)`). Errors: user not an active advisor/store_manager of this store → 404
  "Not on this store's staff."; no PIN yet → 409 "Set your PIN first." ; locked → 429 "Too many wrong
  PINs. Try again in N minutes, or ask your manager."; wrong PIN → 403 "Wrong PIN — N tries left."
  A correct PIN resets the person's failures on this tablet. Audit `tablet.unlock` (detail: device id).
- `POST /api/tablet/set-pin` `{ userId, password, pin }` → `{ token, expiresAt, user }` (signed in).
  Same 404/429 rules; wrong password counts as a failure (403 "That password isn't right — N tries left.").
  Audit `tablet.set_pin`.

All three tablet routes run the same constant-cost check (verify against a dummy hash when the user
is unknown), like `authenticate()`.

## Desk (web)
`/store` (store manager): a **Store tablets** card — name, added by/when, last seen, **Remove**
(confirm). Read-only for org_admin viewing a store.

## SwapUp Store app (`swapup-mobile/src/store`)
- `storage.ts`: device token + cached `{ deviceId, deviceName, storeName }` under their own keys
  (`swapup.store.device`, `swapup.store.deviceInfo`); `loadSaved()` also returns them.
- **Boot:** device token saved → `GET /api/tablet` → phase `tablet` ("Who's serving?"). 401 → clear the
  device token, go to sign-in with the 401 sentence. Network error → the existing Offline screen
  ("Try again"). No device token → today's flow, unchanged.
- **Who's serving?** (`screens/TabletLock.tsx`): store name + tablet name on top; a grid of big name
  buttons (name, role). Tap → **PIN pad** (4 dots, 1–9, 0, ⌫; auto-submits on the 4th digit; shows the
  server's sentence on error and clears). `hasPin: false` → **Set your PIN**: password field, new PIN,
  repeat PIN → `/api/tablet/set-pin`. A small link: "Sign in with username and password" (managers,
  setup) → the normal SignIn; the device token stays.
- **Unlocked:** the staff token lives in memory only (not saved) in tablet mode. Home's top bar shows
  "<name> · Switch" → back to the grid. 401 from any staff call → back to the grid (not to sign-in).
- **Idle lock:** 15 min with no touch while on Home / New trade-in / Settings → back to the grid. Not
  while a Session or the web desk is open (the advisor is mid-trade-in). Touches are seen with
  `onStartShouldSetResponderCapture` on the root view (returns false — never steals a touch).
- **Settings:** a manager on a device that is NOT a tablet: "Use this device as the store tablet" (name
  field, default "Counter tablet") → `POST /api/store-devices` → save → straight to the grid. In tablet
  mode, a manager sees the store's tablets with Remove, and "Stop using this device as the store
  tablet" (revokes this one, clears it, back to sign-in). Everyone: "Change my PIN" (password + PIN →
  `/api/me/pin`).
- iPad (browser build `/app/store/`): the same, via `keystore.web.ts` (localStorage).

## Added after review (2026-10-17) — as built

- **Sessions remember their tablet.** A token from `/api/tablet/unlock` or `/set-pin` carries
  `dev: <store_devices id>`; `getSession()` refuses it the moment that tablet is removed, so Remove
  ends a session already unlocked on it. Such a session **cannot enrol another tablet** (403 "Sign in
  with your username and password to set up a store tablet.").
- **At most 10 enrolled tablets per store** (409 beyond that).
- **Per-person PIN budget across all tablets:** 10 wrong PINs within 24 h (removed tablets'
  failures included — removing a tablet no longer clears its count; migration 8 adds
  `pin_attempts.last_failure_at`) stops PIN unlock on every tablet: 429 "Too many wrong PINs for
  <first name> on this store's tablets. Set a new PIN with your password." `set-pin` (password) is the
  way out and clears all of that person's counts.
- **Locks answer before any secret is checked** (unlock and set-pin), so a locked person's guesses
  learn nothing, not even from timing. The new PIN is hashed only after the password is accepted.
- **A password reset, a password change or deactivating a user drops their PIN** (`admin.ts`).
- **The desk session ends whenever the tablet locks** (Switch, idle, 401, restart, removal): the app
  POSTs `/api/auth/logout`, which clears the hand-off cookie (browser: same origin; Android: React
  Native's fetch shares the WebView's cookie jar).
- **Browser tablets:** enrolling is refused when the browser can't keep the key past a reload
  (private browsing / Safari "Block All Cookies").

Verified 2026-10-17 against the dev server: enrol → names → set PIN → 5 wrong (403 ×4, 429) → right PIN
still 429 → second tablet 5 wrong → third tablet refused by the budget → set-pin with password escapes →
unlock → `/api/me` 200 → remove that tablet → `/api/me` 401; a PIN-unlocked manager can't enrol (403);
browser build on a 768×1024 and a 375×812 viewport: enrol, names, PIN pad (one request per 4 digits),
"Rahul · Switch", staff token never saved, reload → names.
