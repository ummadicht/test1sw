"use client";

import { usePathname, useRouter } from "next/navigation";

/**
 * Platform staff switch which client programme the admin console shows.
 * Changing it keeps the page and any `keep` params (e.g. the catalogue tab).
 */
export function AdminOrgPicker({
  clients,
  current,
  keep = {},
}: {
  clients: { id: string; name: string; demo: boolean }[];
  current: string | null;
  keep?: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const path = usePathname();
  return (
    <label className="flex items-center gap-2 min-w-0">
      <span className="text-[13px] font-semibold text-ink-2 shrink-0">Client</span>
      <select
        className="select !min-h-[38px] !py-1.5 !text-[14px] min-w-0 max-w-[340px]"
        value={current ?? ""}
        onChange={(e) => {
          const p = new URLSearchParams();
          if (e.target.value) p.set("orgId", e.target.value);
          for (const [k, v] of Object.entries(keep)) if (v) p.set(k, v);
          router.push(`${path}${p.toString() ? `?${p}` : ""}`);
        }}
      >
        {current ? null : <option value="">Choose a client…</option>}
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
