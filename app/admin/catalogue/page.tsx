import Link from "next/link";
import type { ReactNode } from "react";
import { requirePage } from "@/lib/server/page";
import { orgSettings } from "@/lib/server/auth";
import { newDevices, repairBook } from "@/lib/server/catalog";
import { tradeModelsDetailed } from "@/lib/server/admin-extra";
import { AppShell } from "@/components/AppShell";
import { AdminFrame } from "@/components/admin/AdminFrame";
import { adminContext } from "@/components/admin/context";
import { withOrg } from "@/components/admin/format";
import { NewPhonesTab } from "./NewPhonesTab";
import { RepairBookTab, type RepairModel } from "./RepairBookTab";
import { TradeModelsTab } from "./TradeModelsTab";

export const dynamic = "force-dynamic";
export const metadata = { title: "Catalogue" };

type Tab = "new" | "repair" | "models";
const TABS: { id: Tab; label: string }[] = [
  { id: "new", label: "New phones" },
  { id: "repair", label: "Repair price book" },
  { id: "models", label: "Trade-in models" },
];

export default async function AdminCataloguePage({ searchParams }: { searchParams: Promise<{ orgId?: string; tab?: string; modelId?: string }> }) {
  const u = await requirePage(["org_admin", "platform"], "/admin/catalogue");
  const sp = await searchParams;
  const ctx = await adminContext(u, sp.orgId);
  const tab: Tab = sp.tab === "repair" || sp.tab === "models" ? sp.tab : "new";
  const intro = "What the counter sells, what a repair costs, and which phones it can take in trade.";
  if (!ctx.orgId) {
    return (
      <AppShell user={u} wide>
        <AdminFrame ctx={ctx} section="/admin/catalogue" title="Catalogue" intro={intro} keep={{ tab }}>
          {null}
        </AdminFrame>
      </AppShell>
    );
  }
  const orgId = ctx.orgId;
  const s = await orgSettings(orgId);

  let body: ReactNode;
  if (tab === "new") {
    body = <NewPhonesTab orgId={orgId} isPlatform={ctx.isPlatform} initial={await newDevices(orgId, true)} />;
  } else if (tab === "repair") {
    const all = await tradeModelsDetailed();
    const tm = sp.modelId ? all.find((m) => m.id === sp.modelId) ?? null : null;
    const model: RepairModel | null = tm
      ? { id: tm.id, brand: tm.brand, model: tm.model, releaseYear: tm.releaseYear, serviceTier: tm.serviceTier, carePlusFee: tm.carePlusFee }
      : null;
    const book = await repairBook(orgId);
    const counts = new Map<string, { modelId: string; label: string; count: number }>();
    for (const r of book) {
      const c = counts.get(r.modelId) ?? { modelId: r.modelId, label: r.model ? `${r.brand} ${r.model}` : r.modelId, count: 0 };
      c.count += 1;
      counts.set(r.modelId, c);
    }
    body = (
      <RepairBookTab
        key={model?.id ?? "none"}
        orgId={orgId}
        isPlatform={ctx.isPlatform}
        model={model}
        initialRows={model ? book.filter((r) => r.modelId === model.id) : []}
        bookModels={[...counts.values()]}
        labourByTier={s.repairPolicy.labourByTier}
        gstBp={s.repairPolicy.gstBp}
      />
    );
  } else {
    body = <TradeModelsTab models={await tradeModelsDetailed()} labourByTier={s.repairPolicy.labourByTier} carePlusDefault={s.repairPolicy.carePlusFeeDefault} />;
  }

  return (
    <AppShell user={u} wide>
      <AdminFrame ctx={ctx} section="/admin/catalogue" title="Catalogue" intro={intro} keep={{ tab }}>
        <nav className="flex gap-1 p-1 rounded-[12px] bg-[color:var(--surface-2)] border border-line w-fit max-w-full overflow-x-auto" aria-label="Catalogue sections">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={withOrg("/admin/catalogue", orgId, ctx.isPlatform, { tab: t.id })}
              className={`shrink-0 px-4 py-2 rounded-[9px] text-[14px] font-semibold no-underline ${
                t.id === tab ? "bg-[color:var(--surface)] shadow-sm !text-ink" : "!text-ink-2 hover:!text-ink"
              }`}
              aria-current={t.id === tab ? "page" : undefined}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        {body}
      </AdminFrame>
    </AppShell>
  );
}
