import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "./ui";
import { NavLinks, LogoutButton } from "./ShellClient";
import { ROLE_LABEL, type SessionUser } from "@/lib/server/auth";
import { getOrg, getStore } from "@/lib/server/scope";

export type NavItem = { href: string; label: string };

export function navFor(role: SessionUser["role"]): NavItem[] {
  switch (role) {
    case "advisor":
      return [
        { href: "/desk", label: "Counter" },
        { href: "/cases", label: "Cases" },
      ];
    case "store_manager":
      return [
        { href: "/desk", label: "Counter" },
        { href: "/store", label: "Credit & pickups" },
        { href: "/cases", label: "Cases" },
        { href: "/store/team", label: "Team" },
      ];
    case "org_admin":
      return [
        { href: "/admin", label: "Overview" },
        { href: "/admin/stores", label: "Stores" },
        { href: "/admin/campaigns", label: "Upgrade bonus" },
        { href: "/admin/catalogue", label: "Catalogue" },
        { href: "/admin/claims", label: "Bonus claims" },
        { href: "/cases", label: "Cases" },
        { href: "/admin/settings", label: "Settings" },
        { href: "/admin/users", label: "Users" },
      ];
    case "partner":
      return [
        { href: "/partner", label: "Pickups" },
        { href: "/partner/rate-cards", label: "Rate cards" },
        { href: "/cases", label: "Devices" },
        { href: "/partner/team", label: "Team" },
      ];
    case "platform":
      return [
        { href: "/platform", label: "Clients & partners" },
        { href: "/admin", label: "Programme view" },
        { href: "/platform/users", label: "Users" },
      ];
  }
}

export function AppShell({ user, children, wide = false }: { user: SessionUser; children: ReactNode; wide?: boolean }) {
  const org = getOrg(user.orgId);
  const store = user.storeId ? getStore(user.storeId) : null;
  const where = store ? store.name : org?.name ?? "";
  return (
    <div className="min-h-screen flex flex-col">
      <header className="no-print sticky top-0 z-30 bg-[color:var(--surface)]/95 backdrop-blur border-b border-line">
        <div className={`mx-auto ${wide ? "max-w-[1400px]" : "max-w-[1200px]"} px-4 sm:px-6 h-16 flex items-center gap-4`}>
          <Link href="/" className="flex items-center gap-2.5 no-underline shrink-0">
            <BrandMark />
          </Link>
          <NavLinks items={navFor(user.role)} />
          <div className="ml-auto flex items-center gap-3 min-w-0">
            <div className="hidden md:block text-right leading-tight min-w-0">
              <div className="text-[13.5px] font-semibold truncate max-w-[260px]">{user.name}</div>
              <div className="text-[12px] text-muted truncate max-w-[260px]">
                {ROLE_LABEL[user.role]} · {where}
              </div>
            </div>
            <Link href="/account" className="btn btn-sm !px-2 sm:!px-3 no-underline" aria-label="Your account" title="Your account">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
                <path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="hidden sm:inline">Account</span>
            </Link>
            <LogoutButton />
          </div>
        </div>
        {store?.status === "pending" ? (
          <div className="bg-[color:var(--warn-bg)] text-[color:var(--warn)] text-[13px] font-semibold text-center py-1.5 border-t border-line px-4">
            {store.name} is waiting for approval from {org?.name}. Phone tests and quotes work; taking trade-ins starts once it is approved.
          </div>
        ) : store?.status === "rejected" ? (
          <div className="bg-[color:var(--bad-bg)] text-[color:var(--bad)] text-[13px] font-semibold text-center py-1.5 border-t border-line px-4">
            {store.name} was not approved{store.review_note ? `: ${store.review_note}` : "."}
          </div>
        ) : null}
        {org?.demo ? (
          <div className="bg-[color:var(--sample-bg)] text-[color:var(--sample)] text-[12.5px] font-semibold text-center py-1 border-t border-line">
            Demo programme — sample prices and example data. Nothing here moves real money.
          </div>
        ) : null}
      </header>
      <main className={`flex-1 w-full mx-auto ${wide ? "max-w-[1400px]" : "max-w-[1200px]"} px-4 sm:px-6 py-6`}>{children}</main>
    </div>
  );
}
