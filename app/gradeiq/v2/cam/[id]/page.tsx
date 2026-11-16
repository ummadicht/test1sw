"use client";

import { useEffect, useState, useCallback, use } from "react";

type GradePreset = "A" | "B" | "C" | "D";

type SessionSnap = {
  id: string;
  client_id: string;
  expected_model: string | null;
  cosmetic_grade: string | null;
  functional_grade: string | null;
  overall_grade: string | null;
  cosmetic: {
    score?: number;
    oem?: { verdict: string; confidence: number };
    specialists?: Array<{ angle: string; grade: string; summary: string }>;
  } | null;
  screen: {
    pattern?: string;
    shown?: string;
    cosmeticDone?: boolean;
    displayCheck?: { verdict: string; note: string } | null;
  } | null;
};

const ANGLES = [
  { id: "front", label: "Front glass", hint: "Align entire display inside frame under store light" },
  { id: "back", label: "Back cover", hint: "Flip phone to inspect rear glass and camera rings" },
  { id: "left", label: "Left rail", hint: "Hold left edge up to check buttons and frame" },
  { id: "right", label: "Right rail", hint: "Hold right edge up to check power key and corners" },
];

const SWEEP_COLOURS = [
  { id: "white", label: "White Backlight", bg: "bg-white text-slate-900 border-slate-300" },
  { id: "black", label: "Deep Black", bg: "bg-slate-950 text-white border-slate-700" },
  { id: "red", label: "Red Subpixel", bg: "bg-red-600 text-white border-red-500" },
  { id: "green", label: "Green Subpixel", bg: "bg-emerald-600 text-white border-emerald-500" },
  { id: "blue", label: "Blue Subpixel", bg: "bg-blue-600 text-white border-blue-500" },
  { id: "grid", label: "Alignment Grid", bg: "bg-indigo-950 text-indigo-100 border-indigo-500" },
];

export default function GradeiqCameraPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [snap, setSnap] = useState<SessionSnap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [capturedAngles, setCapturedAngles] = useState<string[]>([
    "front",
    "back",
    "left",
    "right",
  ]);
  const [preset, setPreset] = useState<GradePreset>("A");
  const [displayVerdict, setDisplayVerdict] = useState<"pass" | "fail">("pass");
  const [oemVerdict, setOemVerdict] = useState<"original" | "replaced">("original");
  const [sweepIndex, setSweepIndex] = useState<number>(6);
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);

  const loadSession = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/gradeiq/api/sessions/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`Session ${id} not found (${res.status})`);
      }
      const data = (await res.json()) as SessionSnap;
      setSnap(data);
      if (data.cosmetic_grade) {
        setPreset((data.cosmetic_grade as GradePreset) || "A");
        setCompleted(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  async function runColourSweep() {
    for (let i = 0; i < SWEEP_COLOURS.length; i++) {
      setSweepIndex(i);
      const col = SWEEP_COLOURS[i].id;
      await fetch(`/api/gradeiq/api/sessions/${encodeURIComponent(id)}/screen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shown: col, pattern: col, cosmeticDone: true }),
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 260));
    }
    setSweepIndex(SWEEP_COLOURS.length);
  }

  async function submitCameraGrade() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/gradeiq/api/sessions/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          preset,
          displayVerdict,
          oemVerdict,
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to save GradeIQ camera result (${res.status})`);
      }
      const updated = (await res.json()) as SessionSnap;
      setSnap(updated);
      setCompleted(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function toggleAngle(angleId: string) {
    setCapturedAngles((prev) =>
      prev.includes(angleId) ? prev.filter((a) => a !== angleId) : [...prev, angleId]
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 sm:p-6">
      <div className="max-w-2xl mx-auto space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-bold text-sm">
              GIQ
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-emerald-400 font-semibold">
                SwapUp GradeIQ · Vision v2.4
              </div>
              <h1 className="text-lg font-bold tracking-tight">
                Store Camera &amp; 6-Colour Display Inspection
              </h1>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-md bg-slate-900 border border-slate-800 text-xs font-mono text-slate-400">
            Session {id.slice(0, 8)}…
          </span>
        </header>

        {loading ? (
          <div className="rounded-xl bg-slate-900 border border-slate-800 p-6 text-sm text-slate-400">
            Connecting to SwapUp GradeIQ session…
          </div>
        ) : error ? (
          <div className="rounded-xl bg-red-950/50 border border-red-800 p-5 text-sm text-red-200 space-y-3">
            <div className="font-semibold">{error}</div>
            <button
              type="button"
              onClick={() => void loadSession()}
              className="px-3 py-1.5 rounded-lg bg-red-900 hover:bg-red-800 text-xs font-semibold"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs text-slate-400">Target Device</div>
                <div className="text-base font-bold text-white">
                  {snap?.expected_model || "Customer Trade-In Handset"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded bg-emerald-950 border border-emerald-800 text-emerald-300 text-xs font-semibold">
                  Tenant: {snap?.client_id || "swapmore-in"}
                </span>
                {snap?.overall_grade ? (
                  <span className="px-2.5 py-1 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold">
                    Grade {snap.overall_grade}
                  </span>
                ) : null}
              </div>
            </div>

            {/* Step 1: 4-Angle Exterior Capture */}
            <section className="rounded-xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300">
                  1. Exterior 4-Angle Photo Capture
                </h2>
                <span className="text-xs text-emerald-400 font-semibold">
                  {capturedAngles.length}/4 Angles Ready
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {ANGLES.map((a) => {
                  const done = capturedAngles.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleAngle(a.id)}
                      className={`p-3 rounded-lg border text-left transition ${
                        done
                          ? "bg-emerald-950/40 border-emerald-700/70 text-emerald-200"
                          : "bg-slate-950 border-slate-800 text-slate-400"
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs font-bold">
                        <span>{a.label}</span>
                        {done ? <span className="text-emerald-400">✓</span> : null}
                      </div>
                      <div className="text-[11px] opacity-75 mt-1 leading-snug">{a.hint}</div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Step 2: Cosmetic Grade & OEM Check */}
            <section className="rounded-xl bg-slate-900 border border-slate-800 p-4 space-y-4">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300">
                2. AI Vision Cosmetic Condition &amp; OEM Glass Verdict
              </h2>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {(
                  [
                    {
                      g: "A" as GradePreset,
                      title: "Grade A · Superb",
                      sub: "Flawless screen & body (96/100)",
                    },
                    {
                      g: "B" as GradePreset,
                      title: "Grade B · Good",
                      sub: "Light micro-scratches (82/100)",
                    },
                    {
                      g: "C" as GradePreset,
                      title: "Grade C · Fair",
                      sub: "Cracked glass or dent (61/100)",
                    },
                    {
                      g: "D" as GradePreset,
                      title: "Grade D · Damaged",
                      sub: "Heavy shatter / LCD bruise (34/100)",
                    },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.g}
                    type="button"
                    onClick={() => {
                      setPreset(item.g);
                      setDisplayVerdict(item.g === "C" || item.g === "D" ? "fail" : "pass");
                    }}
                    className={`p-3 rounded-lg border text-left transition ${
                      preset === item.g
                        ? "bg-emerald-600 text-white border-emerald-400 shadow"
                        : "bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700"
                    }`}
                  >
                    <div className="text-sm font-bold">{item.title}</div>
                    <div className="text-[11px] opacity-85 mt-1 leading-snug">{item.sub}</div>
                  </button>
                ))}
              </div>

              <div className="grid sm:grid-cols-2 gap-3 pt-2">
                <div>
                  <label className="block text-xs text-slate-400 mb-1.5 font-semibold">
                    OEM Display &amp; Housing Authenticity
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setOemVerdict("original")}
                      className={`flex-1 py-2 px-3 rounded-lg border text-xs font-semibold ${
                        oemVerdict === "original"
                          ? "bg-emerald-950 border-emerald-600 text-emerald-300"
                          : "bg-slate-950 border-slate-800 text-slate-400"
                      }`}
                    >
                      ✓ Genuine OEM Part
                    </button>
                    <button
                      type="button"
                      onClick={() => setOemVerdict("replaced")}
                      className={`flex-1 py-2 px-3 rounded-lg border text-xs font-semibold ${
                        oemVerdict === "replaced"
                          ? "bg-amber-950 border-amber-600 text-amber-300"
                          : "bg-slate-950 border-slate-800 text-slate-400"
                      }`}
                    >
                      ⚠ Aftermarket / Replaced
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-slate-400 mb-1.5 font-semibold">
                    6-Colour LCD Display Sweep Verdict
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setDisplayVerdict("pass")}
                      className={`flex-1 py-2 px-3 rounded-lg border text-xs font-semibold ${
                        displayVerdict === "pass"
                          ? "bg-emerald-950 border-emerald-600 text-emerald-300"
                          : "bg-slate-950 border-slate-800 text-slate-400"
                      }`}
                    >
                      ✓ Sweep Clean (Pass)
                    </button>
                    <button
                      type="button"
                      onClick={() => setDisplayVerdict("fail")}
                      className={`flex-1 py-2 px-3 rounded-lg border text-xs font-semibold ${
                        displayVerdict === "fail"
                          ? "bg-red-950 border-red-600 text-red-300"
                          : "bg-slate-950 border-slate-800 text-slate-400"
                      }`}
                    >
                      ✕ Dead Pixels / Burn-in
                    </button>
                  </div>
                </div>
              </div>
            </section>

            {/* Step 3: 6-Colour LCD Sweep */}
            <section className="rounded-xl bg-slate-900 border border-slate-800 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-300">
                  3. 6-Colour LCD Subpixel Sweep
                </h2>
                <button
                  type="button"
                  onClick={() => void runColourSweep()}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold"
                >
                  ↻ Run 6-Colour Sweep
                </button>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {SWEEP_COLOURS.map((c, idx) => (
                  <div
                    key={c.id}
                    className={`rounded-lg border px-2.5 py-2 text-center text-xs font-semibold ${c.bg} ${
                      sweepIndex === idx ? "ring-2 ring-emerald-400 scale-105" : "opacity-90"
                    }`}
                  >
                    {c.label}
                  </div>
                ))}
              </div>
            </section>

            {/* Submit Button */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <button
                type="button"
                disabled={submitting}
                onClick={() => void submitCameraGrade()}
                className="w-full sm:w-auto px-6 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm transition cursor-pointer"
              >
                {submitting
                  ? "Publishing GradeIQ Report…"
                  : `Complete Camera Grading (Grade ${preset})`}
              </button>

              {completed && snap ? (
                <div className="text-xs text-emerald-400 font-semibold">
                  ✓ Grade {snap.overall_grade || preset} saved to SwapUp GradeIQ — return to SwapUp Store or Desk.
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
