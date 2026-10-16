"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "@/lib/client/api";
import { Card, ErrorText, StatusPill, fmtDate } from "@/components/ui";

type Invite = { id: string; hint: string; role: string; createdAt: string; expiresAt: string; uses: number; maxUses: number; state: string };
type Created = { code: string; role: string; expiresAt: string; maxUses: number; url: string; deepLink: string };

/** The manager invites staff to sign themselves up in the SwapUp Store app with a code. */
export function InviteStaff({ storeId, storeName }: { storeId: string; storeName: string }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [created, setCreated] = useState<Created | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      setInvites((await api<{ invites: Invite[] }>(`/api/stores/${storeId}/invites`)).invites);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const c = await api<Created>(`/api/stores/${storeId}/invites`, { body: { days: 7, uses: 5 } });
      const link = c.url.startsWith("http") ? c.url : `${window.location.origin}${c.url}`;
      setCreated({ ...c, url: link });
      setQr(await QRCode.toDataURL(link, { margin: 1, width: 240 }));
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setErr(null);
    try {
      await api(`/api/stores/${storeId}/invites/${id}/revoke`, { body: {} });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <Card title="Invite staff to sign up" className="mb-5">
      <p className="hint !mt-0 mb-3 text-[14px]">
        New advisors can sign themselves up in the SwapUp Store app (Android or browser) with an invite code — they choose their own username and password.
        A code joins {storeName} only, works for 7 days and for up to 5 people.
      </p>
      {created ? (
        <div className="flex flex-wrap items-center gap-5 rounded-[12px] bg-up-bg p-4 mb-3">
          {qr ? <img src={qr} alt="Invite QR code" width={140} height={140} className="rounded-[8px] bg-white p-1" /> : null}
          <div className="min-w-0">
            <div className="section-title">Invite code</div>
            <div className="num text-[34px] font-[800] tracking-[0.18em]">{created.code}</div>
            <div className="text-[13.5px] text-ink-2 break-all">
              Or open: <a href={created.url}>{created.url}</a>
            </div>
            <div className="hint">Valid until {fmtDate(created.expiresAt)} · up to {created.maxUses} people. Shown once — copy it now.</div>
          </div>
        </div>
      ) : null}
      <button className="btn btn-primary" disabled={busy} onClick={create}>
        {busy ? "Creating…" : "Create an invite code"}
      </button>
      <ErrorText error={err} />
      {invites.length ? (
        <div className="overflow-x-auto mt-4">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Role</th>
                <th>Used</th>
                <th>Expires</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td className="num">{i.hint}</td>
                  <td>{i.role === "advisor" ? "Advisor" : "Store manager"}</td>
                  <td className="num">
                    {i.uses} / {i.maxUses}
                  </td>
                  <td>{fmtDate(i.expiresAt)}</td>
                  <td>
                    <StatusPill status={i.state === "active" ? "collected" : "cancelled"} label={i.state} />
                  </td>
                  <td className="text-right">
                    {i.state === "active" ? (
                      <button className="btn btn-sm btn-danger" onClick={() => revoke(i.id)}>
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
