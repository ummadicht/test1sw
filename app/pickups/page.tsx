import Link from "next/link";
import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { Card, Empty } from "@/components/ui";
import { PickupTable, type PickupCol } from "@/components/pickups/PickupTable";
import { requirePage } from "@/lib/server/page";
import { listPickups } from "@/lib/server/pickups";
import { tradeSources } from "@/lib/server/pickups-extra";
import { nowIso } from "@/lib/server/db";
import { PICKUP_STATUS_LABEL, type PickupStatus } from "@/lib/domain/lifecycle";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pickups" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";

const FILTERS: { key: string; label: string; statuses: PickupStatus[] }[] = [
  { key: "", label: "All", statuses: [] },
  { key: "open", label: "Not yet collected", statuses: ["requested", "scheduled"] },
  { key: "inspection", label: "With the partner", statuses: ["collected"] },
  { key: "unpaid", label: "Verified, not paid", statuses: ["reconciled"] },
  { key: "settled", label: "Settled", statuses: ["settled"] },
  { key: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
];

/** Every pickup in the caller's scope — the programme admin's way in; stores and the partner have their own pages. */
export default async function PickupsPage({ searchParams }: { searchParams: SP }) {
  const u = await requirePage(["store_manager", "partner", "org_admin", "platform"], "/pickups");
  const sp = await searchParams;
  const f = FILTERS.find((x) => x.key === one(sp.show)) ?? FILTERS[0];
  const pickups = listPickups(u, { status: f.statuses.length ? f.statuses : null });
  const sources = tradeSources(pickups.flatMap((p) => p.items.map((i) => i.id)));
  const sample = pickups.filter((p) => p.items.some((i) => sources[i.id]?.kind === "sample")).map((p) => p.id);
  const multiClient = new Set(pickups.map((p) => p.orgId)).size > 1;
  const multiStore = new Set(pickups.map((p) => p.storeId)).size > 1 || u.role !== "store_manager";
  const cols: PickupCol[] = [
    ...(multiClient ? (["client"] as PickupCol[]) : []),
    ...(multiStore ? (["store"] as PickupCol[]) : []),
    "status",
    "devices",
    "quoted",
    "accepted",
    "requested",
    "settlement",
  ];
  const home = u.role === "partner" ? { href: "/partner", label: "Pickup queue" } : u.role === "store_manager" ? { href: "/store", label: "Credit & pickups" } : null;

  return (
    <AppShell user={u}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[26px] sm:text-[30px] font-[750] tracking-tight">All pickups</h1>
            <p className="text-[15px] text-ink-2">
              {PICKUP_STATUS_LABEL.requested} → {PICKUP_STATUS_LABEL.scheduled} → {PICKUP_STATUS_LABEL.collected} → {PICKUP_STATUS_LABEL.reconciled} →{" "}
              {PICKUP_STATUS_LABEL.settled}
            </p>
          </div>
          {home ? (
            <Link href={home.href} className="btn btn-sm">
              {home.label}
            </Link>
          ) : null}
        </div>
        <nav className="flex flex-wrap gap-2" aria-label="Filter pickups">
          {FILTERS.map((x) => (
            <Link key={x.key || "all"} href={x.key ? `/pickups?show=${x.key}` : "/pickups"} className={`chip no-underline ${x === f ? "on" : ""}`} aria-current={x === f ? "true" : undefined}>
              {x.label}
            </Link>
          ))}
        </nav>
        <Card pad={false}>
          {pickups.length === 0 ? (
            <Empty title="No pickups here">{f.key ? "Try another filter." : "Pickups appear once a store manager books one."}</Empty>
          ) : (
            <div className="px-5 py-3">
              <PickupTable pickups={pickups} cols={cols} now={nowIso()} sample={sample} />
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
