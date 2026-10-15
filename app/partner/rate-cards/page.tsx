import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { RateCards, type ActiveCardInfo } from "@/components/platform/RateCards";
import { requirePage } from "@/lib/server/page";
import { listOrgs } from "@/lib/server/admin";
import { rateCards, rateCardDetail } from "@/lib/server/catalog";
import { partnerMode } from "@/lib/server/buyback";
import { SAMPLE_DEDUCTIONS } from "@/lib/server/seed";

export const dynamic = "force-dynamic";
export const metadata = { title: "Rate cards" };

const DEFAULT_PARTNER = "ptn_cashify";

/**
 * The buyback partner's price sheets. A partner manages its own; SwapUp
 * platform staff pick the partner (?partnerId=, Cashify by default).
 */
export default async function RateCardsPage({ searchParams }: { searchParams: Promise<{ partnerId?: string }> }) {
  const u = await requirePage(["partner", "platform"], "/partner/rate-cards");
  const sp = await searchParams;

  let partnerId = u.orgId;
  let partners: { id: string; name: string }[] = [];
  if (u.role === "platform") {
    partners = listOrgs(u)
      .filter((o) => o.kind === "partner")
      .map((o) => ({ id: o.id, name: o.name }));
    const want = sp.partnerId ?? DEFAULT_PARTNER;
    const hit = partners.find((p) => p.id === want) ?? partners[0];
    if (!hit) {
      return (
        <AppShell user={u}>
          <h1 className="text-[26px] font-[750] tracking-tight">Rate cards</h1>
          <p className="hint mt-2">
            There are no buyback partners yet. <Link href="/platform">Add one on Clients &amp; partners.</Link>
          </p>
        </AppShell>
      );
    }
    partnerId = hit.id;
  }

  const mode = partnerMode(partnerId);
  const cards = rateCards(partnerId);
  const activeSummary = cards.find((c) => c.active) ?? null;
  let active: ActiveCardInfo | null = null;
  if (activeSummary) {
    const card = rateCardDetail(partnerId, activeSummary.id);
    active = {
      id: card.id,
      label: card.source.label,
      kind: card.source.kind,
      note: card.source.note ?? null,
      effectiveFrom: card.source.effectiveFrom,
      quoteValidityDays: card.quoteValidityDays,
      entries: card.entries.length,
      roundTo: card.roundTo,
      maxDeductionBp: card.maxDeductionBp,
      floorBp: card.floorBp,
      deductions: card.deductions,
      createdAt: activeSummary.createdAt,
    };
  }

  return (
    <AppShell user={u}>
      {u.role === "platform" ? (
        <div className="card px-4 py-3 mb-5 flex flex-wrap items-center gap-3">
          <span className="pill">SwapUp platform view</span>
          {partners.length > 1 ? (
            <nav className="flex flex-wrap gap-2" aria-label="Choose partner">
              {partners.map((p) => (
                <Link
                  key={p.id}
                  href={`/partner/rate-cards?partnerId=${encodeURIComponent(p.id)}`}
                  className={`chip no-underline !min-h-[36px] ${p.id === partnerId ? "on" : ""}`}
                  aria-current={p.id === partnerId ? "page" : undefined}
                >
                  {p.name}
                </Link>
              ))}
            </nav>
          ) : (
            <span className="text-[13.5px] text-ink-2">You are managing this partner&apos;s rate cards on its behalf.</span>
          )}
        </div>
      ) : null}
      <RateCards
        partnerId={u.role === "platform" ? partnerId : null}
        partnerName={mode.partnerName}
        mode={mode}
        cards={cards}
        active={active}
        sampleDeductions={SAMPLE_DEDUCTIONS}
      />
    </AppShell>
  );
}
