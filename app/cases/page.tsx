import Link from "next/link";
import Form from "next/form";
import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { Banner, Card, Empty } from "@/components/ui";
import { CasesListTable } from "./CasesListTable";
import { requirePage } from "@/lib/server/page";
import { listCases } from "@/lib/server/cases";
import { storesForUser } from "@/lib/server/scope";
import { tradeSources } from "@/lib/server/pickups-extra";
import { CASE_STATUS_LABEL, type CaseStatus } from "@/lib/domain/lifecycle";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cases" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";

const LIMIT = 200;

const GROUPS: { key: string; label: string; statuses: CaseStatus[] }[] = [
  { key: "all", label: "All", statuses: [] },
  { key: "counter", label: "At the counter", statuses: ["draft", "quoted"] },
  { key: "traded", label: "Traded in", statuses: ["locked", "in_pickup"] },
  { key: "partner", label: "With partner", statuses: ["collected"] },
  {
    key: "closed",
    label: "Closed",
    statuses: ["repair_chosen", "walked_away", "cancelled", "cleared", "regraded", "rejected", "not_received"],
  },
];

const isStatus = (s: string): s is CaseStatus => s in CASE_STATUS_LABEL;
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function href(q: string, statuses: string[]): string {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (statuses.length) p.set("status", statuses.join(","));
  const s = p.toString();
  return s ? `/cases?${s}` : "/cases";
}

export default async function CasesPage({ searchParams }: { searchParams: SP }) {
  const u = await requirePage(null, "/cases");
  const sp = await searchParams;
  const q = one(sp.q).trim().slice(0, 80);
  const status = one(sp.status)
    .split(",")
    .map((s) => s.trim())
    .filter(isStatus);
  const isPartner = u.role === "partner";

  const cases = listCases(u, { q: q || null, status: status.length ? status : null, limit: LIMIT });
  const showStore = storesForUser(u).length > 1;
  const sources = tradeSources(cases.map((c) => c.id));
  const samples = cases.filter((c) => sources[c.id]?.kind === "sample").map((c) => c.id);

  // A partner never sees cases before the trade-in is taken, so "At the counter" would always be empty for them.
  const groups = GROUPS.filter((g) => !(isPartner && g.key === "counter"));
  const active = groups.find((g) => sameSet(g.statuses, status));
  const filtered = !!q || status.length > 0;
  const title = isPartner ? "Devices" : "Cases";

  return (
    <AppShell user={u}>
      <div className="space-y-5">
        <div>
          <h1 className="text-[26px] sm:text-[30px] font-[750] tracking-tight">{title}</h1>
          <p className="text-[15px] text-ink-2">
            {isPartner
              ? "Every traded-in phone from the programmes you serve, newest activity first."
              : u.role === "advisor" || u.role === "store_manager"
                ? "Every customer this store has seen at the counter, newest activity first."
                : "Every case across your stores, newest activity first."}
          </p>
        </div>

        <Card pad={false}>
          <div className="px-5 pt-5 pb-4 space-y-3 border-b border-line">
            <Form action="/cases" className="flex gap-2" role="search">
              <label className="sr-only" htmlFor="cases-q">
                Search cases
              </label>
              <input
                id="cases-q"
                name="q"
                type="search"
                className="input"
                defaultValue={q}
                placeholder={isPartner ? "Case ref, IMEI or model" : "Case ref, IMEI, customer name or model"}
                autoComplete="off"
              />
              {status.length ? <input type="hidden" name="status" value={status.join(",")} /> : null}
              <button className="btn btn-primary">Search</button>
            </Form>
            <nav className="flex flex-wrap gap-2" aria-label="Filter by stage">
              {groups.map((g) => {
                const on = active?.key === g.key;
                return (
                  <Link key={g.key} href={href(q, g.statuses)} className={`chip no-underline ${on ? "on" : ""}`} aria-current={on ? "true" : undefined}>
                    {g.label}
                  </Link>
                );
              })}
              {!active && status.length ? (
                <span className="chip on" aria-current="true">
                  {status.map((s) => CASE_STATUS_LABEL[s]).join(" · ")}
                </span>
              ) : null}
            </nav>
          </div>

          {samples.length ? (
            <div className="px-5 pt-4">
              <Banner tone="sample">
                Trade-in values marked <strong>◆ SAMPLE</strong>{" "}come from an illustrative rate card, not the buyback partner&apos;s prices.
              </Banner>
            </div>
          ) : null}

          {cases.length === 0 ? (
            filtered ? (
              <Empty title="No cases match">
                Try a shorter search, or{" "}
                <Link href="/cases" className="underline">
                  clear the filters
                </Link>
                .
              </Empty>
            ) : (
              <Empty title={isPartner ? "No traded-in devices yet" : "No cases yet"}>
                {u.role === "advisor" || u.role === "store_manager" ? (
                  <>
                    Start one at the{" "}
                    <Link href="/desk" className="underline">
                      counter
                    </Link>
                    .
                  </>
                ) : isPartner ? (
                  "Phones appear here once a store takes them in on trade."
                ) : (
                  "Cases appear here as stores start using the counter."
                )}
              </Empty>
            )
          ) : (
            <div className="px-5 pb-3">
              <CasesListTable cases={cases} showStore={showStore} partnerView={isPartner} samples={samples} />
              <p className="hint pb-2">
                {cases.length >= LIMIT
                  ? `Showing the ${LIMIT} most recently updated — search to narrow it down.`
                  : `${cases.length} ${cases.length === 1 ? "case" : "cases"}${filtered ? " match" : ""}.`}
              </p>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
