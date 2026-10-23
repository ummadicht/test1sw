/**
 * SwapUp Store's minimum version (SUP-27), through the real routes on a throwaway database.
 *
 * SwapUp Store (the app and its browser version) sends "X-SwapUp-App: store/<version>+<versionCode>" and
 * a Bearer token. With SWAPUP_STORE_MIN_VERSION set, a store-staff Bearer call from an older, unversioned
 * or unreadable build gets 426 "Update SwapUp Store from /downloads." before the route does anything.
 * Unset, the gate is off (the 0.9.2 tablets in the field send no header). Never gated: the desk (its
 * cookie), SwapUp Check (Ticket) and the store tablet's Device token.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/storeGate.server.test.ts
 */
import "./testing/register.mjs";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "swapup-storegate-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_") || k.startsWith("PHONECHECK_") || k.startsWith("GEMINI_")) delete process.env[k];

const origLog = console.log;
const origError = console.error;
console.log = () => {};
const logged: string[] = [];
console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));

const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const { issueToken, UPDATE_STORE } = await import("./auth.ts");
const sessions = await import("./testSessions.ts");
const { createStoreDevice } = await import("./storeTablet.ts");
const meRoute = await import("../../app/api/me/route.ts");
const casesRoute = await import("../../app/api/cases/route.ts");
const deviceStatusRoute = await import("../../app/api/device/status/route.ts");
const tabletRoute = await import("../../app/api/tablet/route.ts");

after(() => {
  console.log = origLog;
  console.error = origError;
  delete process.env.SWAPUP_STORE_MIN_VERSION;
  rmSync(dir, { recursive: true, force: true });
});

type U = import("./auth.ts").SessionUser;
function who(username: string): U {
  const r = db().prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE username = ?`).get(username) as { id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null };
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
}
const advisor = who("advisor");
const manager = who("manager");
const partner = who("partner");
assert.equal(advisor.role, "advisor");
assert.equal(manager.role, "store_manager");

const G = globalThis as { __swapupTestHeaders?: Record<string, string>; __swapupTestCookies?: Record<string, string> };
/** One request as it arrives: these headers, this cookie jar. */
async function send(res: () => Promise<Response>, headers: Record<string, string>, cookies: Record<string, string> = {}) {
  G.__swapupTestHeaders = headers;
  G.__swapupTestCookies = cookies;
  try {
    const r = await res();
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    G.__swapupTestHeaders = {};
    G.__swapupTestCookies = {};
  }
}
/** SwapUp Store's call: Bearer, plus X-SwapUp-App when given. */
const store = (u: U, app?: string) => ({ authorization: `Bearer ${issueToken(u)}`, ...(app === undefined ? {} : { "x-swapup-app": app }) });
const me = (headers: Record<string, string>, cookies?: Record<string, string>) => send(() => meRoute.GET(), headers, cookies);
const openCase = (headers: Record<string, string>) =>
  send(() => casesRoute.POST(new Request("http://x/api/cases", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })), headers);
const caseCount = () => (db().prepare(`SELECT COUNT(*) AS n FROM cases`).get() as { n: number }).n;

beforeEach(() => {
  delete process.env.SWAPUP_STORE_MIN_VERSION;
});

test("off by default: with SWAPUP_STORE_MIN_VERSION unset, any Store build works — the 0.9.2 tablets send no header", async () => {
  for (const app of [undefined, "", "store/0.8.0+9", "nonsense"]) {
    const r = await me(store(advisor, app));
    assert.equal(r.status, 200, `${app}: ${JSON.stringify(r.body)}`);
  }
  const before = caseCount();
  assert.equal((await openCase(store(advisor))).status, 200);
  assert.equal(caseCount(), before + 1);
});

test("on: an old, unversioned or unreadable Store build gets 426 and the one sentence, before anything is done", async () => {
  process.env.SWAPUP_STORE_MIN_VERSION = "0.9.3";
  const refused = [
    undefined, // the 0.9.2 and 0.8.0 tablets: no header at all
    "",
    "store/0.9.2+14",
    "store/0.8.0+9",
    "store/0.9.2+99", // a higher versionCode does not lift an older version
    "store/0.9.3", // no versionCode
    "store/0.9+15",
    "store/v0.9.3+15",
    "Store/0.9.3+15",
    "check/0.9.3+15", // not SwapUp Store
    "store/0.9.3+15 extra",
  ];
  for (const u of [advisor, manager]) {
    for (const app of refused) {
      const r = await me(store(u, app));
      assert.equal(r.status, 426, `${u.role} ${JSON.stringify(app)}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, { error: UPDATE_STORE });
    }
  }
  assert.equal(UPDATE_STORE, "Update SwapUp Store from /downloads.");
  // Before any work: the old build cannot open a case (nor draw a priced answer on one).
  const before = caseCount();
  const r = await openCase(store(advisor, "store/0.9.2+14"));
  assert.equal(r.status, 426);
  assert.deepEqual(r.body, { error: UPDATE_STORE });
  assert.equal(caseCount(), before);
});

test("on: the minimum and anything newer work unchanged (versions compare as numbers)", async () => {
  process.env.SWAPUP_STORE_MIN_VERSION = "0.9.3";
  for (const app of ["store/0.9.3+15", "store/0.9.4+16", "store/0.10.0+17", "store/1.0.0+20"]) {
    for (const u of [advisor, manager]) {
      const r = await me(store(u, app));
      assert.equal(r.status, 200, `${u.role} ${app}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.username, u.username);
    }
  }
  const before = caseCount();
  assert.equal((await openCase(store(advisor, "store/0.9.3+15"))).status, 200);
  assert.equal(caseCount(), before + 1);
  // A bad token is still a 401 (sign in again), whatever the header says.
  assert.equal((await me({ authorization: "Bearer not-a-token", "x-swapup-app": "store/0.9.2+14" })).status, 401);
});

test("on: the desk's cookie is never refused — no header, any role", async () => {
  process.env.SWAPUP_STORE_MIN_VERSION = "0.9.3";
  for (const u of [advisor, manager, partner]) {
    const r = await me({}, { swapup_session: issueToken(u) });
    assert.equal(r.status, 200, `${u.role}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.username, u.username);
  }
});

test("on: SwapUp Check (Ticket) and the store tablet's Device token are never refused", async () => {
  process.env.SWAPUP_STORE_MIN_VERSION = "0.9.3";
  const created = sessions.createTestSession(advisor, { customerName: "Asha Rao", customerPhone: "9876543210" });
  const joined = sessions.joinByCode(
    {
      code: created.session.code,
      installId: "install-storegate-1",
      appVersion: "0.9.0",
      device: { brand: "samsung", manufacturer: "samsung", modelName: "SM-S918B", modelCode: "SM-S918B", osVersion: "14", totalDiskBytes: 256e9, isPhysicalDevice: true },
    },
    "127.0.0.1"
  );
  const check = await send(() => deviceStatusRoute.GET(new Request("http://x/api/device/status", { headers: { authorization: `Ticket ${joined.ticket}` } })), {});
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.notEqual(check.body.status, "closed");

  // The tablet still lists its staff and unlocks (Device); the update sentence comes on the first staff call.
  const { deviceToken } = createStoreDevice(manager, { name: "Counter tablet" });
  const tablet = await send(() => tabletRoute.GET(new Request("http://x/api/tablet", { headers: { authorization: `Device ${deviceToken}` } })), {});
  assert.equal(tablet.status, 200, JSON.stringify(tablet.body));
});

test("a minimum that is not x.y.z leaves the gate off, and says so in the log once", async () => {
  logged.length = 0;
  for (const min of ["0.9", "latest", "0.9.3-beta"]) {
    process.env.SWAPUP_STORE_MIN_VERSION = min;
    assert.equal((await me(store(advisor))).status, 200, min);
    assert.equal((await me(store(advisor))).status, 200, min);
  }
  assert.equal(logged.filter((l) => l.includes("SWAPUP_STORE_MIN_VERSION is not x.y.z")).length, 3);
  // Whitespace around a good value is not a typo.
  process.env.SWAPUP_STORE_MIN_VERSION = " 0.9.3 ";
  assert.equal((await me(store(advisor))).status, 426);
  assert.equal((await me(store(advisor, "store/0.9.3+15"))).status, 200);
});
