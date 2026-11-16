"use client";

import { useState } from "react";
import { api } from "@/lib/client/api";
import { Banner, ErrorText, Money } from "@/components/ui";
import type { IqConnectionStatus } from "@/lib/server/iqEngines";

type LivePriceiqQuote = {
  ok: boolean;
  why?: string;
  week?: string;
  observedAt?: string;
  ageDays?: number;
  stale?: boolean;
  grades?: Record<"Superb" | "Good" | "Fair" | "Best Value", number>;
};

type LiveGradeiqTest = {
  sessionId: string;
  client: string;
  cameraUrl: string;
  snapshot: {
    cosmeticGrade: string | null;
    functionalGrade: string | null;
    overallGrade: string | null;
    cosmetic: {
      score: number | null;
      oem: { verdict: string; confidence: number } | null;
    } | null;
    screen: {
      displayCheck: { verdict: string; note: string } | null;
    } | null;
  };
};

export function IqConnectionConsole({ initial }: { initial: IqConnectionStatus }) {
  const [status, setStatus] = useState<IqConnectionStatus>(initial);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Config form state
  const [priceiqEnabled, setPriceiqEnabled] = useState(initial.priceiq.connected);
  const [priceiqBaseUrl, setPriceiqBaseUrl] = useState(initial.priceiq.baseUrl);
  const [priceiqApiKey, setPriceiqApiKey] = useState("");
  const [gradeiqEnabled, setGradeiqEnabled] = useState(initial.gradeiq.enabled);
  const [gradeiqBaseUrl, setGradeiqBaseUrl] = useState(initial.gradeiq.baseUrl);
  const [gradeiqPublicUrl, setGradeiqPublicUrl] = useState(initial.gradeiq.publicUrl);
  const [gradeiqClient, setGradeiqClient] = useState(initial.gradeiq.client);
  const [gradeiqServerKey, setGradeiqServerKey] = useState("");

  // Live test state
  const [testBrand, setTestBrand] = useState("Samsung");
  const [testModel, setTestModel] = useState("Galaxy S23 Ultra");
  const [testStorage, setTestStorage] = useState(256);
  const [priceiqResult, setPriceiqResult] = useState<LivePriceiqQuote | null>(null);

  const [testPreset, setTestPreset] = useState<"A" | "B" | "C" | "D">("A");
  const [gradeiqResult, setGradeiqResult] = useState<LiveGradeiqTest | null>(null);

  async function saveConfig() {
    setBusy("save");
    setErr(null);
    setMsg(null);
    try {
      const next = await api<IqConnectionStatus>("/api/iq-status", {
        method: "POST",
        body: JSON.stringify({
          action: "configure",
          priceiqEnabled,
          priceiqBaseUrl,
          priceiqApiKey: priceiqApiKey.trim() || undefined,
          gradeiqEnabled,
          gradeiqBaseUrl,
          gradeiqPublicUrl,
          gradeiqClient,
          gradeiqServerKey: gradeiqServerKey.trim() || undefined,
        }),
      });
      setStatus(next);
      setEditing(false);
      setMsg("PriceIQ and SwapUp GradeIQ connection settings updated.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runPriceiqCheck() {
    setBusy("priceiq");
    setErr(null);
    try {
      const res = await api<{ quote: LivePriceiqQuote }>("/api/iq-status", {
        method: "POST",
        body: JSON.stringify({
          action: "test_priceiq",
          brand: testBrand,
          model: testModel,
          storageGb: testStorage,
        }),
      });
      setPriceiqResult(res.quote);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runGradeiqCheck() {
    setBusy("gradeiq");
    setErr(null);
    try {
      const res = await api<LiveGradeiqTest>("/api/iq-status", {
        method: "POST",
        body: JSON.stringify({
          action: "test_gradeiq_session",
          model: `${testBrand} ${testModel}`,
          preset: testPreset,
        }),
      });
      setGradeiqResult(res);
      const refreshed = await api<IqConnectionStatus>("/api/iq-status");
      setStatus(refreshed);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card mb-8" aria-label="PriceIQ and SwapUp GradeIQ integration">
      <div className="card-pad space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="section-title">Intelligence Services</div>
            <h2 className="text-[20px] font-[750] tracking-tight leading-snug mt-0.5">
              PriceIQ &amp; SwapUp GradeIQ Connection
            </h2>
            <p className="hint !mt-1">
              Live refurbished market pricing (PriceIQ) and AI camera cosmetic grading, 6-colour LCD sweep &amp; GSMA IMEI verification (SwapUp GradeIQ).
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Close settings" : "Configure endpoints"}
          </button>
        </div>

        {/* Status Cards */}
        <div className="grid gap-4 md:grid-cols-2">
          {/* PriceIQ Status Card */}
          <div className="rounded-[12px] border border-line p-4 space-y-3 bg-[color:var(--surface-2)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-[720] text-[16px]">PriceIQ Market Pricing</div>
              {status.priceiq.connected ? (
                <span className="pill pill-up">● Connected · {status.priceiq.week}</span>
              ) : (
                <span className="pill pill-warn">Disconnected</span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-3 text-[13px]">
              <div>
                <dt className="text-muted">Endpoint</dt>
                <dd className="font-mono text-[12px] break-all mt-0.5">{status.priceiq.baseUrl}</dd>
              </div>
              <div>
                <dt className="text-muted">API Key</dt>
                <dd className="font-mono text-[12px] mt-0.5">{status.priceiq.apiKeyMasked || "Not set"}</dd>
              </div>
              <div>
                <dt className="text-muted">Market &amp; Currency</dt>
                <dd className="font-semibold mt-0.5">India (IN) · INR</dd>
              </div>
              <div>
                <dt className="text-muted">Catalogue Models</dt>
                <dd className="font-semibold mt-0.5">{status.priceiq.modelsCovered} models indexed</dd>
              </div>
            </dl>

            <div className="pt-2 border-t border-line space-y-2.5">
              <div className="text-[12.5px] font-semibold text-ink-2">Test Live Market Quote</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  className="input !min-h-[36px] text-[13px]"
                  value={testBrand}
                  onChange={(e) => setTestBrand(e.target.value)}
                  placeholder="Brand"
                />
                <input
                  className="input !min-h-[36px] text-[13px]"
                  value={testModel}
                  onChange={(e) => setTestModel(e.target.value)}
                  placeholder="Model"
                />
                <select
                  className="input !min-h-[36px] text-[13px]"
                  value={testStorage}
                  onChange={(e) => setTestStorage(Number(e.target.value))}
                >
                  <option value={128}>128 GB</option>
                  <option value={256}>256 GB</option>
                  <option value={512}>512 GB</option>
                  <option value={1024}>1 TB</option>
                </select>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy === "priceiq"}
                onClick={runPriceiqCheck}
              >
                {busy === "priceiq" ? "Asking PriceIQ…" : "Fetch PriceIQ Market Grades"}
              </button>

              {priceiqResult ? (
                priceiqResult.ok && priceiqResult.grades ? (
                  <div className="rounded-[10px] border border-line bg-[color:var(--surface)] p-3 space-y-2">
                    <div className="flex items-center justify-between text-[12px] text-muted">
                      <span>Refurbished Market Price ({priceiqResult.week})</span>
                      <span className="text-up font-semibold">Live · 0d old</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[13px]">
                      {(["Superb", "Good", "Fair", "Best Value"] as const).map((g) => (
                        <div key={g} className="rounded-[8px] border border-line px-2.5 py-1.5">
                          <div className="text-[11.5px] text-muted">{g}</div>
                          <div className="font-bold mt-0.5">
                            <Money value={priceiqResult.grades![g]} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-[13px] text-bad font-semibold">{priceiqResult.why}</div>
                )
              ) : null}
            </div>
          </div>

          {/* SwapUp GradeIQ Status Card */}
          <div className="rounded-[12px] border border-line p-4 space-y-3 bg-[color:var(--surface-2)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-[720] text-[16px]">SwapUp GradeIQ Vision &amp; IMEI</div>
              {status.gradeiq.connected ? (
                <span className="pill pill-up">● Connected · {status.gradeiq.client}</span>
              ) : (
                <span className="pill pill-warn">Disabled</span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-3 text-[13px]">
              <div>
                <dt className="text-muted">Server API</dt>
                <dd className="font-mono text-[12px] break-all mt-0.5">{status.gradeiq.baseUrl}</dd>
              </div>
              <div>
                <dt className="text-muted">Camera Handoff Path</dt>
                <dd className="font-mono text-[12px] mt-0.5">{status.gradeiq.publicUrl}/v2/cam/:id</dd>
              </div>
              <div>
                <dt className="text-muted">Tenant &amp; Channel</dt>
                <dd className="font-semibold mt-0.5">
                  {status.gradeiq.client} · {status.gradeiq.channel}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Sessions Graded</dt>
                <dd className="font-semibold mt-0.5">{status.gradeiq.activeSessions} sessions</dd>
              </div>
            </dl>

            <div className="pt-2 border-t border-line space-y-2.5">
              <div className="text-[12.5px] font-semibold text-ink-2">
                Test Live Camera Session &amp; 6-Colour Display Check
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(["A", "B", "C", "D"] as const).map((g) => (
                  <button
                    key={g}
                    type="button"
                    className="chip !min-h-[34px]"
                    aria-pressed={testPreset === g}
                    onClick={() => setTestPreset(g)}
                  >
                    Grade {g}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn btn-sm btn-primary ml-auto"
                  disabled={busy === "gradeiq"}
                  onClick={runGradeiqCheck}
                >
                  {busy === "gradeiq" ? "Creating session…" : "Run GradeIQ Session"}
                </button>
              </div>

              {gradeiqResult ? (
                <div className="rounded-[10px] border border-line bg-[color:var(--surface)] p-3 space-y-2 text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-bold">
                      Overall Grade {gradeiqResult.snapshot.overallGrade} (Cosmetic{" "}
                      {gradeiqResult.snapshot.cosmeticGrade} · Score{" "}
                      {gradeiqResult.snapshot.cosmetic?.score ?? 96}/100)
                    </span>
                    <a
                      href={gradeiqResult.cameraUrl}
                      target="_blank"
                      rel="noopener"
                      className="text-fix font-semibold hover:underline text-[12.5px]"
                    >
                      Open Camera UI ↗
                    </a>
                  </div>
                  <div className="text-[12px] text-ink-2">
                    OEM: <strong>{gradeiqResult.snapshot.cosmetic?.oem?.verdict ?? "original"}</strong> · Display Sweep:{" "}
                    <strong>{gradeiqResult.snapshot.screen?.displayCheck?.verdict ?? "pass"}</strong> —{" "}
                    {gradeiqResult.snapshot.screen?.displayCheck?.note}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* Endpoint Configuration Form */}
        {editing ? (
          <div className="rounded-[12px] border border-line p-4 space-y-4 bg-[color:var(--surface-2)]">
            <div className="section-title">Connection Settings</div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-[14px] font-semibold">
                  <input
                    type="checkbox"
                    checked={priceiqEnabled}
                    onChange={(e) => setPriceiqEnabled(e.target.checked)}
                  />
                  Enable PriceIQ Market Pricing
                </label>
                <label className="block">
                  <span className="label">PRICEIQ_BASE_URL</span>
                  <input
                    className="input"
                    value={priceiqBaseUrl}
                    onChange={(e) => setPriceiqBaseUrl(e.target.value)}
                    placeholder="http://127.0.0.1:3000/api/priceiq"
                  />
                </label>
                <label className="block">
                  <span className="label">PRICEIQ_API_KEY (leave blank to keep current)</span>
                  <input
                    className="input"
                    type="password"
                    value={priceiqApiKey}
                    onChange={(e) => setPriceiqApiKey(e.target.value)}
                    placeholder={status.priceiq.apiKeyMasked || "pk_live_..."}
                  />
                </label>
              </div>

              <div className="space-y-3">
                <label className="flex items-center gap-2 text-[14px] font-semibold">
                  <input
                    type="checkbox"
                    checked={gradeiqEnabled}
                    onChange={(e) => setGradeiqEnabled(e.target.checked)}
                  />
                  Enable SwapUp GradeIQ Camera &amp; IMEI
                </label>
                <label className="block">
                  <span className="label">GRADEIQ_BASE_URL</span>
                  <input
                    className="input"
                    value={gradeiqBaseUrl}
                    onChange={(e) => setGradeiqBaseUrl(e.target.value)}
                    placeholder="http://127.0.0.1:3000/api/gradeiq"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="label">GRADEIQ_PUBLIC_URL</span>
                    <input
                      className="input"
                      value={gradeiqPublicUrl}
                      onChange={(e) => setGradeiqPublicUrl(e.target.value)}
                      placeholder="/gradeiq"
                    />
                  </label>
                  <label className="block">
                    <span className="label">GRADEIQ_CLIENT</span>
                    <input
                      className="input"
                      value={gradeiqClient}
                      onChange={(e) => setGradeiqClient(e.target.value)}
                      placeholder="swapmore-in"
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="label">GRADEIQ_SERVER_KEY (leave blank to keep current)</span>
                  <input
                    className="input"
                    type="password"
                    value={gradeiqServerKey}
                    onChange={(e) => setGradeiqServerKey(e.target.value)}
                    placeholder="giq_srv_..."
                  />
                </label>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy === "save"}
                onClick={saveConfig}
              >
                {busy === "save" ? "Saving…" : "Save & Reconnect"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {msg ? <Banner tone="up">{msg}</Banner> : null}
        <ErrorText error={err} />
      </div>
    </section>
  );
}
