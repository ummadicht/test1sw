import Link from "next/link";
import { requirePage } from "@/lib/server/page";
import { AppShell } from "@/components/AppShell";
import { Card, Money, Meter, Banner } from "@/components/ui";
import { creditSummary } from "@/lib/server/credit";
import { getStore } from "@/lib/server/scope";
import { listCases } from "@/lib/server/cases";
import { listPayoutRequests, type CounterPayoutView, type ManagerPayoutView } from "@/lib/server/payouts";
import { NewCaseForm } from "@/components/counter/NewCaseForm";
import { CaseRows } from "@/components/counter/CaseRows";
import { TestPhoneCard } from "@/components/counter/TestPhoneCard";
import { CounterPayoutStatusCard } from "@/components/counter/CounterPayoutStatusCard";
import { ManagerPayoutQueue } from "@/components/store/ManagerPayoutQueue";

export const dynamic = "force-dynamic";
export const metadata = { title: "Counter" };

const STATE_PILL: Record<string, { label: string; cls: string }> = {
  ok: { label: "Room to trade", cls: "pill-up" },
  warn: { label: "Nearly full", cls: "pill-warn" },
  full: { label: "Full", cls: "pill-bad" },
  over: { label: "Over the limit", cls: "pill-bad" },
};

export default async function DeskPage() {
  const u = await requirePage(["advisor", "store_manager"], "/desk");
  const isManager = u.role === "store_manager";
  const credit = isManager && u.storeId ? await creditSummary(u, u.storeId) : null;
  const storeInfo = !credit && u.storeId ? await getStore(u.storeId) : null;
  const payoutData = u.storeId ? await listPayoutRequests(u, { storeId: u.storeId }) : null;

  const atCounter = await listCases(u, { status: ["draft", "quoted"], limit: 30 });
  const waiting = await listCases(u, { status: ["locked", "in_pickup"], limit: 60 });
  const p = credit?.position;
  const state = p ? (STATE_PILL[p.state] ?? STATE_PILL.ok) : null;
  const atStore = waiting.filter((c) => c.status === "locked").length;
  const inPickup = waiting.filter((c) => c.status === "in_pickup").length;

  const storeName = credit?.store.name ?? storeInfo?.name ?? "Your store";
  const storeCity = credit?.store.city ?? storeInfo?.city ?? null;

  return (
    <AppShell user={u}>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <div className="section-title">Counter</div>
          <h1 className="text-[26px] font-[760] tracking-tight leading-tight">{storeName}</h1>
          {storeCity ? <div className="text-muted text-[14px]">{storeCity}</div> : null}
        </div>
      </div>

      {/* Store Manager in-app payout approval queue on the counter desk */}
      {isManager && u.storeId && payoutData ? (
        <div className="mb-5">
          <ManagerPayoutQueue
            storeId={u.storeId}
            initialPayouts={payoutData.payouts as ManagerPayoutView[]}
            initialBalance={payoutData.storeBalance?.availableBalance ?? p?.available ?? 0}
            initialLedger={payoutData.ledger}
            showLedger={false}
          />
        </div>
      ) : null}

      <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
        <Card title="New case">
          <p className="text-[14.5px] text-ink-2 mb-4 leading-relaxed">Repair quote vs trade-in, side by side.</p>
          <NewCaseForm />
        </Card>

        <div className="space-y-5 min-w-0">
          {isManager ? (
            credit && p ? (
              <Card title="Trade-in credit" action={state ? <span className={`pill ${state.cls}`}>{state.label}</span> : null}>
                <div className="text-[13px] text-muted">Available now</div>
                <div className={`kpi mt-0.5 ${p.available <= 0 ? "text-bad" : ""}`}>
                  <Money value={p.available} />
                </div>
                <div className="mt-3">
                  <Meter value={p.utilisation} state={p.state} />
                </div>
                <div className="flex flex-wrap justify-between gap-2 mt-2 text-[13px] text-ink-2">
                  <span>
                    <Money value={p.exposure} /> of <Money value={p.limit} /> used
                  </span>
                  <span>
                    {credit.held.length} phone{credit.held.length === 1 ? "" : "s"} held
                    {inPickup ? ` · ${inPickup} on a pickup` : ""}
                  </span>
                </div>
                {p.chargebacksOpen > 0 ? (
                  <div className="hint">
                    Includes <Money value={p.chargebacksOpen} /> open chargebacks.
                  </div>
                ) : null}
                {credit.advice.due ? (
                  <div className="mt-3">
                    <Banner tone="warn">
                      <div className="font-semibold">Time to book a pickup</div>
                      <ul className="list-disc pl-4 mt-1 space-y-0.5">
                        {credit.advice.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                      <Link href="/store" className="inline-block mt-2 font-semibold">
                        Book a pickup →
                      </Link>
                    </Banner>
                  </div>
                ) : null}
              </Card>
            ) : (
              <Card title="Trade-in credit">
                <Banner tone="warn">No store on this account.</Banner>
              </Card>
            )
          ) : (
            <CounterPayoutStatusCard payouts={(payoutData?.payouts ?? []) as CounterPayoutView[]} />
          )}
          <TestPhoneCard />
        </div>
      </div>

      <div className="grid gap-5 mt-5 grid-cols-1 xl:grid-cols-2 items-start">
        <Card title={`At the counter · ${atCounter.length}`} pad={false} className="min-w-0">
          <CaseRows
            cases={atCounter}
            mode="counter"
            empty="No open cases"
            emptyHint="New cases show here."
          />
        </Card>
        <Card title={`Waiting for pickup · ${waiting.length}`} pad={false} className="min-w-0" action={atStore ? <span className="hint !mt-0">{atStore} at the store</span> : null}>
          <CaseRows
            cases={waiting}
            mode="held"
            empty="Nothing waiting"
            emptyHint="Traded-in phones wait here."
          />
        </Card>
      </div>
    </AppShell>
  );
}
