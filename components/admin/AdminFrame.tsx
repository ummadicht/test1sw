import Link from "next/link";
import type { ReactNode } from "react";
import { AdminOrgPicker } from "@/app/admin/AdminOrgPicker";
import { Banner, Card } from "@/components/ui";
import { ADMIN_SECTIONS, withOrg } from "./format";
import type { AdminCtx } from "./context";

/**
 * Page frame for every /admin page: the programme name, a title, and — for
 * SwapUp platform staff — a client switcher plus section tabs that carry
 * ?orgId= (platform's main nav only links to the overview).
 */
export function AdminFrame({
  ctx,
  section,
  title,
  intro,
  actions,
  keep,
  children,
}: {
  ctx: AdminCtx;
  section: string;
  title: string;
  intro?: ReactNode;
  actions?: ReactNode;
  keep?: Record<string, string | undefined>;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      {ctx.isPlatform ? (
        <div className="card px-4 py-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[13px] text-muted">
              <span className="pill">SwapUp platform view</span>
              <span className="ml-2 hidden sm:inline">You are looking at a client&apos;s programme console.</span>
            </div>
            <AdminOrgPicker clients={ctx.clients} current={ctx.orgId} keep={keep} />
          </div>
          {ctx.orgId ? (
            <nav className="flex gap-1 overflow-x-auto -mx-1 px-1" aria-label="Programme sections">
              {ADMIN_SECTIONS.map((s) => (
                <Link
                  key={s.href}
                  href={withOrg(s.href, ctx.orgId, true)}
                  className={`shrink-0 px-3 py-1.5 rounded-[9px] text-[13.5px] font-semibold no-underline ${
                    s.href === section ? "bg-[color:var(--ink)] !text-white" : "!text-ink-2 hover:bg-[color:var(--surface-2)]"
                  }`}
                  aria-current={s.href === section ? "page" : undefined}
                >
                  {s.label}
                </Link>
              ))}
            </nav>
          ) : null}
        </div>
      ) : null}

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {ctx.orgName ? <div className="section-title">{ctx.orgName}</div> : null}
          <h1 className="text-[26px] sm:text-[28px] font-[750] tracking-tight leading-tight mt-1">{title}</h1>
          {intro ? <p className="text-ink-2 mt-1.5 max-w-[72ch] text-[15px] leading-relaxed">{intro}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>

      {ctx.orgId ? children : <ChooseClient ctx={ctx} section={section} keep={keep} />}
    </div>
  );
}

/** Platform staff without ?orgId= — pick the client whose programme to open. */
function ChooseClient({ ctx, section, keep }: { ctx: AdminCtx; section: string; keep?: Record<string, string | undefined> }) {
  return (
    <div className="space-y-4">
      {ctx.badOrg ? <Banner tone="warn">Client not found — choose one.</Banner> : null}
      <Card title="Choose a client programme">
        {ctx.clients.length ? (
          <ul className="grid sm:grid-cols-2 gap-3">
            {ctx.clients.map((c) => (
              <li key={c.id}>
                <Link
                  href={withOrg(section, c.id, true, keep)}
                  className="block rounded-[12px] border border-line px-4 py-3.5 no-underline hover:bg-[color:var(--surface-2)]"
                >
                  <div className="font-semibold">{c.name}</div>
                  <div className="hint">{c.demo ? "Test programme — no real money" : "Live programme"}</div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-2">No client programmes yet.</p>
        )}
      </Card>
    </div>
  );
}
