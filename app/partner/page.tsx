import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { Banner, Card, Money, Stat } from "@/components/ui";
import { PickupTable, type PickupCol } from "@/components/pickups/PickupTable";
import { requirePage } from "@/lib/server/page";
import { listPickups, type PickupView } from "@/lib/server/pickups";
import { partnerReport } from "@/lib/server/reports";
import { tradeSources } from "@/lib/server/pickups-extra";
import { getOrg, storesForUser } from "@/lib/server/scope";
import { nowIso } from "@/lib/server/db";
import { PICKUP_STATUS_LABEL, type PickupStatus } from "@/lib/domain/lifecycle";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pickups" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";

const byRequested = (a: PickupView, b: PickupView) => a.requestedAt.localeCompare(b.requestedAt);

export default async function PartnerPage({ searchParams }: { searchParams: SP }) {
  const u = await requirePage(["partner", "platform"], "/partner");
  const sp = await searchParams;
  const now = nowIso();
  const report = partnerReport(u);
  const all = listPickups(u);

  // Every client this partner serves (from the stores in scope), plus any seen on a pickup.
  const clientMap = new Map(all.map((p) => [p.orgId, p.orgName]));
  for (const s of storesForUser(u)) if (!clientMap.has(s.org_id)) clientMap.set(s.org_id, getOrg(s.org_id)?.name ?? "");
  const clients = [...clientMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const client = clients.some(([id]) => id === one(sp.client)) ? one(sp.client) : "";
  const pickups = client ? all.filter((p) => p.orgId === client) : all;
  const multiClient = clients.length > 1;

  const sources = tradeSources(pickups.flatMap((p) => p.items.map((i) => i.id)));
  const sample = pickups.filter((p) => p.items.some((i) => sources[i.id]?.kind === "sample")).map((p) => p.id);

  const of = (s: PickupStatus) => pickups.filter((p) => p.status === s);
  const requested = of("requested").sort(byRequested);
  const scheduled = of("scheduled").sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? ""));
  const collected = of("collected").sort((a, b) => (a.collectedAt ?? "").localeCompare(b.collectedAt ?? ""));
  const reconciled = of("reconciled").sort((a, b) => (a.reconciledAt ?? "").localeCompare(b.reconciledAt ?? ""));
  const settled = of("settled")
    .sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""))
    .slice(0, 10);

  const base: PickupCol[] = [...(multiClient ? (["client"] as PickupCol[]) : []), "store", "devices", "quoted"];
  const byStatus = (["requested", "scheduled", "collected", "reconciled", "settled"] as PickupStatus[])
    .map((s) => `${PICKUP_STATUS_LABEL[s]} ${report.pickups[s] ?? 0}`)
    .join(" · ");

  const section = (title: string, hint: string, list: PickupView[], cols: PickupCol[], empty: string): ReactNode => (
    <Card
      title={
        <>
          {title} <span className="num">({list.length})</span>
        </>
      }
      pad={false}
    >
      <p className="hint mt-0! px-5 pb-2">{hint}</p>
      {list.length === 0 ? (
        <p className="px-5 pb-5 text-[14px] font-semibold text-muted">{empty}</p>
      ) : (
        <div className="px-5 pb-3">
          <PickupTable pickups={list} cols={cols} now={now} sample={sample} />
        </div>
      )}
    </Card>
  );

  return (
    <AppShell user={u}>
      <div className="space-y-5">
        <div>
          <h1 className="text-[26px] sm:text-[30px] font-[750] tracking-tight">Pickups</h1>
          <p className="text-[15px] text-ink-2">
            {u.role === "partner"
              ? "Book collections, verify what you collected, and pay the stores — oldest first in every queue."
              : "Every buyback partner's pickup queue, oldest first. Partners act on these; this view is read-only."}
          </p>
        </div>

        <Card>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
            <Stat label="Owed to stores" value={<Money value={report.owed} />} tone={report.owed ? "warn" : undefined} sub="Verified, not yet settled" />
            <Stat label="Phones in transit" value={report.devicesInTransit} sub="Collected, awaiting your verdict" />
            <Stat label="Open disputes" value={report.openDisputes} tone={report.openDisputes ? "bad" : undefined} sub="Phones marked not received" />
            <Stat label="Pickups open" value={(report.pickups.requested ?? 0) + (report.pickups.scheduled ?? 0) + (report.pickups.collected ?? 0) + (report.pickups.reconciled ?? 0)} sub={byStatus} />
          </div>
          {multiClient && client ? <p className="hint mt-4!">These totals cover every client you serve; the queues below are filtered.</p> : null}
        </Card>

        {sample.length ? (
          <Banner tone="sample">
            Values marked <strong>◆ SAMPLE</strong>{" "}come from an illustrative rate card used for the demo, not your published prices.
          </Banner>
        ) : null}

        {multiClient ? (
          <nav className="flex flex-wrap gap-2" aria-label="Filter by client">
            <Link href="/partner" className={`chip no-underline ${client ? "" : "on"}`} aria-current={client ? undefined : "true"}>
              All clients
            </Link>
            {clients.map(([id, name]) => (
              <Link key={id} href={`/partner?client=${encodeURIComponent(id)}`} className={`chip no-underline ${client === id ? "on" : ""}`} aria-current={client === id ? "true" : undefined}>
                {name}
              </Link>
            ))}
          </nav>
        ) : null}

        {section("Needs scheduling", "Stores have asked for a collection. Book a slot and name the collector.", requested, [...base, "age"], "Nothing waiting to be scheduled.")}
        {section("Scheduled", "Booked collections. Record the handover on the pickup when your collector has the phones.", scheduled, [...base, "scheduled", "collector", "age"], "No collections booked.")}
        {section("Collected — verify these", "Phones at your facility. Record a verdict for each one.", collected, [...base, "verified", "age"], "Nothing waiting for inspection.")}
        {section("Verified — settle these", "Every phone has a verdict. Pay the store what you accepted and enter the payment reference.", reconciled, [...base, "accepted", "age"], "Nothing waiting to be paid.")}
        {section("Recently settled", "The last 10 pickups you paid.", settled, [...base, "accepted", "settlement"], "Nothing settled yet.")}
      </div>
    </AppShell>
  );
}
