import { handle } from "@/lib/server/http";
import { requireUser, HttpError } from "@/lib/server/auth";
import {
  getIqConnectionStatus,
  updateIqConnectionSettings,
  testPriceiqLiveQuote,
  completeLocalGradeiqCapture,
  syncIqEnvFromDb,
  type GradePreset,
} from "@/lib/server/iqEngines";
import { createSession, getSession, lookupImei, cameraUrl } from "@/lib/server/gradeiq";

export async function GET() {
  return handle(async () => {
    await requireUser();
    return getIqConnectionStatus();
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const u = await requireUser();
    const body = (await req.json()) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "configure";

    if (action === "configure") {
      if (!["platform", "org_admin", "store_manager"].includes(u.role)) {
        throw new HttpError(403, "Only platform, programme admin, or store manager can change PriceIQ / GradeIQ connection settings.");
      }
      return updateIqConnectionSettings({
        priceiqEnabled: typeof body.priceiqEnabled === "boolean" ? body.priceiqEnabled : undefined,
        priceiqBaseUrl: typeof body.priceiqBaseUrl === "string" ? body.priceiqBaseUrl : undefined,
        priceiqApiKey: typeof body.priceiqApiKey === "string" ? body.priceiqApiKey : undefined,
        gradeiqEnabled: typeof body.gradeiqEnabled === "boolean" ? body.gradeiqEnabled : undefined,
        gradeiqBaseUrl: typeof body.gradeiqBaseUrl === "string" ? body.gradeiqBaseUrl : undefined,
        gradeiqPublicUrl: typeof body.gradeiqPublicUrl === "string" ? body.gradeiqPublicUrl : undefined,
        gradeiqClient: typeof body.gradeiqClient === "string" ? body.gradeiqClient : undefined,
        gradeiqChannel: typeof body.gradeiqChannel === "string" ? body.gradeiqChannel : undefined,
        gradeiqServerKey: typeof body.gradeiqServerKey === "string" ? body.gradeiqServerKey : undefined,
      });
    }

    if (action === "test_priceiq") {
      const brand = typeof body.brand === "string" && body.brand.trim() ? body.brand.trim() : "Samsung";
      const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "Galaxy S23 Ultra";
      const storageGb = Number(body.storageGb) || 256;
      const quote = await testPriceiqLiveQuote({ brand, model, storageGb });
      return { quote };
    }

    if (action === "test_gradeiq_session") {
      await syncIqEnvFromDb();
      const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "Samsung Galaxy S23 Ultra";
      const preset = (typeof body.preset === "string" && ["A", "B", "C", "D"].includes(body.preset) ? body.preset : "A") as GradePreset;
      const created = await createSession({ model });
      await completeLocalGradeiqCapture(created.id, { preset });
      const snapshot = await getSession(created.id, new Date().toISOString());
      return {
        sessionId: created.id,
        client: created.client,
        cameraUrl: cameraUrl(created.id),
        snapshot,
      };
    }

    if (action === "test_gradeiq_imei") {
      await syncIqEnvFromDb();
      const imei = typeof body.imei === "string" && body.imei.trim() ? body.imei.trim() : "354073151234568";
      const result = await lookupImei(imei, new Date().toISOString());
      return { result };
    }

    throw new HttpError(400, `Unknown action: ${action}`);
  });
}
