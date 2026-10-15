import { AppShell } from "@/components/AppShell";
import { Card } from "@/components/ui";
import { PasswordForm } from "@/components/platform/PasswordForm";
import { requirePage } from "@/lib/server/page";
import { ROLE_LABEL, homeFor } from "@/lib/server/auth";
import { getOrg, getStore } from "@/lib/server/scope";
import Link from "next/link";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account" };

const ORG_KIND: Record<string, string> = { platform: "Platform staff", client: "Client programme", partner: "Buyback partner" };

export default async function AccountPage() {
  const u = await requirePage(null, "/account");
  const org = getOrg(u.orgId);
  const store = u.storeId ? getStore(u.storeId) : null;
  const rows: { label: string; value: ReactNode }[] = [
    { label: "Name", value: u.name },
    { label: "Username", value: <span className="num">{u.username}</span> },
    { label: "Role", value: ROLE_LABEL[u.role] },
    {
      label: "Organisation",
      value: org ? (
        <>
          {org.name} <span className="hint !mt-0 inline">· {ORG_KIND[org.kind] ?? org.kind}</span>
        </>
      ) : (
        "—"
      ),
    },
  ];
  if (store) rows.push({ label: "Store", value: `${store.name}${store.city ? `, ${store.city}` : ""} (${store.code})` });

  return (
    <AppShell user={u}>
      <div className="max-w-3xl">
        <h1 className="text-[26px] font-[750] tracking-tight">Your account</h1>
        <p className="hint !mt-1 mb-5">
          <Link href={homeFor(u.role)}>← Back to work</Link>
        </p>
        <div className="grid gap-5">
          <Card title="Who you are signed in as">
            <dl className="grid sm:grid-cols-[160px_1fr] gap-x-6 gap-y-1 sm:gap-y-3 text-[15px]">
              {rows.map((r) => (
                <div key={r.label} className="contents">
                  <dt className="text-muted font-semibold text-[13.5px] sm:pt-0.5">{r.label}</dt>
                  <dd className="m-0 pb-2 sm:pb-0 font-medium min-w-0 break-words">{r.value}</dd>
                </div>
              ))}
            </dl>
            <p className="hint mt-4">
              Your name, role and store are set by whoever manages your team. Ask them if something here is wrong.
            </p>
          </Card>
          <Card title="Change password">
            <PasswordForm />
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
