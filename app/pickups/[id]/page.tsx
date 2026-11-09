import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Banner, Card, Money, StatusPill, Empty } from "@/components/ui";
import { PickupTimeline } from "@/components/pickups/PickupTimeline";
import { ScheduleForm, HandoverForm, VerdictForm, SettleForm, RemoveItemButton, CancelPickupButton } from "@/components/pickups/PickupActions";
import { CloseShortfall } from "@/components/pickups/CloseShortfall";
import { fmtWhen, tomorrowAt } from "@/components/pickups/format";
import { requirePage } from "@/lib/server/page";
import { HttpError, orgSettings } from "@/lib/server/auth";
import { getPickup, openChargebacks, type PickupView } from "@/lib/server/pickups";
import { nowIso } from "@/lib/server/db";
import { CASE_STATUS_LABEL, OUTCOME_LABEL, PICKUP_STATUS_LABEL } from "@/lib/domain/lifecycle";
import { LETTER_NOTE } from "@/components/counter/gradingView";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pickup" };

async function load(u: Parameters<typeof getPickup>[0], id: string): Promise<PickupView> {
  try {
    return await getPickup(u, id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
}

function outcomeLabel(o: string): string {
  return (OUTCOME_LABEL as Record<string, string>)[o] ?? o;
}

type ItemGrading = PickupView["items"][number]["grading"];

/**
 * The SwapUp grade for one phone — the grade report version frozen at hand-over,
 * linked to exactly that version (docs/GRADING.md). The partner's evidence at
 * clearance; it never sets a price, and the link shows none. One place per
 * phone: its row in the list below.
 */
function ItemGrade({ g }: { g: ItemGrading }) {
  if (!g) return <span className="text-muted text-[13px]">No report</span>;
  return (
    <span className="inline-flex flex-col">
      <a href={g.path} target="_blank" rel="noopener" className="font-semibold hover:underline">
        {g.label}
      </a>
      <span className="text-[12px] text-muted">
        report v{g.version}
        {g.final ? ", at hand-over" : ""}
      </span>
    </span>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-semibold text-muted uppercase tracking-wide">{label}</dt>
      <dd className="mt-0.5 text-[14.5px]">{children}</dd>
    </div>
  );
}

export default async function PickupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const u = await requirePage(["store_manager", "partner", "org_admin", "platform"], `/pickups/${id}`);
  const p = await load(u, id);
  const now = nowIso();
  const settings = await orgSettings(p.orgId);
  const releaseOn = settings.releaseOn;
  const liability = settings.shortfallLiability;
  const isManager = u.role === "store_manager";
  const isPartner = u.role === "partner";
  const isAdmin = u.role === "org_admin" || u.role === "platform";
  const open = p.status === "requested" || p.status === "scheduled";

  const itemIds = new Set(p.items.map((i) => i.id));
  const chargebacks = (await openChargebacks(u, p.storeId)).filter((c) => itemIds.has(c.caseId));
  const openByCase = new Map(chargebacks.map((c) => [c.caseId, c.open]));
  const stillOpen = chargebacks.reduce((t, c) => t + c.open, 0);

  const storeShortfall = p.items.reduce(
    (t, i) => t + (i.clearance && (i.clearance.outcome === "not_received" || liability === "store") ? i.clearance.shortfall : 0),
    0
  );
  const partnerShortfall = p.totals.shortfall - storeShortfall;

  const formItems = p.items.map((i) => ({ id: i.id, ref: i.ref, device: i.device, tradeValue: i.tradeValue }));
  const awaitingVerdict = formItems.filter((i) => p.items.find((x) => x.id === i.id)?.status === "collected");

  const back =
    isPartner ? { href: "/partner", label: "Pickup queue" } : isManager ? { href: "/store", label: "Credit & pickups" } : { href: `/store?storeId=${p.storeId}`, label: p.storeName };

  const canCloseFor = (status: string) => isAdmin || (isPartner && status === "not_received");

  return (
    <AppShell user={u}>
      <div className="space-y-5">
        <Link href={back.href} className="text-[14px] font-semibold text-ink-2 no-underline hover:underline">
          ← {back.label}
        </Link>

        {/* ── header ─────────────────────────────────────── */}
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="section-title">Pickup</div>
              <h1 className="mt-1 text-[26px] sm:text-[30px] font-[750] tracking-tight num flex flex-wrap items-center gap-3">
                {p.ref}
                <StatusPill status={p.status} label={PICKUP_STATUS_LABEL[p.status]} />
              </h1>
              <p className="mt-1 text-[15px] text-ink-2">
                <strong>{p.storeName}</strong>
                {p.storeCity ? `, ${p.storeCity}` : ""} · {p.orgName} · collected by <strong>{p.partnerName}</strong>
              </p>
            </div>
            {open && (isManager || isPartner) ? <CancelPickupButton pickupId={p.id} count={p.totals.devices} /> : null}
          </div>
          <dl className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4">
            <Detail label="Requested">
              {fmtWhen(p.requestedAt)}
              {p.requestedBy ? <div className="text-[12.5px] text-muted">by {p.requestedBy}</div> : null}
            </Detail>
            <Detail label="Collection slot">{p.scheduledFor ? fmtWhen(p.scheduledFor) : <span className="text-muted">{p.collectedAt ? "Not booked" : "Not booked yet"}</span>}</Detail>
            <Detail label="Collector">{p.collectorName ?? <span className="text-muted">—</span>}</Detail>
            <Detail label="Handed over">
              {p.collectedAt ? (
                <>
                  {fmtWhen(p.collectedAt)}
                  {p.handoverBy ? <div className="text-[12.5px] text-muted">by {p.handoverBy}</div> : null}
                </>
              ) : (
                <span className="text-muted">Not yet</span>
              )}
            </Detail>
          </dl>
          {p.notes ? (
            <div className="mt-4 text-[14px] text-ink-2">
              <span className="font-semibold">Note from the store:</span> {p.notes}
            </div>
          ) : null}
          <div className="mt-6 pt-5 border-t border-line">
            <PickupTimeline p={p} />
          </div>
        </Card>

        {/* ── the money ──────────────────────────────────── */}
        <Card title="Money on this pickup">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
            <div>
              <div className="section-title">Quoted</div>
              <div className="kpi mt-1">
                <Money value={p.totals.quoted} />
              </div>
              <div className="hint">
                {p.totals.devices} {p.totals.devices === 1 ? "phone" : "phones"}
              </div>
            </div>
            <div>
              <div className="section-title">Accepted</div>
              <div className={`kpi mt-1 ${p.totals.verified ? "text-up" : "text-muted"}`}>{p.totals.verified ? <Money value={p.totals.accepted} /> : "—"}</div>
              <div className="hint">
                {p.totals.verified} of {p.totals.devices} verified
              </div>
            </div>
            <div>
              <div className="section-title">Store shortfall</div>
              <div className={`kpi mt-1 ${storeShortfall ? "text-bad" : ""}`}>
                <Money value={storeShortfall} />
              </div>
              <div className="hint">
                {stillOpen ? (
                  <>
                    <Money value={stillOpen} /> still open
                  </>
                ) : storeShortfall ? (
                  "Closed"
                ) : (
                  "None so far"
                )}
                {partnerShortfall > 0 ? (
                  <>
                    {" "}
                    · <Money value={partnerShortfall} /> on the partner
                  </>
                ) : null}
              </div>
            </div>
            <div>
              <div className="section-title">Paid to the store</div>
              <div className={`kpi mt-1 ${p.settlementRef ? "text-up" : "text-muted"}`}>{p.settlementRef ? <Money value={p.settlementAmount} /> : "—"}</div>
              <div className="hint">{p.settlementRef ? <span className="num">Ref {p.settlementRef}</span> : "Not yet"}</div>
            </div>
          </div>
        </Card>

        {/* ── what happens next ──────────────────────────── */}
        {p.status === "cancelled" ? (
          <Banner>Cancelled — the phones are back at the store.</Banner>
        ) : null}

        {p.status === "requested" && isPartner ? (
          <Card title="Book the collection">
            <ScheduleForm pickupId={p.id} defaultWhen={tomorrowAt(now)} defaultCollector={p.collectorName ?? ""} />
          </Card>
        ) : null}

        {open && isManager && p.status === "requested" ? (
          <Banner>Waiting for the partner to book a slot.</Banner>
        ) : null}
        {open && isManager && p.status === "scheduled" ? (
          <Banner tone="up">
            Collection <strong>{fmtWhen(p.scheduledFor)}</strong>
            {p.collectorName ? (
              <>
                {" "}
                · <strong>{p.collectorName}</strong>
              </>
            ) : null}
            .
          </Banner>
        ) : null}

        {open && (isManager || isPartner) ? (
          <Card title="Hand over the phones">
            <HandoverForm
              pickupId={p.id}
              items={formItems}
              defaultCollector={p.collectorName ?? ""}
              defaultHandoverBy={isManager ? u.name : ""}
              releaseOn={releaseOn}
              partnerName={p.partnerName}
              viewer={isManager ? "store_manager" : "partner"}
            />
          </Card>
        ) : null}

        {open && isAdmin ? (
          <Banner>
            {p.status === "scheduled"
              ? `Collection ${fmtWhen(p.scheduledFor)}.`
              : "Waiting for the partner to book a slot."}
          </Banner>
        ) : null}

        {p.status === "collected" && isPartner ? (
          <Card
            title="Verify these phones"
            action={
              <span className="pill">
                {p.totals.verified} of {p.totals.devices} verified
              </span>
            }
          >
            <p className="text-[14px] text-ink-2 mb-4">Record a verdict for each phone.</p>
            <div className="grid lg:grid-cols-2 gap-4">
              {awaitingVerdict.map((i) => (
                <VerdictForm key={i.id} pickupId={p.id} item={i} storeCarriesShortfall={liability === "store"} />
              ))}
            </div>
          </Card>
        ) : null}
        {p.status === "collected" && !isPartner ? (
          <Banner>
            With the partner for inspection.
          </Banner>
        ) : null}

        {p.status === "reconciled" && isPartner ? (
          <Card title="Settle with the store">
            <SettleForm pickupId={p.id} amount={p.totals.accepted} storeName={p.storeName} />
          </Card>
        ) : null}
        {p.status === "reconciled" && !isPartner ? (
          <Banner>
            All verified — waiting for the partner to pay.
          </Banner>
        ) : null}

        {p.status === "settled" ? (
          <Banner tone="up">
            Settled {fmtWhen(p.settledAt)}.
          </Banner>
        ) : null}

        {/* ── the phones ─────────────────────────────────── */}
        <Card title={`Phones on this pickup (${p.items.length})`} pad={false}>
          {p.items.length === 0 ? (
            <Empty title="No phones on this pickup" />
          ) : (
            <div className="overflow-x-auto px-5 pb-3">
              <table className="table min-w-[880px]">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Phone</th>
                    <th title={LETTER_NOTE}>SwapUp grade</th>
                    <th className="text-right!">Quoted</th>
                    <th>Verdict</th>
                    <th className="text-right!">Accepted</th>
                    <th className="text-right!">Shortfall</th>
                    {open && isManager && p.status === "requested" ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {p.items.map((i) => {
                    const c = i.clearance;
                    const openCb = openByCase.get(i.id) ?? 0;
                    return (
                      <tr key={i.id}>
                        <td>
                          <Link href={`/cases/${i.id}`} className="font-semibold num hover:underline whitespace-nowrap">
                            {i.ref}
                          </Link>
                        </td>
                        <td className="min-w-[170px]">
                          <div className="font-medium">{i.device ?? "—"}</div>
                          {!isPartner && i.customerName ? <div className="text-[12.5px] text-muted">{i.customerName}</div> : null}
                          {i.imei ? <div className="text-[12px] text-muted num">IMEI {i.imei}</div> : null}
                          {i.dataClear === "due" ? <div className="text-[12.5px] text-warn font-semibold">Data not cleared</div> : null}
                        </td>
                        <td className="min-w-[130px]">
                          <ItemGrade g={i.grading} />
                        </td>
                        <td className="text-right">
                          <div className="flex flex-col items-end gap-1">
                            <Money value={i.tradeValue} className="font-semibold" />
                          </div>
                        </td>
                        <td className="min-w-[230px] max-w-[340px]">
                          {c ? (
                            <>
                              <StatusPill status={c.outcome} label={outcomeLabel(c.outcome)} />
                              {c.reason ? <div className="mt-1.5 text-[13.5px] text-ink-2">{c.reason}</div> : null}
                              <div className="mt-1 text-[12.5px] text-muted">
                                {c.by} · {fmtWhen(c.at)}
                              </div>
                            </>
                          ) : (
                            <StatusPill status={i.status} label={i.status === "collected" ? "Awaiting verdict" : CASE_STATUS_LABEL[i.status]} />
                          )}
                        </td>
                        <td className="text-right">{c ? <Money value={c.accepted} /> : <span className="text-muted">—</span>}</td>
                        <td className="text-right whitespace-nowrap">
                          {c ? (
                            <>
                              <Money value={c.shortfall} className={c.shortfall ? "text-bad font-semibold" : ""} />
                              {openCb ? (
                                <div className="text-[12px] text-bad">
                                  <Money value={openCb} /> open
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        {open && isManager && p.status === "requested" ? (
                          <td className="text-right">
                            <RemoveItemButton pickupId={p.id} caseId={i.id} caseRef={i.ref} />
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {p.items.some((i) => i.grading) ? <p className="hint">SwapUp grade at hand-over — it never sets the price.</p> : null}
            </div>
          )}
        </Card>

        {/* ── open shortfalls ────────────────────────────── */}
        {chargebacks.length ? (
          <Card title="Open shortfalls">
            <p className="text-[14px] text-ink-2 mb-3">Still on the credit line.</p>
            <ul className="divide-y divide-[color:var(--line)]">
              {chargebacks.map((cb) => (
                <li key={cb.caseId} className="py-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/cases/${cb.caseId}`} className="font-semibold num hover:underline whitespace-nowrap">
                      {cb.ref}
                    </Link>{" "}
                    <StatusPill status={cb.status} label={CASE_STATUS_LABEL[cb.status]} />
                    {cb.reason ? <div className="text-[13.5px] text-ink-2 mt-1">{cb.reason}</div> : null}
                  </div>
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="text-right">
                      <div className="text-[12px] text-muted">Open</div>
                      <Money value={cb.open} className="font-semibold text-bad" />
                    </div>
                    {canCloseFor(cb.status) ? (
                      <CloseShortfall
                        caseId={cb.caseId}
                        caseRef={cb.ref}
                        open={cb.open}
                        hint={isPartner ? "e.g. Phone found at our hub on re-count." : undefined}
                      />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </AppShell>
  );
}
