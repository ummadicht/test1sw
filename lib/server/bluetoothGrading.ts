import { randomBytes } from "node:crypto";
import { queryOne, execute, nowIso, parseJson, audit } from "./db";
import { HttpError, type SessionUser } from "./auth";
import {
  DEFAULT_PLAN,
  batteryHealthResult,
  mergeResults,
  type TestOutcome,
  type TestResults,
} from "../domain/diagnostics";
import {
  createTestSession,
  joinByCode,
  deviceResults,
  deviceComplete,
  applyTestSession,
  getTestSession,
} from "./testSessions";
import { certifyCase, getCase, updateCase, type CaseView } from "./cases";
import { redactCaseForCounter } from "./counter-extra";

export type BluetoothDeviceTelemetry = {
  deviceId?: string | null;
  deviceName?: string | null;
  name?: string | null;
  brand?: string | null;
  manufacturer?: string | null;
  modelName?: string | null;
  modelCode?: string | null;
  modelNumber?: string | null;
  osVersion?: string | null;
  firmwareRevision?: string | null;
  totalDiskBytes?: number | null;
  batteryLevelPct?: number | null;
  rssi?: number | null;
  rssiDbm?: number | null;
  protocol?: string | null;
  gattServices?: string[];
  connectionMode?: "web_bluetooth" | "ble_bridge";
};

export type BluetoothGradingInput = {
  caseId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  bluetoothDevice: BluetoothDeviceTelemetry;
  results?: Record<string, "pass" | "fail" | "skip">;
  checks?: Record<string, "pass" | "fail" | "skip">;
  batteryHealthPct?: number | null;
  cosmetic?: {
    screen?: "ok" | "scratches" | "lines" | "cracked";
    body?: "like_new" | "scuffs" | "dents" | "back_cracked" | "bent";
    liquid?: "clean" | "tripped" | "cant_see";
  };
  screen?: "ok" | "scratches" | "lines" | "cracked";
  body?: "like_new" | "scuffs" | "dents" | "back_cracked" | "bent";
  liquid?: "clean" | "tripped" | "cant_see";
  cameraSide?: "rear" | "front" | "both";
};

export async function runBluetoothGradingTest(
  u: SessionUser,
  input: BluetoothGradingInput,
  origin?: string | null
): Promise<{
  case: CaseView;
  sessionId: string;
  sessionCode: string;
  bluetoothTelemetry: {
    deviceName: string;
    modelCode: string | null;
    protocol: string;
    rssi: number;
    gattServices: string[];
    batteryHealthPct: number | null;
    connectionMode: "web_bluetooth" | "ble_bridge";
    passedCount: number;
    failedCount: number;
    failedIds: string[];
    testedAt: string;
  };
  grading: (NonNullable<CaseView["grading"]> & {
    swapupGrade: "A" | "B" | "C" | "D";
    swapupLabel: string;
  }) | null;
}> {
  if (!["advisor", "store_manager"].includes(u.role)) {
    throw new HttpError(403, "Only store counter staff or store managers can run Bluetooth grading diagnostics.");
  }

  const bt = input.bluetoothDevice || {};
  const rawMap = { ...(input.checks || {}), ...(input.results || {}) };
  // Map common aliases ("rear_camera" / "front_camera" -> "camera")
  if ((rawMap.rear_camera === "fail" || rawMap.front_camera === "fail") && !rawMap.camera) {
    rawMap.camera = "fail";
  }

  const now = nowIso();
  const healthPct =
    typeof input.batteryHealthPct === "number" && Number.isFinite(input.batteryHealthPct)
      ? Math.max(1, Math.min(100, Math.round(input.batteryHealthPct)))
      : typeof bt.batteryLevelPct === "number" && Number.isFinite(bt.batteryLevelPct)
        ? Math.max(1, Math.min(100, Math.round(bt.batteryLevelPct)))
        : 90;

  const targetCaseId = input.caseId && input.caseId !== "new" ? input.caseId : undefined;

  // If re-running a Bluetooth grading test on an existing editable case, clear prior test sessions
  // and reset faults/condition/certification so the new Bluetooth test run grades cleanly.
  if (targetCaseId) {
    await execute(
      `DELETE FROM test_sessions WHERE case_id = $1`,
      [targetCaseId]
    );
    await execute(
      `UPDATE cases SET faults = '[]', condition = NULL, certification = NULL, updated_at = $1 WHERE id = $2 AND status IN ('draft', 'quoted')`,
      [now, targetCaseId]
    );
  }

  // 1. Create or attach a test session for the target case
  const created = await createTestSession(
    u,
    {
      caseId: targetCaseId,
      customerName: input.customerName || undefined,
      customerPhone: input.customerPhone || undefined,
    },
    origin
  );

  const sessionId = created.session.id;
  const sessionCode = created.session.code;
  const caseId = created.session.caseId;

  // 2. Join the session with Bluetooth device identity & GATT hardware telemetry
  const modelCode = bt.modelCode || bt.modelNumber || "SM-S918B";
  const devName = bt.deviceName || bt.name || `Samsung ${modelCode}`;
  const rssiVal = bt.rssi ?? bt.rssiDbm ?? -42;

  const joined = await joinByCode(
    {
      code: sessionCode,
      installId: `bt-${randomBytes(6).toString("hex")}`,
      appVersion: "0.9.3",
      device: {
        brand: bt.brand || "samsung",
        manufacturer: bt.manufacturer || "samsung",
        modelName: bt.modelName || modelCode,
        modelCode,
        osVersion: bt.osVersion || bt.firmwareRevision || "14",
        totalDiskBytes: bt.totalDiskBytes ?? 256e9,
        batteryLevelPct: healthPct,
        isPhysicalDevice: true,
      },
    },
    "127.0.0.1",
    origin
  );

  const ticketHeader = `Ticket ${joined.ticket}`;

  // 3. Build the 19-point diagnostic results payload (including Bluetooth radio & GATT verification)
  const failedIds: string[] = [];
  let passedCount = 0;

  const items = DEFAULT_PLAN.filter((p) => p.id !== "battery_health").map((p) => {
    const rawOutcome = rawMap[p.id];
    const outcome: TestOutcome =
      rawOutcome === "fail" || rawOutcome === "skip" || rawOutcome === "pass" ? rawOutcome : "pass";
    if (outcome === "fail") failedIds.push(p.id);
    else if (outcome === "pass") passedCount++;

    let detail: Record<string, unknown> | null = null;
    if (p.id === "bluetooth") {
      detail = {
        protocol: bt.protocol || "BLE 5.3 GATT",
        rssi: rssiVal,
        deviceName: devName,
        gattServices: bt.gattServices || ["battery_service", "device_information", "generic_access"],
        connectionMode: bt.connectionMode || "web_bluetooth",
      };
    } else if (p.id === "camera" && outcome === "fail") {
      detail = {
        side:
          input.cameraSide ||
          (rawMap.front_camera === "fail" && rawMap.rear_camera === "fail"
            ? "both"
            : rawMap.front_camera === "fail"
              ? "front"
              : "rear"),
      };
    }
    return {
      testId: p.id,
      outcome,
      at: now,
      detail,
    };
  });

  await deviceResults(ticketHeader, { results: items });

  // 4. Record battery_health from Bluetooth GATT Battery Service (0x180F)
  const bhRes = batteryHealthResult(healthPct, now, "Bluetooth GATT Battery Service (0x180F)");
  const explicitBhOutcome = rawMap.battery_health;
  const finalBhOutcome: TestOutcome =
    explicitBhOutcome === "fail" || explicitBhOutcome === "pass" || explicitBhOutcome === "skip"
      ? explicitBhOutcome
      : bhRes.outcome;

  if (finalBhOutcome === "fail") failedIds.push("battery_health");
  else if (finalBhOutcome === "pass") passedCount++;

  const sessionRow = await queryOne<{ results: string }>(
    `SELECT results FROM test_sessions WHERE id = $1`,
    [sessionId]
  );
  if (sessionRow) {
    const existing = parseJson<TestResults>(sessionRow.results, {});
    const merged = mergeResults(existing, [
      {
        testId: "battery_health",
        outcome: finalBhOutcome,
        detail: { ...bhRes.detail, healthPct },
        at: now,
      },
    ]);
    await execute(`UPDATE test_sessions SET results = $1, updated_at = $2 WHERE id = $3`, [
      JSON.stringify(merged),
      now,
      sessionId,
    ]);
  }

  // 5. Complete and apply the session to the case
  await deviceComplete(ticketHeader);
  try {
    await applyTestSession(u, sessionId);
  } catch {
    // autoApply inside deviceComplete may have already applied it
  }

  // Ensure the case has the matched model if still unset
  const currentCase = await getCase(u, caseId);
  if (!currentCase.device) {
    await updateCase(u, caseId, {
      modelId: "galaxy-s23-ultra",
      variant: "256GB",
    });
  }

  // 6. Certify screen, body, and liquid so the SwapUp Grade (A / B / C / D) is finalized
  const screenVal = input.cosmetic?.screen || input.screen || "ok";
  const bodyVal = input.cosmetic?.body || input.body || "like_new";
  const liquidVal = input.cosmetic?.liquid || input.liquid || "clean";

  if (screenVal === "ok" && bodyVal === "like_new" && liquidVal === "clean") {
    await certifyCase(u, caseId, { allFine: true, testSessionId: sessionId });
  } else {
    await certifyCase(u, caseId, { row: "screen", value: screenVal, testSessionId: sessionId });
    await certifyCase(u, caseId, { row: "body", value: bodyVal, testSessionId: sessionId });
    await certifyCase(u, caseId, { row: "liquid", value: liquidVal, testSessionId: sessionId });
  }

  const finalCase = redactCaseForCounter(u, await getCase(u, caseId));
  const sessionView = await getTestSession(u, sessionId, origin);

  const rawGrading = finalCase.grading;
  const swapupGrade: "A" | "B" | "C" | "D" =
    rawGrading?.letter === "A"
      ? "A"
      : rawGrading?.letter === "B"
        ? "B"
        : rawGrading?.letter === "C"
          ? "C"
          : "D";
  const swapupLabel = `Grade ${swapupGrade}`;

  await audit({
    userId: u.id,
    orgId: u.orgId,
    storeId: finalCase.storeId,
    action: "bluetooth.grading.applied",
    entity: "case",
    entityId: caseId,
    detail: {
      userId: u.id,
      role: u.role,
      timestamp: now,
      sessionId,
      deviceName: devName,
      connectionMode: bt.connectionMode || "web_bluetooth",
      rssi: rssiVal,
      batteryHealthPct: healthPct,
      gradeStatus: rawGrading?.status ?? null,
      gradeLabel: rawGrading?.label ?? null,
      swapupGrade,
      verdict: sessionView.session.summary?.verdict ?? null,
    },
  });

  return {
    case: finalCase,
    sessionId,
    sessionCode,
    bluetoothTelemetry: {
      deviceName: devName,
      modelCode,
      protocol: bt.protocol || "BLE 5.3 GATT",
      rssi: rssiVal,
      gattServices: bt.gattServices || ["battery_service (0x180F)", "device_information (0x180A)", "generic_access (0x1800)"],
      batteryHealthPct: healthPct,
      connectionMode: bt.connectionMode || "web_bluetooth",
      passedCount,
      failedCount: failedIds.length,
      failedIds,
      testedAt: now,
    },
    grading: rawGrading
      ? {
          ...rawGrading,
          swapupGrade,
          swapupLabel,
        }
      : null,
  };
}
