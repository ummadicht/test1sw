"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Card, Empty, ErrorText } from "@/components/ui";

/** One tablet, with its times already written out by the server (IST), so the server render and the browser agree. */
export type TabletRow = { id: string; name: string; added: string; addedBy: string | null; lastSeen: string | null; lastSeenExact: string | null; removed: string | null };

/**
 * The store's counter tablets (docs/STORE-TABLET.md). A tablet stays signed in
 * for the store and advisors unlock it with a PIN, so a lost or replaced one
 * must be removable from the desk too — not only from the tablet itself.
 * Programme admins see the list but don't remove from here.
 */
export function StoreTablets({ tablets, canRemove }: { tablets: TabletRow[]; canRemove: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inUse = tablets.filter((t) => !t.removed).length;

  const remove = async (t: TabletRow) => {
    if (!window.confirm(`Remove “${t.name}”? It stops working at once.`)) return;
    setBusy(t.id);
    setError(null);
    try {
      await api(`/api/store-devices/${encodeURIComponent(t.id)}/revoke`, { body: {} });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={`Store tablets (${inUse})`} pad={false}>
      {tablets.length === 0 ? (
        <Empty title="No store tablets yet">
          {canRemove
            ? "In SwapUp Store: Settings → Use this device as the store tablet."
            : "The store manager sets it up in SwapUp Store."}
        </Empty>
      ) : (
        <div className="overflow-x-auto px-5 pb-3">
          <table className="table min-w-[560px]">
            <thead>
              <tr>
                <th>Tablet</th>
                <th>Added</th>
                <th>Last seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tablets.map((t) => (
                <tr key={t.id}>
                  <td className={t.removed ? "text-muted" : "font-semibold"}>{t.name}</td>
                  <td className="text-[13.5px]">
                    {t.added}
                    {t.addedBy ? <div className="text-[12px] text-muted">by {t.addedBy}</div> : null}
                  </td>
                  <td className="text-[13.5px] whitespace-nowrap" title={t.lastSeenExact ?? undefined}>
                    {t.lastSeen ?? <span className="text-muted">Not yet</span>}
                  </td>
                  <td className="text-right">
                    {t.removed ? (
                      <span className="pill">Removed {t.removed}</span>
                    ) : canRemove ? (
                      <button type="button" className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => void remove(t)}>
                        {busy === t.id ? "Removing…" : "Remove"}
                      </button>
                    ) : (
                      <span className="pill pill-up">Active</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ErrorText error={error} />
          <p className="hint pb-2">Advisors unlock it with a PIN. Remove lost ones.</p>
        </div>
      )}
    </Card>
  );
}
