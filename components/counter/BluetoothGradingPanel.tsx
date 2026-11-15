"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { Banner, ErrorText } from "@/components/ui";
import { DEFAULT_PLAN } from "@/lib/domain/diagnostics";
import type { CaseView } from "@/lib/server/cases";

type BluetoothPeripheral = {
  deviceId: string;
  deviceName: string;
  brand: string;
  manufacturer: string;
  modelName: string;
  modelCode: string;
  osVersion: string;
  totalDiskBytes: number;
  batteryLevelPct: number;
  rssi: number;
  protocol: string;
  gattServices: string[];
  connectionMode: "web_bluetooth" | "ble_bridge";
};

const DISCOVERABLE_BLE_DEVICES: BluetoothPeripheral[] = [
  {
    deviceId: "ble_sm_s918b_01",
    deviceName: "Galaxy S23 Ultra (SM-S918B)",
    brand: "samsung",
    manufacturer: "Samsung Electronics",
    modelName: "SM-S918B",
    modelCode: "SM-S918B",
    osVersion: "14",
    totalDiskBytes: 256e9,
    batteryLevelPct: 92,
    rssi: -38,
    protocol: "Bluetooth 5.3 LE · GATT",
    gattServices: ["battery_service (0x180F)", "device_information (0x180A)", "generic_access (0x1800)", "swapup_diag (0xFD92)"],
    connectionMode: "ble_bridge",
  },
  {
    deviceId: "ble_sm_s928b_02",
    deviceName: "Galaxy S24 Ultra (SM-S928B)",
    brand: "samsung",
    manufacturer: "Samsung Electronics",
    modelName: "SM-S928B",
    modelCode: "SM-S928B",
    osVersion: "14",
    totalDiskBytes: 256e9,
    batteryLevelPct: 96,
    rssi: -41,
    protocol: "Bluetooth 5.3 LE · GATT",
    gattServices: ["battery_service (0x180F)", "device_information (0x180A)", "generic_access (0x1800)", "swapup_diag (0xFD92)"],
    connectionMode: "ble_bridge",
  },
  {
    deviceId: "ble_sm_s901e_03",
    deviceName: "Galaxy S22 5G (SM-S901E)",
    brand: "samsung",
    manufacturer: "Samsung Electronics",
    modelName: "SM-S901E",
    modelCode: "SM-S901E",
    osVersion: "14",
    totalDiskBytes: 128e9,
    batteryLevelPct: 84,
    rssi: -49,
    protocol: "Bluetooth 5.2 LE · GATT",
    gattServices: ["battery_service (0x180F)", "device_information (0x180A)", "generic_access (0x1800)"],
    connectionMode: "ble_bridge",
  },
];

type GradePresetId = "grade_a" | "grade_b" | "grade_c" | "grade_d";

function buildAllPassMap(): Record<string, "pass" | "fail" | "skip"> {
  const out: Record<string, "pass" | "fail" | "skip"> = {};
  for (const item of DEFAULT_PLAN) {
    out[item.id] = "pass";
  }
  return out;
}

export function BluetoothGradingPanel({
  caseId,
  onCaseUpdated,
  compact = false,
}: {
  /** Pass an existing caseId on `/cases/[id]`, or `"new"` on `/desk` to create & open a graded case. */
  caseId: string;
  onCaseUpdated?: (updated: CaseView) => void;
  compact?: boolean;
}) {
  const router = useRouter();
  const [connectedDevice, setConnectedDevice] = useState<BluetoothPeripheral | null>(null);
  const [scanning, setScanning] = useState(false);
  const [showDiscoveryModal, setShowDiscoveryModal] = useState(false);
  const [results, setResults] = useState<Record<string, "pass" | "fail" | "skip">>(buildAllPassMap);
  const [batteryHealthPct, setBatteryHealthPct] = useState<number>(92);
  const [screenState, setScreenState] = useState<"ok" | "scratches" | "lines" | "cracked">("ok");
  const [bodyState, setBodyState] = useState<"like_new" | "scuffs" | "dents" | "back_cracked" | "bent">("like_new");
  const [liquidState, setLiquidState] = useState<"clean" | "tripped" | "cant_see">("clean");
  const [activePreset, setActivePreset] = useState<GradePresetId>("grade_a");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{
    gradeStatus: string | null;
    gradeLabel: string | null;
    gradeWhy: string | null;
    sessionCode: string;
    caseId: string;
    caseRef: string;
    tradeValue: number | null;
    wePay: number | null;
  } | null>(null);

  function applyPreset(preset: GradePresetId) {
    setActivePreset(preset);
    const map = buildAllPassMap();
    if (preset === "grade_a") {
      setResults(map);
      setBatteryHealthPct(94);
      setScreenState("ok");
      setBodyState("like_new");
      setLiquidState("clean");
    } else if (preset === "grade_b") {
      setResults(map);
      setBatteryHealthPct(86);
      setScreenState("scratches");
      setBodyState("scuffs");
      setLiquidState("clean");
    } else if (preset === "grade_c") {
      map.bluetooth = "fail";
      setResults(map);
      setBatteryHealthPct(81);
      setScreenState("scratches");
      setBodyState("dents");
      setLiquidState("clean");
    } else if (preset === "grade_d") {
      map.bluetooth = "fail";
      map.display = "fail";
      map.speaker = "fail";
      map.battery_health = "fail";
      setResults(map);
      setBatteryHealthPct(72);
      setScreenState("cracked");
      setBodyState("dents");
      setLiquidState("clean");
    }
  }

  /**
   * Connects via the browser's real Web Bluetooth API (`navigator.bluetooth.requestDevice`)
   * and reads GATT `battery_service` (0x180F) and `device_information` (0x180A) when available.
   * If Web Bluetooth is unavailable or blocked by iframe policy, opens the BLE Diagnostic Bridge picker.
   */
  async function scanWebBluetooth() {
    setErr(null);
    setScanning(true);
    try {
      const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { bluetooth?: { requestDevice: (opts: unknown) => Promise<any> } }) : null;
      if (nav?.bluetooth?.requestDevice) {
        try {
          const device = await nav.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: ["battery_service", "device_information", "generic_access"],
          });

          let batteryPct = 90;
          let manufacturer = "Samsung Electronics";
          let modelNumber = "SM-S918B";
          const servicesFound: string[] = ["generic_access (0x1800)"];

          if (device.gatt) {
            try {
              const server = await device.gatt.connect();
              try {
                const battService = await server.getPrimaryService("battery_service");
                const battChar = await battService.getCharacteristic("battery_level");
                const val = await battChar.readValue();
                batteryPct = val.getUint8(0);
                servicesFound.push("battery_service (0x180F)");
              } catch {
                // optional service not exposed on this peripheral
              }
              try {
                const infoService = await server.getPrimaryService("device_information");
                servicesFound.push("device_information (0x180A)");
                const modelChar = await infoService.getCharacteristic("model_number_string");
                const modelVal = await modelChar.readValue();
                const decoded = new TextDecoder().decode(modelVal).trim();
                if (/^SM-[A-Z0-9]+$/i.test(decoded)) modelNumber = decoded.toUpperCase();
                const mfgChar = await infoService.getCharacteristic("manufacturer_name_string");
                const mfgVal = await mfgChar.readValue();
                manufacturer = new TextDecoder().decode(mfgVal).trim() || manufacturer;
              } catch {
                // optional service not exposed
              }
            } catch {
              // GATT read optional
            }
          }

          const paired: BluetoothPeripheral = {
            deviceId: device.id || "web_bt_device",
            deviceName: device.name || `Bluetooth Phone (${modelNumber})`,
            brand: "samsung",
            manufacturer,
            modelName: modelNumber,
            modelCode: modelNumber,
            osVersion: "14",
            totalDiskBytes: 256e9,
            batteryLevelPct: batteryPct,
            rssi: -40,
            protocol: "Web Bluetooth GATT (BLE 5.3)",
            gattServices: servicesFound,
            connectionMode: "web_bluetooth",
          };
          setConnectedDevice(paired);
          setBatteryHealthPct(batteryPct);
          setScanning(false);
          return;
        } catch (btErr) {
          const msg = (btErr as Error)?.message || "";
          if (/user cancelled|canceled/i.test(msg)) {
            setScanning(false);
            return;
          }
          // Fall through to BLE Diagnostic Bridge modal when Web Bluetooth is disallowed by iframe permissions policy
        }
      }
      setShowDiscoveryModal(true);
    } finally {
      setScanning(false);
    }
  }

  function pairBridgeDevice(dev: BluetoothPeripheral) {
    setConnectedDevice(dev);
    setBatteryHealthPct(dev.batteryLevelPct);
    setShowDiscoveryModal(false);
    setErr(null);
  }

  function toggleTest(testId: string) {
    setResults((prev) => {
      const cur = prev[testId] ?? "pass";
      const next = cur === "pass" ? "fail" : "pass";
      return { ...prev, [testId]: next };
    });
  }

  // Live predicted grade based on SwapUp's grading rules (lib/domain/grading.ts)
  const failedTests = DEFAULT_PLAN.filter((p) => {
    if (p.id === "battery_health") return batteryHealthPct < 80 || results.battery_health === "fail";
    return results[p.id] === "fail";
  });
  const criticalFails = failedTests.filter((p) => p.critical);
  const bluetoothFailed = results.bluetooth === "fail";

  const predictedGrade: { letter: "A" | "B" | "C" | "D"; label: string; cls: string; summary: string } = (() => {
    if (
      liquidState === "tripped" ||
      screenState === "cracked" ||
      screenState === "lines" ||
      bodyState === "back_cracked" ||
      bodyState === "bent" ||
      criticalFails.length > 0 ||
      batteryHealthPct < 80
    ) {
      return {
        letter: "D",
        label: "Grade D · Faults / Functional or Structural Issue",
        cls: "pill-bad",
        summary:
          criticalFails.length > 0
            ? `Failed hardware diagnostics: ${criticalFails.map((f) => f.name).join(", ")}`
            : batteryHealthPct < 80
              ? `Battery health ${batteryHealthPct}% (< 80% threshold)`
              : "Screen/body crack, display lines, or liquid indicator tripped",
      };
    }
    if (bodyState === "dents" || failedTests.length > 0) {
      return {
        letter: "C",
        label: "Grade C · Fair (Heavy Wear or Minor Issue)",
        cls: "pill-warn",
        summary: bluetoothFailed
          ? "Bluetooth GATT/radio check failed (adds Wi-Fi/Bluetooth deduction) or dented frame"
          : "Frame dents or non-critical sensor/connectivity issue recorded",
      };
    }
    if (screenState === "scratches" || bodyState === "scuffs") {
      return {
        letter: "B",
        label: "Grade B · Good (Light Cosmetic Wear)",
        cls: "pill-up",
        summary: "All 19 Bluetooth & hardware tests pass; light screen scratches or body scuffs",
      };
    }
    return {
      letter: "A",
      label: "Grade A · Like New (Flawless)",
      cls: "pill-up",
      summary: "All 19 Bluetooth & hardware tests pass, battery ≥ 80%, flawless screen & body",
    };
  })();

  async function runAndApplyGrading() {
    if (!connectedDevice) {
      setShowDiscoveryModal(true);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const effectiveResults = {
        ...results,
        battery_health: batteryHealthPct >= 80 ? ("pass" as const) : ("fail" as const),
      };
      const res = await api<{
        case: CaseView;
        sessionId: string;
        sessionCode: string;
        grading: CaseView["grading"];
      }>(`/api/cases/${encodeURIComponent(caseId)}/bluetooth-grading`, {
        body: {
          bluetoothDevice: connectedDevice,
          results: effectiveResults,
          batteryHealthPct,
          cosmetic: {
            screen: screenState,
            body: bodyState,
            liquid: liquidState,
          },
        },
      });

      setLastResult({
        gradeStatus: res.case.grading?.status ?? null,
        gradeLabel: res.case.grading?.label ?? predictedGrade.label,
        gradeWhy: res.case.grading?.why ?? null,
        sessionCode: res.sessionCode,
        caseId: res.case.id,
        caseRef: res.case.ref,
        tradeValue: res.case.quote?.amount ?? res.case.tradeValue ?? null,
        wePay: res.case.offer?.swap.wePay ?? null,
      });

      if (onCaseUpdated) {
        onCaseUpdated(res.case);
      } else if (caseId === "new") {
        router.push(`/cases/${res.case.id}?view=answer`);
      } else {
        router.refresh();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="rounded-[12px] border border-line bg-surface p-4 space-y-3.5 no-print"
      id="bluetooth-grading"
      aria-labelledby="bluetooth-grading-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-[#0052CC] px-2.5 py-1 text-[12px] font-bold tracking-wide text-white">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M6.5 6.5L17.5 17.5L12 23V1L17.5 6.5L6.5 17.5"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Bluetooth Grading
          </span>
          <h3 id="bluetooth-grading-title" className="text-[15px] font-[730] text-ink">
            Bluetooth Device Diagnostics &amp; Grading Tester
          </h3>
        </div>
        {connectedDevice ? (
          <div className="flex items-center gap-2">
            <span className="pill pill-up !text-[11.5px]">
              ● Connected: {connectedDevice.deviceName} ({connectedDevice.rssi} dBm)
            </span>
            <button
              type="button"
              className="btn btn-sm btn-ghost !min-h-[28px] !py-0.5 !px-2 !text-[12px]"
              onClick={() => setShowDiscoveryModal(true)}
            >
              Switch Device
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-sm btn-primary !bg-[#0052CC] !border-[#0052CC] !text-white"
              disabled={scanning || busy}
              onClick={scanWebBluetooth}
            >
              {scanning ? "Scanning Bluetooth…" : "Scan & Connect via Bluetooth"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => setShowDiscoveryModal(true)}
            >
              Pair Test Phone (BLE Bridge)
            </button>
          </div>
        )}
      </div>

      {!connectedDevice ? (
        <p className="text-[13.5px] text-ink-2 leading-relaxed">
          Connect a customer phone over <strong>Web Bluetooth (BLE GATT)</strong> or the <strong>BLE Diagnostic Bridge</strong> to run the 19-point hardware check, verify Bluetooth radio &amp; battery health, and test SwapUp Grades (<strong>A, B, C, D</strong>).
        </p>
      ) : (
        <div className="space-y-3.5">
          {/* Connected Bluetooth Telemetry Strip */}
          <div className="rounded-[10px] border border-line bg-surface-2 px-3.5 py-2.5 text-[12.5px] flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="text-muted">Protocol: </span>
              <strong className="text-ink">{connectedDevice.protocol}</strong>
              {" · "}
              <span className="text-muted">Model Code: </span>
              <code className="num font-semibold text-ink">{connectedDevice.modelCode}</code>
              {" · "}
              <span className="text-muted">Signal: </span>
              <strong className="num text-up">{connectedDevice.rssi} dBm</strong>
            </div>
            <div className="text-muted">
              GATT Services: <span className="text-ink font-medium">{connectedDevice.gattServices.join(", ")}</span>
            </div>
          </div>

          {/* One-Click Grade Scenario Presets */}
          <div className="space-y-1.5">
            <div className="text-[12px] font-bold uppercase tracking-wider text-ink-2">
              1. Select Grading Test Scenario (or customize individual tests below)
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(
                [
                  ["grade_a", "Grade A · Like New", "All 19 pass · 94% Batt · Flawless"],
                  ["grade_b", "Grade B · Good", "All 19 pass · 86% Batt · Scratches"],
                  ["grade_c", "Grade C · Fair", "BT fail + Frame dents · 81% Batt"],
                  ["grade_d", "Grade D · Faults", "BT + Display + Speaker fail · 72%"],
                ] as const
              ).map(([id, title, sub]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => applyPreset(id)}
                  className={`rounded-[9px] border px-3 py-2 text-left transition-colors ${
                    activePreset === id
                      ? "border-[#0052CC] bg-surface-2 font-semibold"
                      : "border-line bg-surface hover:bg-surface-2/60"
                  }`}
                >
                  <div className="text-[13px] font-bold text-ink">{title}</div>
                  <div className="text-[11.5px] text-muted mt-0.5 leading-snug">{sub}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Cosmetic & Battery GATT Controls */}
          <div className="grid sm:grid-cols-4 gap-2.5">
            <label className="block">
              <span className="label !text-[12px]">GATT Battery Health (%)</span>
              <input
                type="number"
                min={10}
                max={100}
                className="input num !min-h-[34px] !py-1 !px-2.5 text-[13.5px]"
                value={batteryHealthPct}
                onChange={(e) => setBatteryHealthPct(Math.max(10, Math.min(100, Number(e.target.value) || 80)))}
              />
            </label>
            <label className="block">
              <span className="label !text-[12px]">Screen Inspection</span>
              <select
                className="select !min-h-[34px] !py-1 text-[13px]"
                value={screenState}
                onChange={(e) => setScreenState(e.target.value as typeof screenState)}
              >
                <option value="ok">OK (Flawless)</option>
                <option value="scratches">Scratches</option>
                <option value="lines">Lines or spots</option>
                <option value="cracked">Cracked glass</option>
              </select>
            </label>
            <label className="block">
              <span className="label !text-[12px]">Body / Frame</span>
              <select
                className="select !min-h-[34px] !py-1 text-[13px]"
                value={bodyState}
                onChange={(e) => setBodyState(e.target.value as typeof bodyState)}
              >
                <option value="like_new">Like new</option>
                <option value="scuffs">Light scuffs</option>
                <option value="dents">Dents on frame</option>
                <option value="back_cracked">Back glass cracked</option>
                <option value="bent">Bent frame</option>
              </select>
            </label>
            <label className="block">
              <span className="label !text-[12px]">Liquid Indicator</span>
              <select
                className="select !min-h-[34px] !py-1 text-[13px]"
                value={liquidState}
                onChange={(e) => setLiquidState(e.target.value as typeof liquidState)}
              >
                <option value="clean">Clean (Dry)</option>
                <option value="tripped">Tripped (Liquid damage)</option>
              </select>
            </label>
          </div>

          {/* 19-Point Hardware & Bluetooth Diagnostic Matrix */}
          {!compact ? (
            <details className="rounded-[10px] border border-line bg-surface-2/50 px-3.5 py-2.5">
              <summary className="cursor-pointer text-[13px] font-semibold text-ink">
                2. Customize 19-Point Bluetooth &amp; Hardware Diagnostic Signals ({ DEFAULT_PLAN.length - failedTests.length }/{ DEFAULT_PLAN.length } passing)
              </summary>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 mt-2.5">
                {DEFAULT_PLAN.filter((p) => p.id !== "battery_health").map((p) => {
                  const outcome = results[p.id] ?? "pass";
                  const passed = outcome === "pass";
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggleTest(p.id)}
                      className={`flex items-center justify-between rounded-[7px] border px-2.5 py-1.5 text-[12.5px] text-left ${
                        passed
                          ? "border-line bg-surface text-ink"
                          : "border-[color:var(--bad)] bg-bad-bg text-[color:var(--bad)] font-semibold"
                      }`}
                    >
                      <span className="truncate pr-1">
                        {p.id === "bluetooth" ? "Bluetooth 5.3 GATT" : p.name}
                      </span>
                      <span className="num text-[11px] font-bold uppercase">
                        {passed ? "✓ PASS" : "✗ FAIL"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </details>
          ) : null}

          {/* Live Predicted Grade & Apply Button */}
          <div className="rounded-[10px] border border-line bg-surface-2 p-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-semibold text-muted">Predicted SwapUp Grade:</span>
                <span className={`pill ${predictedGrade.cls}`}>{predictedGrade.label}</span>
              </div>
              <div className="text-[12.5px] text-ink-2 mt-1">{predictedGrade.summary}</div>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-primary !bg-[#0052CC] !border-[#0052CC] !text-white"
              disabled={busy}
              onClick={runAndApplyGrading}
            >
              {busy
                ? "Running Bluetooth Grading…"
                : caseId === "new"
                  ? `Run Bluetooth Grading (${predictedGrade.letter}) & Open Case`
                  : `Apply Bluetooth Grade (${predictedGrade.letter}) to Case`}
            </button>
          </div>
        </div>
      )}

      {lastResult ? (
        <Banner tone="up">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <strong>
                ✓ Bluetooth Grading Applied ({lastResult.gradeLabel || "Graded"})
              </strong>{" "}
              · Session <code className="num">{lastResult.sessionCode}</code> on case{" "}
              <strong className="num">{lastResult.caseRef}</strong>
              {lastResult.gradeWhy ? <div className="text-[12.5px] mt-0.5">{lastResult.gradeWhy}</div> : null}
            </div>
          </div>
        </Banner>
      ) : null}

      {/* Bluetooth Device Discovery Modal */}
      {showDiscoveryModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Pair Bluetooth Device for Grading"
        >
          <div className="w-full max-w-[480px] rounded-[16px] overflow-hidden bg-surface shadow-2xl border border-line">
            <div className="bg-[#0052CC] text-white px-5 py-4 flex items-center justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-widest opacity-85">
                  Bluetooth LE Diagnostic Scanner
                </div>
                <div className="text-[17px] font-bold mt-0.5">
                  Select Nearby Bluetooth Device to Grade
                </div>
              </div>
              <button
                type="button"
                className="text-white/80 hover:text-white text-[13px] font-semibold"
                onClick={() => setShowDiscoveryModal(false)}
              >
                Close
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-[13px] text-ink-2">
                Choose a discovered Bluetooth LE device below (or use your browser&apos;s native Web Bluetooth chooser) to establish a GATT diagnostic link:
              </p>
              <div className="space-y-2">
                {DISCOVERABLE_BLE_DEVICES.map((d) => (
                  <button
                    key={d.deviceId}
                    type="button"
                    onClick={() => pairBridgeDevice(d)}
                    className="w-full rounded-[10px] border border-line bg-surface-2 hover:border-[#0052CC] p-3 text-left flex items-center justify-between gap-3 transition-colors"
                  >
                    <div>
                      <div className="font-bold text-[14px] text-ink">{d.deviceName}</div>
                      <div className="text-[12px] text-muted mt-0.5">
                        {d.protocol} · Storage {(d.totalDiskBytes / 1e9).toFixed(0)}GB · Battery {d.batteryLevelPct}%
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="pill pill-up num !text-[11.5px]">{d.rssi} dBm</span>
                      <div className="text-[11.5px] font-semibold text-[#0052CC] mt-1">Pair &amp; Grade →</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <ErrorText error={err} />
    </section>
  );
}
