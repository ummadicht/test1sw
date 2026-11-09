import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Banner, Card, Empty, Meter, Money, Pct, Stat, StatusPill } from "@/components/ui";
import { PickupTable } from "@/components/pickups/PickupTable";
import { CloseShortfall } from "@/components/pickups/CloseShortfall";
import { ageLabel, fmtWhen, istMonthStart, wholeDays } from "@/components/pickups/format";
import { BookPickup, type BookableDevice } from "./BookPickup";
import { StoreTablets, type TabletRow } from "./StoreTablets";
import { StorePhonecheck } from "./StorePhonecheck";
import { getStorePhonecheck } from "@/lib/server/phonecheck";
import { listStoreDevices } from "@/lib/server/storeTablet";
import { requirePage } from "@/lib/server/page";
import { HttpError, type SessionUser } from "@/lib/server/auth";
import { creditSummary, type CreditSummary } from "@/lib/server/credit";
import { listPickups, openChargebacks } from "@/lib/server/pickups";
import { programmeReport } from "@/lib/server/reports";
import { getOrg, getStore, storesForUser } from "@/lib/server/scope";
import { dataClearDueIds } from "@/lib/server/cases";
import { nowIso } from "@/lib/server/db";
import { SIGN, type CreditEventKind } from "@/lib/domain/credit";
import { CASE_STATUS_LABEL } from "@/lib/domain/lifecycle";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Credit & pickups" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] : v) || null;

const STATE: Record<CreditSummary["position"]["state"], { label: string; pill: string; text: string }> = {
  ok: { label: "Healthy", pill: "pill-up", text: "text-up" },
  warn: { label: "Nearly full", pill: "pill-warn", text: "text-warn" },
  full: { label: "Full", pill: "pill-bad", text: "text-bad" },
  over: { label: "Over the limit", pill: "pill-bad", text: "text-bad" },
};

const KIND: Record<CreditEventKind, { label: string; pill: string }> = {
  hold: { label: "Hold", pill: "pill-warn" },
  release: { label: "Release", pill: "pill-up" },
  chargeback: { label: "Chargeback", pill: "pill-bad" },
  recovery: { label: "Recovery", pill: "pill-up" },
};

function caseStatusLabel(s: string): string {
  return (CASE_STATUS_LABEL as Record<string, string>)[s] ?? s;
}

async function partnerNameFor(orgId: string): Promise<string> {
  const org = await getOrg(orgId);
  const pOrg = org?.partner_id ? await getOrg(org.partner_id) : null;
  return pOrg?.name ?? "the buyback partner";
}

export default async function StorePage({ searchParams }: { searchParams: SP }) {
  const u = await requirePage(["store_manager", "org_admin", "platform"], "/store");
  const sp = await searchParams;
  const isManager = u.role === "store_manager";
  const scope = isManager ? [] : await storesForUser(u);
  let storeId = isManager ? u.storeId : one(sp.storeId);
  if (!storeId && scope.length === 1) storeId = scope[0].id;

  if (!storeId) {
    return (
      <AppShell user={u}>
        <StorePicker u={u} />
      </AppShell>
    );
  }

  let cs: CreditSummary;
  try {
    cs = await creditSummary(u, storeId, { withLedger: true });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const store = (await getStore(cs.store.id))!;
  const partner = await partnerNameFor(store.org_id);
  const now = nowIso();
  const { policy, position: pos, advice } = cs;
  const st = STATE[pos.state];

  const pickups = await listPickups(u, { storeId: cs.store.id });
  const pickupRef = new Map(pickups.map((p) => [p.id, p.ref]));
  const pickupOfCase = new Map<string, { id: string; ref: string }>();
  for (const p of pickups) for (const i of p.items) if (!pickupOfCase.has(i.id)) pickupOfCase.set(i.id, { id: p.id, ref: p.ref });
  const chargebacks = await openChargebacks(u, cs.store.id);
  // Newest first by when it happened (demo data back-dates some holds, so posting order alone reads oddly).
  const ledger = [...(cs.ledger ?? [])].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : Number(b.id) - Number(a.id)));

  const dataDue = await dataClearDueIds(cs.store.id);
  const bookable: BookableDevice[] = cs.held
    .filter((h) => h.status === "locked")
    .map((h) => ({ caseId: h.caseId, ref: h.ref, label: h.label, value: h.value, days: wholeDays(h.heldSince, now), dataDue: dataDue.has(h.caseId) }));
  const onPickup = cs.held.length - bookable.length;

  const month = istMonthStart(now);
  const monthRow = (await programmeReport(u, { from: month.iso })).stores.find((s) => s.storeId === cs.store.id) ?? null;

  const tablets: TabletRow[] = (await listStoreDevices(u, cs.store.id)).map((d) => {
    const age = d.lastSeenAt ? ageLabel(d.lastSeenAt, now) : null;
    return {
      id: d.id,
      name: d.name,
      added: fmtWhen(d.createdAt),
      addedBy: d.createdBy,
      lastSeen: age === null ? null : age === "just now" || age === "—" ? age : `${age} ago`,
      lastSeenExact: d.lastSeenAt ? fmtWhen(d.lastSeenAt) : null,
      removed: d.revokedAt ? fmtWhen(d.revokedAt, false) : null,
    };
  });

  const releaseRule =
    policy.releaseOn === "collected"
      ? "Credit frees up on collection."
      : "Credit frees up once the partner clears them.";
  const usedPct = Number.isFinite(pos.utilisation) ? Math.round(pos.utilisation * 100) : 100;

  return (
    <AppShell user={u}>
      <div className="space-y-5">
        {/* ── heading ─────────────────────────────────────── */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {!isManager ? (
              <Link href="/store" className="text-[14px] font-semibold text-ink-2 no-underline hover:underline">
                ← All stores
              </Link>
            ) : null}
            <h1 className="text-[26px] sm:text-[30px] font-[750] tracking-tight">{isManager ? "Credit & pickups" : cs.store.name}</h1>
            <p className="text-[15px] text-ink-2">
              {isManager ? cs.store.name : (await getOrg(store.org_id))?.name}
              {cs.store.city ? ` · ${cs.store.city}` : ""} · <span className="num">{cs.store.code}</span>
            </p>
          </div>
        </div>

        {/* ── the credit line ─────────────────────────────── */}
        <Card>
          <div className="grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-6 lg:gap-10">
            <div>
              <div className="section-title">Available for trade-ins</div>
              <div className={`mt-2 text-[44px] sm:text-[58px] font-[780] leading-none tracking-tight ${st.text}`}>
                <Money value={pos.available} />
              </div>
              <div className="mt-2 text-[15px] text-ink-2">
                <span className="num font-semibold">{usedPct}%</span> of the credit limit used
              </div>
              <div className="mt-4">
                <Meter value={Number.isFinite(pos.utilisation) ? pos.utilisation : 1} state={pos.state} />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className={`pill ${st.pill}`}>{st.label}</span>
                <span className="text-[12.5px] text-muted">Pickup advised at {Math.round(policy.warnAt * 100)}% used</span>
              </div>
              <p className="mt-4 text-[15px] font-semibold">{releaseRule}</p>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 content-start lg:border-l lg:border-line lg:pl-10">
              <Stat
                label={policy.releaseOn === "collected" ? "Held at the store" : "Held until cleared"}
                value={<Money value={pos.held} />}
                sub={
                  policy.releaseOn === "collected"
                    ? `${cs.held.length} ${cs.held.length === 1 ? "phone" : "phones"}`
                    : `${cs.held.length} here, ${cs.inTransit.count} with the partner`
                }
              />
              <Stat
                label="Chargebacks open"
                value={<Money value={pos.chargebacksOpen} />}
                tone={pos.chargebacksOpen > 0 ? "bad" : undefined}
                sub={chargebacks.length ? `${chargebacks.length} ${chargebacks.length === 1 ? "shortfall" : "shortfalls"}` : "Nothing owed"}
              />
              <Stat label="Using the line" value={<Money value={pos.exposure} />} sub="Held + chargebacks open" />
              <Stat label="Credit limit" value={<Money value={pos.limit} />} sub="Set by admin" />
            </div>
          </div>
        </Card>

        {/* ── pickup advice ───────────────────────────────── */}
        <section className="space-y-3" aria-label="Pickup advice">
          {pos.state === "full" || pos.state === "over" ? (
            <Banner tone="bad">
              <strong>No trade-ins now</strong> — the line is {pos.state === "over" ? "over its limit" : "full"}.
            </Banner>
          ) : null}
          {advice.due ? (
            <Banner tone="warn">
              <strong>Book a pickup.</strong>
              <ul className="mt-1 list-disc pl-5">
                {advice.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {onPickup > 0 ? (
                <div className="mt-1">{onPickup} already on a pickup.</div>
              ) : null}
            </Banner>
          ) : cs.held.length ? (
            <Banner>No pickup due yet.</Banner>
          ) : (
            <Banner>No phones waiting.</Banner>
          )}
          {isManager && bookable.length ? (
            <BookPickup devices={bookable} maxAgeDays={policy.maxAgeDays} partnerName={partner} primary={advice.due || pos.state !== "ok"} />
          ) : isManager && onPickup > 0 ? (
            <p className="hint">All waiting phones are on a pickup.</p>
          ) : null}
        </section>

        {/* ── waiting at the store ────────────────────────── */}
        <Card title={`Waiting at the store (${cs.held.length})`} pad={false}>
          {cs.held.length === 0 ? (
            <Empty title="Nothing waiting">Traded-in phones show here.</Empty>
          ) : (
            <div className="overflow-x-auto px-5 pb-3">
              <table className="table min-w-[680px]">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Phone</th>
                    <th className="text-right!">Trade-in value</th>
                    <th>Days held</th>
                    <th>Status</th>
                    <th>Pickup</th>
                  </tr>
                </thead>
                <tbody>
                  {cs.held.map((h) => {
                    const days = wholeDays(h.heldSince, now);
                    const old = days >= policy.maxAgeDays;
                    return (
                      <tr key={h.caseId}>
                        <td>
                          <Link href={`/cases/${h.caseId}`} className="font-semibold num hover:underline whitespace-nowrap">
                            {h.ref}
                          </Link>
                        </td>
                        <td className="font-medium">
                          {h.label}
                          {dataDue.has(h.caseId) ? (
                            <Link href={`/cases/${h.caseId}#data-clear`} className="block text-[12.5px] text-warn font-semibold hover:underline">
                              Data not cleared
                            </Link>
                          ) : null}
                        </td>
                        <td className="text-right">
                          <div className="flex flex-col items-end gap-1">
                            <Money value={h.value} className="font-semibold" />
                          </div>
                        </td>
                        <td>
                          <span className={old ? "pill pill-warn" : "num"} title={`Taken in ${fmtWhen(h.heldSince)}`}>
                            {days} {days === 1 ? "day" : "days"}
                            {old ? ` · over ${policy.maxAgeDays}` : ""}
                          </span>
                        </td>
                        <td>
                          <StatusPill status={h.status} label={caseStatusLabel(h.status)} />
                        </td>
                        <td>
                          {h.pickupId ? (
                            <Link href={`/pickups/${h.pickupId}`} className="num font-semibold hover:underline whitespace-nowrap">
                              {pickupRef.get(h.pickupId) ?? "View"}
                            </Link>
                          ) : (
                            <span className="text-muted">—</span>
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

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* ── with the partner ──────────────────────────── */}
          <Card title="With the partner">
            <div className="flex items-baseline gap-3">
              <span className="kpi">{cs.inTransit.count}</span>
              <span className="text-ink-2">{cs.inTransit.count === 1 ? "phone" : "phones"} worth</span>
              <Money value={cs.inTransit.value} className="text-[18px] font-semibold" />
            </div>
            <p className="hint mt-2!">
              {policy.releaseOn === "collected" ? "Awaiting inspection — off the line." : "Awaiting inspection — on the line until cleared."}
            </p>
          </Card>

          {/* ── open chargebacks ──────────────────────────── */}
          <Card title={`Open chargebacks (${chargebacks.length})`} className="lg:col-span-2" pad={false}>
            {chargebacks.length === 0 ? (
              <Empty title="No open chargebacks">Partner shortfalls show here.</Empty>
            ) : (
              <div className="overflow-x-auto px-5 pb-3">
                <table className="table min-w-[560px]">
                  <thead>
                    <tr>
                      <th>Case</th>
                      <th className="text-right!">Open</th>
                      <th>Reason</th>
                      <th>Status</th>
                      {!isManager ? <th /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {chargebacks.map((c) => {
                      const pk = pickupOfCase.get(c.caseId);
                      return (
                        <tr key={c.caseId}>
                          <td>
                            <Link href={`/cases/${c.caseId}`} className="font-semibold num hover:underline whitespace-nowrap">
                              {c.ref}
                            </Link>
                            {pk ? (
                              <div className="text-[12px]">
                                <Link href={`/pickups/${pk.id}`} className="text-muted hover:underline">
                                  on {pk.ref}
                                </Link>
                              </div>
                            ) : null}
                          </td>
                          <td className="text-right">
                            <Money value={c.open} className="font-semibold text-bad" />
                          </td>
                          <td className="text-[13.5px] text-ink-2 max-w-[280px]">{c.reason ?? <span className="text-muted">—</span>}</td>
                          <td>
                            <StatusPill status={c.status} label={caseStatusLabel(c.status)} />
                          </td>
                          {!isManager ? (
                            <td className="text-right">
                              <CloseShortfall caseId={c.caseId} caseRef={c.ref} open={c.open} />
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {isManager ? <p className="hint pb-2">Your admin closes these.</p> : null}
              </div>
            )}
          </Card>
        </div>

        {/* ── pickups ─────────────────────────────────────── */}
        <Card title={`Pickups (${pickups.length})`}>
          {pickups.length === 0 ? (
            <Empty title="No pickups yet">{isManager ? "Book one above when phones are waiting." : "The store manager books pickups."}</Empty>
          ) : (
            <PickupTable pickups={pickups} cols={["status", "devices", "quoted", "accepted", "requested", "settlement"]} now={now} />
          )}
        </Card>

        {/* ── this month ──────────────────────────────────── */}
        <Card title={`This month · ${month.label}`}>
          {monthRow ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-5">
                <Stat label="Cases opened" value={monthRow.funnel.cases} />
                <Stat label="Upgrades" value={monthRow.funnel.upgrades} tone={monthRow.funnel.upgrades ? "up" : undefined} />
                <Stat label="Repairs" value={monthRow.funnel.repairs} />
                <Stat
                  label="Upgrade rate"
                  value={monthRow.upgradeRate === null ? "—" : `${Math.round(monthRow.upgradeRate * 100)}%`}
                  sub={monthRow.upgradeRate === null ? "No decided cases yet" : `${monthRow.funnel.walked} walked away`}
                />
                <Stat label="Bonus given" value={<Money value={monthRow.bonusTotal} />} />
                <Stat label="Average bonus" value={<Pct bp={monthRow.avgBonusBp} />} />
              </div>
              <details className="hint mt-4!">
                <summary className="cursor-pointer font-semibold">How it&apos;s counted</summary>
                <p className="mt-1">
                  By day opened, from 1 {month.label.split(" ")[0]}. Rate = upgrades ÷ (repairs + upgrades + walk-aways).
                </p>
              </details>
            </>
          ) : (
            <Empty title="No figures for this store" />
          )}
        </Card>

        {/* ── store tablets ───────────────────────────────── */}
        <StoreTablets tablets={tablets} canRemove={isManager} />

        {/* ── Phonecheck station (docs/GRADING.md) ─────────── */}
        <StorePhonecheck storeId={cs.store.id} initial={await getStorePhonecheck(u, cs.store.id)} canEdit />

        {/* ── credit ledger ───────────────────────────────── */}
        <Card
          title="Credit ledger"
          action={
            <span className="text-[12.5px] text-muted">
              <span className="num">+</span> uses credit · <span className="num">−</span> frees credit
            </span>
          }
          pad={false}
        >
          {ledger.length === 0 ? (
            <Empty title="No credit movements yet" />
          ) : (
            <div className="overflow-x-auto px-5 pb-3">
              <table className="table min-w-[640px]">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Movement</th>
                    <th>Case</th>
                    <th className="text-right!">Amount</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((l) => {
                    const k = KIND[l.kind];
                    const signed = SIGN[l.kind] * Number(l.amount);
                    return (
                      <tr key={l.id}>
                        <td className="whitespace-nowrap text-[13.5px]">{fmtWhen(l.at)}</td>
                        <td>
                          <span className={`pill ${k.pill}`}>{k.label}</span>
                        </td>
                        <td>
                          {l.case_ref ? (
                            <Link href={`/cases/${l.case_id}`} className="num font-semibold hover:underline whitespace-nowrap">
                              {l.case_ref}
                            </Link>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className={`text-right font-semibold whitespace-nowrap ${signed > 0 ? "" : "text-up"}`}>
                          <Money value={signed} sign />
                        </td>
                        <td className="text-[13.5px] text-ink-2">{l.note ?? <span className="text-muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {ledger.length >= 200 ? <p className="hint pb-2">Showing the latest 200 movements.</p> : null}
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}

/** Programme admins and the platform pick a store first. */
async function StorePicker({ u }: { u: SessionUser }) {
  const report = await programmeReport(u);
  const stores = await storesForUser(u);
  const orgPairs = await Promise.all(stores.map(async (s) => [s.id, (await getOrg(s.org_id))?.name ?? ""] as const));
  const orgOf = new Map(orgPairs);
  const multiOrg = new Set(orgOf.values()).size > 1;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[26px] sm:text-[30px] font-[750] tracking-tight">Store credit & pickups</h1>
        <p className="text-[15px] text-ink-2">Choose a store.</p>
      </div>
      <Card pad={false}>
        {report.stores.length === 0 ? (
          <Empty title="No stores yet" />
        ) : (
          <div className="overflow-x-auto px-5 pb-3 pt-2">
            <table className="table min-w-[680px]">
              <thead>
                <tr>
                  <th>Store</th>
                  {multiOrg ? <th>Client</th> : null}
                  <th className="text-right!">Available</th>
                  <th>Line used</th>
                  <th className="text-right!">Waiting</th>
                  <th>Pickup</th>
                </tr>
              </thead>
              <tbody>
                {report.stores.map((s) => (
                  <tr key={s.storeId}>
                    <td>
                      <Link href={`/store?storeId=${s.storeId}`} className="font-semibold hover:underline">
                        {s.storeName}
                      </Link>
                      {s.city ? <div className="text-[12.5px] text-muted">{s.city}</div> : null}
                    </td>
                    {multiOrg ? <td className="text-[13.5px]">{orgOf.get(s.storeId)}</td> : null}
                    <td className="text-right">
                      <Money value={s.available} className={`font-semibold ${STATE[s.state as keyof typeof STATE]?.text ?? ""}`} />
                      <div className="text-[12px] text-muted">
                        of <Money value={s.limit} />
                      </div>
                    </td>
                    <td className="min-w-[140px]">
                      <Meter value={Number.isFinite(s.utilisation) ? s.utilisation : 1} state={s.state} />
                      <div className="text-[12px] text-muted mt-1 num">{Number.isFinite(s.utilisation) ? Math.round(s.utilisation * 100) : 100}%</div>
                    </td>
                    <td className="text-right num">{s.waiting}</td>
                    <td>{s.pickupDue ? <span className="pill pill-warn">Due</span> : <span className="text-muted text-[13px]">Not due</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

