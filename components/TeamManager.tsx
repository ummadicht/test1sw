"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Card, Empty, ErrorText, Field, fmtDate } from "@/components/ui";
import type { Role } from "@/lib/server/auth";
import type { UserView } from "@/lib/server/admin";
import { ROLE_NAME, ROLE_HINT, ORG_KIND_LABEL, orgKindForRole, roleNeedsStore } from "@/components/platform/labels";

export type TeamOrgOption = { id: string; name: string; kind: "platform" | "client" | "partner" };
export type TeamStoreOption = { id: string; name: string; orgId: string };

type Props = {
  title: string;
  /** False when the page frame already shows the title (the /admin pages). */
  showTitle?: boolean;
  users: UserView[];
  /** Roles this caller may create — computed on the server exactly like admin.ts mayCreate. */
  canCreateRoles: Role[];
  stores: TeamStoreOption[];
  /** Platform only: the organisations a new person can join. */
  orgs?: TeamOrgOption[];
  /** Show the organisation column (platform views across orgs). */
  showOrg?: boolean;
  /** The signed-in user — never offered actions on their own row (that is /account). */
  meId: string;
  /** Every new person joins this org (platform working inside one client). */
  fixedOrgId?: string | null;
  /** Pre-selected org in the picker. */
  defaultOrgId?: string | null;
  /** Where to add a store when a store role has none to choose from; "{orgId}" is replaced with the chosen org. */
  addStoreHref?: string | null;
  intro?: ReactNode;
};

type OneTime = { name: string; username: string; password: string; reason: "created" | "reset" };

function suggestUsername(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 32);
}

export function TeamManager(props: Props) {
  const { title, showTitle = true, users, canCreateRoles, stores, orgs, showOrg = false, meId, fixedOrgId = null, defaultOrgId = null, addStoreHref = null, intro } =
    props;
  const router = useRouter();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [oneTime, setOneTime] = useState<OneTime | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; action: "reset" | "deactivate" } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const secretRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (oneTime) secretRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [oneTime]);

  const canAdd = canCreateRoles.length > 0;
  const manageable = (x: UserView) => x.id !== meId && canCreateRoles.includes(x.role);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return users;
    return users.filter((x) =>
      [x.name, x.username, ROLE_NAME[x.role], x.orgName, x.storeName ?? ""].some((s) => s.toLowerCase().includes(needle))
    );
  }, [users, q]);

  const activeCount = users.filter((x) => x.active).length;
  // A partner's or SwapUp's own team has no stores — drop the column rather than fill it with dashes.
  const showWhere = showOrg || users.some((x) => x.storeId || x.role === "org_admin") || canCreateRoles.some(roleNeedsStore);

  async function act(x: UserView, action: "reset" | "activate" | "deactivate") {
    setBusyId(x.id);
    setRowError(null);
    try {
      if (action === "reset") {
        const r = await api<{ tempPassword: string }>(`/api/users/${encodeURIComponent(x.id)}`, { body: { action } });
        setOneTime({ name: x.name, username: x.username, password: r.tempPassword, reason: "reset" });
      } else {
        await api(`/api/users/${encodeURIComponent(x.id)}`, { body: { action } });
        router.refresh();
      }
      setConfirm(null);
    } catch (e) {
      setRowError(`${x.name}: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {showTitle ? <h1 className="text-[26px] font-[750] tracking-tight leading-tight">{title}</h1> : null}
          <p className={showTitle ? "hint !mt-1" : "text-[15px] font-semibold text-ink-2"}>
            {users.length} {users.length === 1 ? "person" : "people"} · {activeCount} active
            {users.length - activeCount > 0 ? ` · ${users.length - activeCount} deactivated` : ""}
          </p>
        </div>
        {canAdd && !adding ? (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            + Add a person
          </button>
        ) : null}
      </div>

      {intro ? <div className="text-[14px] text-ink-2 leading-relaxed max-w-3xl">{intro}</div> : null}

      {adding ? (
        <AddPerson
          canCreateRoles={canCreateRoles}
          stores={stores}
          orgs={orgs}
          fixedOrgId={fixedOrgId}
          defaultOrgId={defaultOrgId}
          addStoreHref={addStoreHref}
          onCancel={() => setAdding(false)}
          onCreated={(o) => {
            setAdding(false);
            setOneTime(o);
            router.refresh();
          }}
        />
      ) : null}

      {oneTime ? (
        <div ref={secretRef}>
          <OneTimePassword secret={oneTime} onDone={() => setOneTime(null)} />
        </div>
      ) : null}

      <Card pad={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
          <h2 className="section-title">People</h2>
          {users.length > 6 ? (
            <input
              className="input !min-h-[38px] !py-1.5 !text-[14px] max-w-[280px]"
              type="search"
              placeholder="Search name, username, store…"
              aria-label="Search people"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          ) : null}
        </div>
        {rowError ? (
          <div className="px-5">
            <ErrorText error={rowError} />
          </div>
        ) : null}
        {users.length === 0 ? (
          <Empty title="No one here yet">{canAdd ? "Add the first person with “Add a person”." : null}</Empty>
        ) : shown.length === 0 ? (
          <Empty title="No one matches that search" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  {showWhere ? <th>{showOrg ? "Organisation · store" : "Store"}</th> : null}
                  <th className="hidden lg:table-cell">Added</th>
                  <th className="text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => {
                  const isMe = x.id === meId;
                  const can = manageable(x);
                  const pending = confirm?.id === x.id ? confirm.action : null;
                  const busy = busyId === x.id;
                  return (
                    <tr key={x.id} className={x.active ? "" : "text-muted"}>
                      <td className="min-w-[150px]">
                        <div className="font-semibold">
                          {x.name}
                          {isMe ? <span className="pill ml-2 align-middle">You</span> : null}
                        </div>
                        <div className="num text-[13px] text-muted">{x.username}</div>
                      </td>
                      <td className="whitespace-nowrap">
                        <div>{ROLE_NAME[x.role]}</div>
                        <div className="mt-1">{x.active ? <span className="pill pill-up">Active</span> : <span className="pill pill-bad">Deactivated</span>}</div>
                      </td>
                      {showWhere ? (
                        <td className="min-w-[170px]">
                          {showOrg ? <div className="font-medium">{x.orgName}</div> : null}
                          <div className={showOrg ? "text-[13px] text-muted" : ""}>{x.storeName ?? (x.role === "org_admin" ? "All stores" : "—")}</div>
                        </td>
                      ) : null}
                      <td className="hidden lg:table-cell whitespace-nowrap text-[13.5px]">{fmtDate(x.createdAt, false)}</td>
                      <td className="text-right whitespace-nowrap">
                        {isMe ? (
                          <Link href="/account" className="btn btn-sm btn-ghost">
                            Your account
                          </Link>
                        ) : !can ? (
                          <span className="hint">—</span>
                        ) : pending === "reset" ? (
                          <span className="inline-flex flex-wrap items-center justify-end gap-2">
                            <span className="text-[13px] text-ink-2">Old password stops working.</span>
                            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act(x, "reset")}>
                              {busy ? "Resetting…" : "Reset now"}
                            </button>
                            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>
                              Cancel
                            </button>
                          </span>
                        ) : pending === "deactivate" ? (
                          <span className="inline-flex flex-wrap items-center justify-end gap-2">
                            <span className="text-[13px] text-ink-2">They can no longer sign in.</span>
                            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => act(x, "deactivate")}>
                              {busy ? "Deactivating…" : "Deactivate"}
                            </button>
                            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <span className="inline-flex flex-col lg:flex-row items-end lg:items-center justify-end gap-2">
                            {x.active ? (
                              <>
                                <button className="btn btn-sm" disabled={busy} onClick={() => setConfirm({ id: x.id, action: "reset" })}>
                                  Reset password
                                </button>
                                <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirm({ id: x.id, action: "deactivate" })}>
                                  Deactivate
                                </button>
                              </>
                            ) : (
                              <button className="btn btn-sm" disabled={busy} onClick={() => act(x, "activate")}>
                                {busy ? "Activating…" : "Activate"}
                              </button>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ── one-time password ─────────────────────────────────────── */

function OneTimePassword({ secret, onDone }: { secret: OneTime; onDone: () => void }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  return (
    <section className="card border-2 !border-[color:var(--up)]" aria-live="polite">
      <div className="card-pad">
        <div className="section-title !text-up">
          {secret.reason === "created" ? "Account created — temporary password" : "Password reset — temporary password"}
        </div>
        <p className="mt-2 text-[15px]">
          <strong>{secret.name}</strong> signs in as <span className="num font-semibold">{secret.username}</span> with:
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <code className="num select-all text-[26px] sm:text-[30px] font-bold tracking-[0.12em] px-4 py-2 rounded-[10px] bg-[color:var(--surface-2)] border border-line break-all">
            {secret.password}
          </code>
          <button
            className="btn"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(secret.password);
                setCopied("yes");
              } catch {
                setCopied("failed");
              }
            }}
          >
            {copied === "yes" ? "Copied" : "Copy"}
          </button>
        </div>
        {copied === "failed" ? <p className="hint">Copy blocked — copy it by hand.</p> : null}
        <div className="banner banner-warn mt-4">
          <span aria-hidden>⚠</span>
          <div>
            <strong>Shown once.</strong> Hand it over in person, not by WhatsApp or email.
          </div>
        </div>
        <button className="btn btn-primary mt-4" onClick={onDone}>
          I&apos;ve given it to them — hide
        </button>
      </div>
    </section>
  );
}

/* ── add a person ──────────────────────────────────────────── */

function AddPerson({
  canCreateRoles,
  stores,
  orgs,
  fixedOrgId,
  defaultOrgId,
  addStoreHref,
  onCancel,
  onCreated,
}: {
  canCreateRoles: Role[];
  stores: TeamStoreOption[];
  orgs?: TeamOrgOption[];
  fixedOrgId: string | null;
  defaultOrgId: string | null;
  addStoreHref: string | null;
  onCancel: () => void;
  onCreated: (o: OneTime) => void;
}) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [role, setRole] = useState<Role>(canCreateRoles[0]);
  const pickOrg = !!orgs && !fixedOrgId;
  const orgsForRole = useMemo(() => (orgs ?? []).filter((o) => o.kind === orgKindForRole(role)), [orgs, role]);
  const [orgId, setOrgId] = useState<string>(() => {
    if (fixedOrgId) return fixedOrgId;
    const first = (orgs ?? []).filter((o) => o.kind === orgKindForRole(canCreateRoles[0]));
    return first.find((o) => o.id === defaultOrgId)?.id ?? first[0]?.id ?? "";
  });
  const [storeId, setStoreId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveOrgId = fixedOrgId ?? (pickOrg ? orgId : null);
  const storeOptions = stores.filter((s) => !effectiveOrgId || s.orgId === effectiveOrgId);
  const needsStore = roleNeedsStore(role);
  const effectiveStoreId = needsStore ? (storeOptions.length === 1 ? storeOptions[0].id : storeId) : "";

  function changeRole(r: Role) {
    setRole(r);
    if (pickOrg) {
      const options = (orgs ?? []).filter((o) => o.kind === orgKindForRole(r));
      if (!options.some((o) => o.id === orgId)) {
        setOrgId(options.find((o) => o.id === defaultOrgId)?.id ?? options[0]?.id ?? "");
        setStoreId("");
      }
    }
  }

  const username_ = usernameTouched ? username : suggestUsername(name);
  const blockedNoStore = needsStore && storeOptions.length === 0;
  const storeHref = addStoreHref && (!addStoreHref.includes("{orgId}") || effectiveOrgId) ? addStoreHref.replace("{orgId}", encodeURIComponent(effectiveOrgId ?? "")) : null;

  return (
    <Card title="Add a person">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          if (needsStore && !effectiveStoreId) return setError("Choose the store this person works at.");
          if (pickOrg && !effectiveOrgId) return setError("Choose the organisation.");
          setBusy(true);
          try {
            const r = await api<{ user: UserView; tempPassword: string }>("/api/users", {
              body: { name: name.trim(), username: username_, role, orgId: effectiveOrgId, storeId: needsStore ? effectiveStoreId : null },
            });
            onCreated({ name: r.user.name, username: r.user.username, password: r.tempPassword, reason: "created" });
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required minLength={2} maxLength={80} />
          </Field>
          <Field label="Username" hint="3–32 lowercase letters, digits, . - _">
            <input
              className="input num"
              value={username_}
              onChange={(e) => {
                setUsernameTouched(true);
                setUsername(e.target.value.toLowerCase());
              }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </Field>

          <Field label="Role" hint={ROLE_HINT[role]}>
            {canCreateRoles.length === 1 ? (
              <div className="input flex items-center bg-[color:var(--surface-2)]">{ROLE_NAME[role]}</div>
            ) : (
              <select className="select" value={role} onChange={(e) => changeRole(e.target.value as Role)}>
                {canCreateRoles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_NAME[r]}
                  </option>
                ))}
              </select>
            )}
          </Field>

          {pickOrg ? (
            <Field label={`Organisation (${ORG_KIND_LABEL[orgKindForRole(role)].toLowerCase()})`}>
              {orgsForRole.length === 0 ? (
                <div className="input flex items-center text-muted">No {ORG_KIND_LABEL[orgKindForRole(role)].toLowerCase()} organisation exists yet</div>
              ) : (
                <select
                  className="select"
                  value={orgId}
                  onChange={(e) => {
                    setOrgId(e.target.value);
                    setStoreId("");
                  }}
                >
                  {orgsForRole.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}

          {needsStore ? (
            <Field label="Store">
              {storeOptions.length === 0 ? (
                <div className="input flex items-center text-muted">No stores yet</div>
              ) : storeOptions.length === 1 ? (
                <div className="input flex items-center bg-[color:var(--surface-2)]">{storeOptions[0].name}</div>
              ) : (
                <select className="select" value={storeId} onChange={(e) => setStoreId(e.target.value)} required>
                  <option value="">Choose a store…</option>
                  {storeOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
        </div>

        {blockedNoStore ? (
          <div className="banner banner-warn">
            <span aria-hidden>⚠</span>
            <div>
              A {ROLE_NAME[role].toLowerCase()} works at one store, and this programme has none yet.{" "}
              {storeHref ? (
                <Link href={storeHref} className="font-semibold underline">
                  Add a store first
                </Link>
              ) : (
                "Ask your admin to add the store."
              )}
            </div>
          </div>
        ) : null}

        <p className="hint">A temporary password shows once, next.</p>

        <div className="flex flex-wrap gap-3">
          <button className="btn btn-primary" disabled={busy || blockedNoStore || (pickOrg && orgsForRole.length === 0)}>
            {busy ? "Creating…" : "Create account"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
        <ErrorText error={error} />
      </form>
    </Card>
  );
}
