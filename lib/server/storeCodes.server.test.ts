/**
 * Store codes are unique across all programmes so case numbers (SU-<code>-<seq>) never collide.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/storeCodes.server.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "swapup-store-codes-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
delete process.env.SWAPUP_DEMO_PASSWORD;
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_")) delete process.env[k];

const origLog = console.log;
console.log = () => {};
const { ensureSeeded, DEMO_PARTNER } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const { createOrg, createStore, createUser } = await import("./admin.ts");
const { registerStore } = await import("./signup.ts");
const cases = await import("./cases.ts");

after(() => {
  console.log = origLog;
  rmSync(dir, { recursive: true, force: true });
});

type U = import("./auth.ts").SessionUser;
const one = <T>(sql: string, ...args: unknown[]) => db().prepare(sql).get(...args) as T;
const allRows = <T>(sql: string, ...args: unknown[]) => db().prepare(sql).all(...args) as T[];
const userNamed = (username: string): U => {
  const r = one<{ id: string; username: string; name: string; role: U["role"]; org_id: string; store_id: string | null }>(
    `SELECT id, username, name, role, org_id, store_id FROM users WHERE username = ?`,
    username
  );
  return { id: r.id, username: r.username, name: r.name, role: r.role, orgId: r.org_id, storeId: r.store_id, exp: Date.now() + 3_600_000 };
};

test("store codes are unique across all programmes so case numbers never collide", async () => {
  const platform = userNamed("platform");

  // 1. As platform staff, onboard a second client with createOrg (partner: DEMO_PARTNER.orgId)
  const secondClient = await createOrg(platform, {
    name: "Second Client Programme",
    kind: "client",
    clientType: "experience_center",
    targetBrand: "Samsung",
    partnerId: DEMO_PARTNER.orgId,
  });

  const storesBefore = allRows<{ id: string; code: string }>(`SELECT id, code FROM stores ORDER BY id`);
  const codesBefore = new Set(storesBefore.map((s) => s.code));
  assert.ok(codesBefore.has("AND"), "seeded demo store already uses AND");

  // 2. createStore in the second programme with code "AND" is refused with 409, and the stores table is unchanged
  await assert.rejects(
    async () => {
      await createStore(platform, {
        orgId: secondClient.id,
        name: "Andheri East Centre",
        kind: "experience_center",
        city: "Mumbai",
        code: "AND",
        creditLimit: 200_000,
      });
    },
    (err: { status?: number; message?: string }) => {
      assert.equal(err.status, 409);
      assert.equal(err.message, "Another store already uses that code.");
      return true;
    }
  );
  assert.deepEqual(
    allRows<{ id: string; code: string }>(`SELECT id, code FROM stores ORDER BY id`),
    storesBefore,
    "stores table is unchanged when a duplicate code is refused"
  );

  // 3. registerStore into the demo programme with a store name starting "And" gets a code no store had before
  const reg = await registerStore({
    programmeId: "org_xc",
    storeName: "Andheri Link Road Store",
    city: "Mumbai",
    storeKind: "experience_center",
    managerName: "Neha Verma",
    username: "neha.verma",
    password: "securePassword1",
    phone: "9820112233",
  });
  const selfRegCode = reg.user.store?.code;
  assert.ok(selfRegCode, "self-registered store has a code");
  assert.ok(!codesBefore.has(selfRegCode), `self-registered store received a fresh code (${selfRegCode}), not AND`);
  assert.match(selfRegCode, /^AND\d{2}$/);

  // 4. A case at the demo Andheri store first, then two cases at a new store in the second programme with a new code
  const demoAdvisor = userNamed("advisor");
  const demoCase = await cases.createCase(demoAdvisor, { customerName: "Demo Customer" });
  assert.equal(demoCase.ref, "SU-AND-00001");

  const newStore = await createStore(platform, {
    orgId: secondClient.id,
    name: "Bandra West Experience Centre",
    kind: "experience_center",
    city: "Mumbai",
    code: "BND",
    creditLimit: 250_000,
  });
  assert.equal(newStore.code, "BND");

  const { user: newAdvisor } = await createUser(platform, {
    name: "Rohan Kulkarni",
    username: "rohan.bnd",
    role: "advisor",
    orgId: secondClient.id,
    storeId: newStore.id,
  });
  const bndAdvisorSession: U = {
    id: newAdvisor.id,
    username: newAdvisor.username,
    name: newAdvisor.name,
    role: newAdvisor.role,
    orgId: newAdvisor.orgId,
    storeId: newAdvisor.storeId,
    exp: Date.now() + 3_600_000,
  };

  const c1 = await cases.createCase(bndAdvisorSession, { customerName: "First Bandra Customer" });
  const c2 = await cases.createCase(bndAdvisorSession, { customerName: "Second Bandra Customer" });
  assert.equal(c1.ref, "SU-BND-00001");
  assert.equal(c2.ref, "SU-BND-00002");
});
