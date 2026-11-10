/**
 * Incremental vs. full Keycloak directory synchronisation tests on a throwaway database.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/keycloakSync.server.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "swapup-kc-sync-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
delete process.env.SWAPUP_DEMO_PASSWORD;
for (const k of Object.keys(process.env)) if (k.startsWith("PRICEIQ_")) delete process.env[k];

const origLog = console.log;
console.log = () => {};
const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const { generateKeycloakRealmJson } = await import("./keycloak.ts");
const {
  syncKeycloakDirectoryToDb,
  getSyncWatermark,
  getKeycloakSyncStatus,
} = await import("./keycloakSync.ts");

after(() => {
  console.log = origLog;
  rmSync(dir, { recursive: true, force: true });
});

test("incremental sync skips unmodified users and only processes users modified or added since last sync", async () => {
  const realmExport = await generateKeycloakRealmJson("http://localhost:3000", "swapup1");
  const initialUsers = realmExport.users.map((u) => ({
    ...u,
    updatedTimestamp: 1_700_000_000_000,
  }));

  // 1. First sync (no prior watermark): automatically runs in "full" mode and stores watermark + digests
  const firstRun = await syncKeycloakDirectoryToDb({
    directoryUsers: initialUsers,
    realm: "swapup1",
  });
  assert.equal(firstRun.mode, "full");
  assert.equal(firstRun.totals.totalInDirectory, initialUsers.length);
  assert.equal(firstRun.totals.evaluated, initialUsers.length);
  assert.equal(firstRun.totals.skippedUnmodified, 0);

  const watermark1 = await getSyncWatermark("swapup1");
  assert.ok(watermark1, "watermark saved in meta after initial sync");
  assert.equal(Object.keys(watermark1.userDigests).length, initialUsers.length);

  // 2. Second sync with identical users and older timestamps: defaults to "incremental" and skips all unmodified users
  const secondRun = await syncKeycloakDirectoryToDb({
    directoryUsers: initialUsers,
    realm: "swapup1",
  });
  assert.equal(secondRun.mode, "incremental");
  assert.equal(secondRun.totals.totalInDirectory, initialUsers.length);
  assert.equal(secondRun.totals.evaluated, 0, "no unmodified users evaluated");
  assert.equal(secondRun.totals.skippedUnmodified, initialUsers.length, "all unmodified users skipped");
  assert.equal(secondRun.totals.updated, 0);
  assert.equal(secondRun.totals.created, 0);

  // 3. Modify 1 existing user (promote advisor -> store_manager with newer updatedTimestamp) and add 1 new user
  const modifiedBatch = initialUsers.map((u) => {
    if (u.username === "advisor") {
      return {
        ...u,
        firstName: "Rahul",
        lastName: "Desai (Promoted)",
        updatedTimestamp: Date.now() + 5_000,
        attributes: {
          ...u.attributes,
          swapup_role: ["store_manager"],
        },
        realmRoles: ["store_manager"],
      };
    }
    return u;
  });
  modifiedBatch.push({
    username: "new.advisor",
    enabled: true,
    emailVerified: true,
    firstName: "Aarti",
    lastName: "Sharma",
    email: "new.advisor@swapup.local",
    updatedTimestamp: Date.now() + 5_000,
    attributes: {
      swapup_role: ["advisor"],
      org_id: ["org_samsung_svc"],
      store_id: ["st_kor"],
      swapup_user_id: ["usr_new_aarti"],
    },
    credentials: [],
    realmRoles: ["advisor"],
  });

  const thirdRun = await syncKeycloakDirectoryToDb({
    directoryUsers: modifiedBatch,
    realm: "swapup1",
  });
  assert.equal(thirdRun.mode, "incremental");
  assert.equal(thirdRun.totals.totalInDirectory, initialUsers.length + 1);
  assert.equal(thirdRun.totals.skippedUnmodified, initialUsers.length - 1, "9 unmodified users skipped");
  assert.equal(thirdRun.totals.evaluated, 2, "only the 1 modified user + 1 new user evaluated");
  assert.equal(thirdRun.totals.updated, 1);
  assert.equal(thirdRun.totals.created, 1);

  const promotedRow = db()
    .prepare(`SELECT role, name FROM users WHERE username = 'advisor'`)
    .get() as { role: string; name: string };
  assert.equal(promotedRow.role, "store_manager");
  assert.equal(promotedRow.name, "Rahul Desai (Promoted)");

  const createdRow = db()
    .prepare(`SELECT id, role, org_id, store_id, name FROM users WHERE username = 'new.advisor'`)
    .get() as { id: string; role: string; org_id: string; store_id: string; name: string };
  assert.equal(createdRow.id, "usr_new_aarti");
  assert.equal(createdRow.role, "advisor");
  assert.equal(createdRow.org_id, "org_samsung_svc");
  assert.equal(createdRow.store_id, "st_kor");

  // 4. Explicit mode: "full" evaluates all users even if unmodified
  const fourthRun = await syncKeycloakDirectoryToDb({
    directoryUsers: modifiedBatch,
    mode: "full",
    realm: "swapup1",
  });
  assert.equal(fourthRun.mode, "full");
  assert.equal(fourthRun.totals.evaluated, modifiedBatch.length);
  assert.equal(fourthRun.totals.skippedUnmodified, 0);
  assert.equal(fourthRun.totals.unchanged, modifiedBatch.length);

  const status = await getKeycloakSyncStatus();
  assert.ok(status.watermark);
  assert.equal(status.watermark.trackedUsersCount, modifiedBatch.length);
  assert.equal(status.lastSync?.mode, "full");
});
