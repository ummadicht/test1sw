/**
 * Synchronise user roles and organisation mappings from Keycloak into SwapUp's `users` table.
 *
 *   npx tsx scripts/sync-keycloak-users.ts [--file <path/to/realm-export.json>] [--incremental | --full] [--since <iso-or-ms>] [--deactivate-missing] [--dry-run]
 *
 * Defaults to incremental sync when a prior sync watermark exists for the realm.
 */
import fs from "node:fs";
import { ensureSeeded } from "../lib/server/seed";
import {
  parseKeycloakUsersPayload,
  syncKeycloakDirectoryToDb,
  type KeycloakSyncMode,
} from "../lib/server/keycloakSync";

const USAGE =
  "Usage: npx tsx scripts/sync-keycloak-users.ts [--file <realm.json>] [--incremental | --full] [--since <iso-or-ms>] [--deactivate-missing] [--dry-run]";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  let filePath: string | null = null;
  let mode: KeycloakSyncMode | undefined = undefined;
  let since: string | null = null;
  let deactivateMissing = false;
  let dryRun = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "--file" || a === "-f") {
      const v = rawArgs[++i];
      if (!v) die(USAGE);
      filePath = v;
    } else if (a === "--incremental") {
      mode = "incremental";
    } else if (a === "--full") {
      mode = "full";
    } else if (a === "--since") {
      const v = rawArgs[++i];
      if (!v) die(USAGE);
      since = v;
    } else if (a === "--deactivate-missing") {
      deactivateMissing = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--help" || a === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      die(`Unknown argument: ${a}\n${USAGE}`);
    }
  }

  await ensureSeeded();

  let directoryUsers = undefined;
  let realm = undefined;
  let source: "admin_api" | "realm_json" = "admin_api";

  if (filePath) {
    if (!fs.existsSync(filePath)) {
      die(`File not found: ${filePath}`);
    }
    const rawJson = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const parsed = parseKeycloakUsersPayload(rawJson);
    directoryUsers = parsed.users;
    realm = parsed.realmName;
    source = "realm_json";
  }

  const result = await syncKeycloakDirectoryToDb({
    directoryUsers,
    source,
    mode,
    since,
    realm,
    deactivateMissing,
    dryRun,
  });

  console.log(
    `Keycloak directory sync (${result.mode.toUpperCase()} via ${result.source}, realm="${result.realm}"${result.since ? `, since=${result.since}` : ""}${result.dryRun ? ", DRY RUN" : ""}):`
  );
  console.log(
    `  Directory total: ${result.totals.totalInDirectory} · Evaluated: ${result.totals.evaluated} · Skipped unmodified: ${result.totals.skippedUnmodified} · Created: ${result.totals.created} · Updated: ${result.totals.updated} · Deactivated: ${result.totals.deactivated} · Unchanged: ${result.totals.unchanged} · Skipped: ${result.totals.skipped}`
  );

  for (const item of result.items) {
    if (item.action === "unchanged") continue;
    const detail = item.changes?.join(", ") || item.reason || "";
    console.log(
      `  [${item.action.toUpperCase()}] ${item.username} (${item.role ?? "-"} @ ${item.orgName ?? "-"})${detail ? ` — ${detail}` : ""}`
    );
  }
}

main().catch((err) => {
  die((err as Error).message || String(err));
});
