"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import type { NavItem } from "./AppShell";

export function NavLinks({ items }: { items: NavItem[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => path === href || (href !== "/" && path.startsWith(href + "/") && !items.some((i) => i.href !== href && i.href.startsWith(href) && path.startsWith(i.href)));
  return (
    <>
      <nav className="hidden lg:flex items-center gap-1 ml-4" aria-label="Main">
        {items.map((i) => (
          <Link
            key={i.href}
            href={i.href}
            className={`px-3 py-2 rounded-[9px] text-[14px] font-semibold no-underline ${isActive(i.href) ? "bg-[color:var(--ink)] text-white" : "text-ink-2 hover:bg-[color:var(--surface-2)]"}`}
            aria-current={isActive(i.href) ? "page" : undefined}
          >
            {i.label}
          </Link>
        ))}
      </nav>
      <div className="lg:hidden relative">
        <button className="btn btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Menu">
          ☰ Menu
        </button>
        {open ? (
          <div className="absolute left-0 top-11 card p-2 w-56 z-40">
            {items.map((i) => (
              <Link key={i.href} href={i.href} onClick={() => setOpen(false)} className={`block px-3 py-2.5 rounded-[9px] text-[14.5px] font-semibold no-underline ${isActive(i.href) ? "bg-[color:var(--surface-2)]" : ""}`}>
                {i.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn btn-sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/auth/logout", { method: "POST" });
        router.replace("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
