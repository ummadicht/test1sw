import { handle, body } from "@/lib/server/http";
import { requireUser, HttpError } from "@/lib/server/auth";
import { getCaseForViewer } from "@/lib/server/counter-extra";
import {
  getCaseRazorpaySummary,
  createRazorpayOrder,
  verifyRazorpayPayment,
  sendCaseReceiptEmail,
  type RazorpayJourney,
  type RazorpayPaymentPlan,
} from "@/lib/server/razorpay";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser();
    const { id } = await ctx.params;
    await getCaseForViewer(u, id); // enforce store/org access scope
    return getCaseRazorpaySummary(id);
  });
}

type PostBody =
  | {
      action: "create_order";
      journey: RazorpayJourney;
      paymentPlan: RazorpayPaymentPlan;
      customAdvanceAmount?: number | null;
      overrideTotalAmount?: number | null;
      emiMonths?: number | null;
      customerName?: string | null;
      customerPhone?: string | null;
    }
  | {
      action: "verify_payment";
      razorpayOrderId: string;
      razorpayPaymentId?: string | null;
      razorpaySignature?: string | null;
      paymentMethod?: string | null;
    }
  | {
      action: "email_receipt";
      email: string;
      paymentId?: string | null;
    };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const u = await requireUser(["advisor", "store_manager", "org_admin", "platform"]);
    const { id } = await ctx.params;
    await getCaseForViewer(u, id); // enforce store/org access scope
    const payload = await body<PostBody>(req);
    if (!payload || typeof payload !== "object") {
      throw new HttpError(400, "Expected JSON body.");
    }

    if (payload.action === "create_order") {
      return createRazorpayOrder(u, {
        caseId: id,
        journey: payload.journey,
        paymentPlan: payload.paymentPlan,
        customAdvanceAmount: payload.customAdvanceAmount,
        overrideTotalAmount: payload.overrideTotalAmount,
        emiMonths: payload.emiMonths,
        customerName: payload.customerName,
        customerPhone: payload.customerPhone,
      });
    }

    if (payload.action === "verify_payment") {
      if (!payload.razorpayOrderId) {
        throw new HttpError(400, "Missing razorpayOrderId.");
      }
      return verifyRazorpayPayment(u, {
        caseId: id,
        razorpayOrderId: payload.razorpayOrderId,
        razorpayPaymentId: payload.razorpayPaymentId,
        razorpaySignature: payload.razorpaySignature,
        paymentMethod: payload.paymentMethod,
      });
    }

    if (payload.action === "email_receipt") {
      if (!payload.email) {
        throw new HttpError(400, "Missing recipient email address.");
      }
      return sendCaseReceiptEmail(u, {
        caseId: id,
        toEmail: payload.email,
        paymentId: payload.paymentId ?? null,
      });
    }

    throw new HttpError(400, "Unsupported action.");
  });
}

