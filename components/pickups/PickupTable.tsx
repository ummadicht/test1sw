import Link from "next/link";
import type { ReactNode } from "react";
import { Money, StatusPill, SourceBadge } from "@/components/ui";
import { PICKUP_STATUS_LABEL } from "@/lib/domain/lifecycle";
import type { PickupView } from "@/lib/server/pickups";
import { ageLabel, fmtWhen } from "./format";

export type PickupCol =
  | "client"
  | "store"
  | "status"
  | "devices"
  | "quoted"
  | "accepted"
  | "verified"
  | "requested"
  | "age"
  | "scheduled"
  | "collector"
  | "settlement";

const HEAD: Record<PickupCol, string> = {
  client: "Client",
  store: "Store",
  status: "Status",
  devices: "Phones",
  quoted: "Quoted",
  accepted: "Accepted",
  verified: "Verified",
  requested: "Requested",
  age: "Waiting",
  scheduled: "Collection slot",
  collector: "Collector",
  settlement: "Settlement",
};

const RIGHT: PickupCol[] = ["devices", "quoted", "accepted"];

/** A cancelled pickup hands its phones back, so it has nothing left to count. */
const gone = (p: PickupView) => p.status === "cancelled" && p.totals.devices === 0;

/**
 * A list of pickups. Plain (server-renderable) — the columns are chosen by the
 * page so the store, the partner queue and the admin list each show what they
 * act on. `sample` lists pickups whose values come from a SAMPLE rate card.
 */
export function PickupTable({
  pickups,
  cols,
  now,
  sample = [],
}: {
  pickups: PickupView[];
  cols: PickupCol[];
  now: string;
  sample?: string[];
}) {
  const sampleSet = new Set(sample);
  const cell = (p: PickupView, c: PickupCol): ReactNode => {
    switch (c) {
      case "client":
        return p.orgName;
      case "store":
        return (
          <>
            <div className="font-semibold">{p.storeName}</div>
            {p.storeCity ? <div className="hint mt-0!">{p.storeCity}</div> : null}
          </>
        );
      case "status":
        return <StatusPill status={p.status} label={PICKUP_STATUS_LABEL[p.status]} />;
      case "devices":
        return gone(p) ? <span className="text-muted">—</span> : <span className="num">{p.totals.devices}</span>;
      case "quoted":
        return gone(p) ? (
          <span className="text-muted">—</span>
        ) : (
          <div className="flex flex-col items-end gap-1">
            <Money value={p.totals.quoted} className="font-semibold" />
            {sampleSet.has(p.id) ? <SourceBadge kind="sample" /> : null}
          </div>
        );
      case "accepted":
        return p.totals.verified ? <Money value={p.totals.accepted} /> : <span className="text-muted">—</span>;
      case "verified":
        return (
          <span className="num">
            {p.totals.verified} of {p.totals.devices}
          </span>
        );
      case "requested":
        return (
          <span className="whitespace-nowrap" title={p.requestedBy ? `by ${p.requestedBy}` : undefined}>
            {fmtWhen(p.requestedAt)}
          </span>
        );
      case "age":
        return (
          <span title={`Requested ${fmtWhen(p.requestedAt)}`} className="whitespace-nowrap">
            {ageLabel(p.requestedAt, now)}
          </span>
        );
      case "scheduled":
        return p.scheduledFor ? <span className="whitespace-nowrap">{fmtWhen(p.scheduledFor)}</span> : <span className="text-muted">Not booked</span>;
      case "collector":
        return p.collectorName ?? <span className="text-muted">—</span>;
      case "settlement":
        return p.settlementRef ? (
          <>
            <Money value={p.settlementAmount} />
            <div className="hint mt-0! num">{p.settlementRef}</div>
          </>
        ) : (
          <span className="text-muted">—</span>
        );
    }
  };
  return (
    <div className="overflow-x-auto -mx-5 px-5">
      <table className="table min-w-[560px]">
        <thead>
          <tr>
            <th>Pickup</th>
            {cols.map((c) => (
              <th key={c} className={RIGHT.includes(c) ? "text-right!" : undefined}>
                {HEAD[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pickups.map((p) => (
            <tr key={p.id}>
              <td>
                <Link href={`/pickups/${p.id}`} className="font-semibold num underline-offset-2 hover:underline whitespace-nowrap">
                  {p.ref}
                </Link>
              </td>
              {cols.map((c) => (
                <td key={c} className={RIGHT.includes(c) ? "text-right" : undefined}>
                  {cell(p, c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
