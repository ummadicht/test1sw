"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Card, ErrorText, fmtDate } from "@/components/ui";
import { ROLE_NAME } from "@/components/platform/labels";
import type { KeycloakSyncMode, KeycloakSyncResult, KeycloakSyncStatus } from "@/lib/server/keycloakSync";

export function KeycloakDirectorySync({ initialStatus }: { initialStatus: KeycloakSyncStatus }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<KeycloakSyncStatus>(initialStatus);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncMode, setSyncMode] = useState<KeycloakSyncMode>("incremental");
  const [deactivateMissing, setDeactivateMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<KeycloakSyncResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [uploadedPayload, setUploadedPayload] = useState<unknown | null>(null);

  async function runSync(opts: {
    source: "admin_api" | "realm_json";
    mode?: KeycloakSyncMode;
    dryRun: boolean;
    payload?: unknown;
  }) {
    setBusy(true);
    setError(null);
    try {
      const effectiveMode = opts.mode ?? syncMode;
      let realmJson = opts.payload;
      if (opts.source === "realm_json" && !realmJson) {
        const res = await fetch("/api/auth/keycloak/realm-export", { cache: "no-store" });
        if (!res.ok) throw new Error("Could not load realm export JSON.");
        realmJson = await res.json();
      }

      const data = await api<{ result: KeycloakSyncResult; status: KeycloakSyncStatus }>(
        "/api/admin/keycloak/sync",
        {
          body: {
            source: opts.source,
            mode: effectiveMode,
            realmJson: opts.source === "realm_json" ? realmJson : undefined,
            deactivateMissing: effectiveMode === "full" ? deactivateMissing : false,
            dryRun: opts.dryRun,
          },
        }
      );

      setLastResult(data.result);
      setStatus(data.status);
      if (!opts.dryRun) {
        router.refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      setFileName(file.name);
      setUploadedPayload(parsed);
    } catch {
      setError("Selected file is not valid JSON.");
      setFileName(null);
      setUploadedPayload(null);
    }
  }

  const changedItems = lastResult
    ? lastResult.items.filter((i) => i.action !== "unchanged")
    : [];

  return (
    <Card pad={false} className="mb-5">
      <div className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-[15px]">Keycloak Directory Sync</span>
            <span className="pill num text-[12px]">realm: {status.realm}</span>
            <span className="pill text-[12px]">
              {syncMode === "incremental" ? "Incremental sync" : "Full bulk sync"}
            </span>
            {status.adminApiConfigured ? (
              <span className="pill pill-up text-[12px]">Admin API ready</span>
            ) : (
              <span className="pill text-[12px]">Realm JSON sync</span>
            )}
          </div>
          <div className="hint !mt-0.5">
            {status.lastSync ? (
              <>
                Last synced {fmtDate(status.lastSync.at, true)} ({status.lastSync.mode} via{" "}
                {status.lastSync.source === "admin_api" ? "Keycloak Admin API" : "Realm JSON"}) ·{" "}
                <span className="num">
                  {status.lastSync.totals.evaluated} evaluated,{" "}
                  {status.lastSync.totals.skippedUnmodified} skipped unmodified,{" "}
                  {status.lastSync.totals.created} created, {status.lastSync.totals.updated} updated
                </span>
              </>
            ) : (
              <>
                Incrementally syncs modified user roles (`platform`, `partner`, `org_admin`, `store_manager`, `advisor`) and organisation mappings into the local `users` table.
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {status.adminApiConfigured ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => runSync({ source: "admin_api", mode: syncMode, dryRun: false })}
            >
              {busy
                ? "Syncing…"
                : syncMode === "incremental"
                  ? "Incremental sync now"
                  : "Full sync now"}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide sync options" : "Directory sync options"}
          </button>
        </div>
      </div>

      {open ? (
        <div className="border-t border-line px-5 py-4 space-y-4 bg-[color:var(--surface-2)]">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-line">
            <div className="space-y-1">
              <div className="text-[13.5px] font-semibold">Synchronisation Strategy</div>
              <p className="hint !mt-0">
                {syncMode === "incremental" ? (
                  <>
                    Only fetches and updates users modified since{" "}
                    <span className="num font-medium">
                      {status.watermark ? fmtDate(status.watermark.lastSyncedAt, true) : "initial sync"}
                    </span>{" "}
                    ({status.watermark?.trackedUsersCount ?? 0} tracked user digests).
                  </>
                ) : (
                  <>Evaluates every user in the realm directory regardless of modification timestamp.</>
                )}
              </p>
            </div>
            <div className="inline-flex rounded-[8px] border border-line bg-[color:var(--surface)] p-0.5">
              <button
                type="button"
                className={`btn btn-sm !border-0 ${syncMode === "incremental" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setSyncMode("incremental")}
              >
                Incremental (modified only)
              </button>
              <button
                type="button"
                className={`btn btn-sm !border-0 ${syncMode === "full" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setSyncMode("full")}
              >
                Full bulk sync
              </button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <div className="text-[13.5px] font-semibold">1. Live Keycloak Admin REST API</div>
              <p className="hint !mt-0">
                {syncMode === "incremental" ? (
                  <>
                    Queries <code className="num text-[12.5px]">/admin-events</code> and{" "}
                    <code className="num text-[12.5px]">modifyTimestamp</code> digests on{" "}
                    <code className="num text-[12.5px]">
                      {status.baseUrl ? `${status.baseUrl}/admin/realms/${status.realm}` : `/admin/realms/${status.realm}`}
                    </code>{" "}
                    to fetch only modified users.
                  </>
                ) : (
                  <>
                    Pulls all users, realm roles, and `org_id` / `store_id` attributes from{" "}
                    <code className="num text-[12.5px]">
                      {status.baseUrl ? `${status.baseUrl}/admin/realms/${status.realm}` : `/admin/realms/${status.realm}`}
                    </code>
                    .
                  </>
                )}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy || !status.adminApiConfigured}
                  onClick={() => runSync({ source: "admin_api", mode: syncMode, dryRun: false })}
                >
                  {busy
                    ? "Syncing…"
                    : syncMode === "incremental"
                      ? "Run incremental sync"
                      : "Run full directory sync"}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || !status.adminApiConfigured}
                  onClick={() => runSync({ source: "admin_api", mode: syncMode, dryRun: true })}
                >
                  Dry run (preview)
                </button>
              </div>
              {!status.adminApiConfigured ? (
                <p className="hint !text-[12.5px]">
                  Set <code className="num">KEYCLOAK_URL</code> and <code className="num">KEYCLOAK_ADMIN_USERNAME</code> /{" "}
                  <code className="num">KEYCLOAK_CLIENT_SECRET</code> to enable direct Admin API polling, or sync from a realm JSON file on the right.
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="text-[13.5px] font-semibold">2. Realm Export JSON Sync</div>
              <p className="hint !mt-0">
                Reconciles roles and organisation mappings from a Keycloak <code className="num">{status.realm}</code> realm JSON file (skipping unmodified accounts in incremental mode).
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {fileName ? `File: ${fileName}` : "Choose realm JSON…"}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() =>
                    runSync({
                      source: "realm_json",
                      mode: syncMode,
                      dryRun: false,
                      payload: uploadedPayload ?? undefined,
                    })
                  }
                >
                  {busy
                    ? "Syncing…"
                    : uploadedPayload
                      ? `Apply ${syncMode} JSON sync`
                      : `Sync default realm JSON (${syncMode})`}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    runSync({
                      source: "realm_json",
                      mode: syncMode,
                      dryRun: true,
                      payload: uploadedPayload ?? undefined,
                    })
                  }
                >
                  Dry run
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy}
                  onClick={async () => {
                    setError(null);
                    try {
                      const res = await fetch(
                        `/api/auth/keycloak/realm-export?origin=${encodeURIComponent(window.location.origin)}`,
                        { cache: "no-store" }
                      );
                      if (!res.ok) throw new Error("Failed to export realm JSON.");
                      const text = await res.text();
                      JSON.parse(text);
                      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${status.realm}-realm-export.json`;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(url);
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  Export realm JSON
                </button>
              </div>
            </div>
          </div>

          {syncMode === "full" ? (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-line">
              <label className="inline-flex items-center gap-2 text-[13.5px] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={deactivateMissing}
                  onChange={(e) => setDeactivateMissing(e.target.checked)}
                />
                <span>Deactivate local accounts that are no longer present in the Keycloak realm directory</span>
              </label>
            </div>
          ) : null}

          <ErrorText error={error} />

          {lastResult ? (
            <div className="rounded-[10px] border border-line bg-[color:var(--surface)] p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold text-[14px]">
                  {lastResult.dryRun ? "Dry-run preview" : "Sync complete"} —{" "}
                  <span className="uppercase text-[12px] tracking-wide">{lastResult.mode}</span> (
                  {lastResult.source === "admin_api" ? "Keycloak Admin API" : "Realm JSON"})
                </div>
                <div className="num text-[13px] text-ink-2">
                  Directory {lastResult.totals.totalInDirectory} · Evaluated {lastResult.totals.evaluated} · Skipped unmodified {lastResult.totals.skippedUnmodified} · Created {lastResult.totals.created} · Updated {lastResult.totals.updated} · Deactivated {lastResult.totals.deactivated} · Unchanged {lastResult.totals.unchanged}
                  {lastResult.totals.skipped > 0 ? ` · Skipped ${lastResult.totals.skipped}` : ""}
                </div>
              </div>

              {changedItems.length === 0 ? (
                <div className="text-[13.5px] text-ink-2">
                  {lastResult.mode === "incremental" && lastResult.totals.skippedUnmodified > 0 ? (
                    <>
                      No users were modified since{" "}
                      <span className="num">{lastResult.since ? fmtDate(lastResult.since, true) : "last sync"}</span>{" "}
                      ({lastResult.totals.skippedUnmodified} unmodified accounts skipped).
                    </>
                  ) : (
                    <>
                      All accounts in the <code className="num">users</code> table already match the realm directory.
                    </>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="table !text-[13px]">
                    <thead>
                      <tr>
                        <th>Username</th>
                        <th>Action</th>
                        <th>Role</th>
                        <th>Organisation · store</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changedItems.map((item, idx) => (
                        <tr key={`${item.username}-${idx}`}>
                          <td className="num font-semibold">{item.username}</td>
                          <td>
                            <span
                              className={`pill ${
                                item.action === "created" || item.action === "updated"
                                  ? "pill-up"
                                  : item.action === "deactivated"
                                    ? "pill-bad"
                                    : ""
                              }`}
                            >
                              {item.action}
                            </span>
                          </td>
                          <td>{item.role ? ROLE_NAME[item.role] : "—"}</td>
                          <td>
                            {item.orgName ?? "—"}
                            {item.storeName ? ` · ${item.storeName}` : ""}
                          </td>
                          <td className="text-ink-2">
                            {item.changes?.join("; ") || item.reason || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
