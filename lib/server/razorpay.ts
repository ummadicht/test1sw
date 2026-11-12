import { createHmac } from "node:crypto";
import { query, queryOne, execute, tx, nowIso, newId, audit } from "./db";
import { HttpError, type SessionUser } from "./auth";

export type RazorpayJourney = "repair" | "swap";

export type RazorpayPaymentPlan =
  | "repair_part_advance"
  | "repair_remaining"
  | "repair_full"
  | "swap_direct"
  | "swap_emi";

export type InstallmentStage = "advance" | "remaining" | "full" | "emi";

export type RazorpayPaymentRow = {
  id: string;
  case_id: string;
  case_ref: string;
  org_id: string;
  store_id: string;
  journey: RazorpayJourney;
  payment_plan: RazorpayPaymentPlan;
  installment_stage: InstallmentStage;
  total_case_payable: number;
  amount: number;
  remaining_due: number;
  emi_months: number | null;
  emi_monthly_amount: number | null;
  currency: string;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  razorpay_signature: string | null;
  payment_method: string | null;
  status: "created" | "paid" | "failed" | "refunded";
  customer_name: string | null;
  customer_phone: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  paid_at: string | null;
};

export type EmiPlanOption = {
  months: number;
  interestRatePa: number;
  noCost: boolean;
  monthlyAmount: number;
  totalAmount: number;
  label: string;
};

export type CaseRazorpaySummary = {
  caseId: string;
  caseRef: string;
  keyId: string;
  liveKeysConfigured: boolean;
  repair: {
    totalPayable: number | null;
    paidAmount: number;
    remainingBalance: number;
    suggestedAdvance: number;
    hasAdvancePaid: boolean;
    fullyPaid: boolean;
  };
  swap: {
    totalPayable: number | null;
    paidAmount: number;
    remainingBalance: number;
    fullyPaid: boolean;
    emiPlans: EmiPlanOption[];
  };
  payments: RazorpayPaymentRow[];
};

let tableChecked = false;
async function ensureRazorpayTable(): Promise<void> {
  if (tableChecked) return;
  await execute(`
    CREATE TABLE IF NOT EXISTS razorpay_payments (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      case_ref TEXT NOT NULL,
      org_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      journey TEXT NOT NULL,
      payment_plan TEXT NOT NULL,
      installment_stage TEXT NOT NULL,
      total_case_payable INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      remaining_due INTEGER NOT NULL DEFAULT 0,
      emi_months INTEGER,
      emi_monthly_amount INTEGER,
      currency TEXT NOT NULL DEFAULT 'INR',
      razorpay_order_id TEXT NOT NULL UNIQUE,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
      payment_method TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      customer_name TEXT,
      customer_phone TEXT,
      notes TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      paid_at TEXT
    )
  `);
  tableChecked = true;
}

export function getRazorpayConfig() {
  const keyId = (process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || "").trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || "").trim();
  const liveKeysConfigured = Boolean(keyId && keySecret);
  return {
    keyId: keyId || "rzp_test_swapup_demo",
    keySecret: keySecret || "swapup_demo_razorpay_secret",
    liveKeysConfigured,
  };
}

export function computeEmiPlans(principal: number | null): EmiPlanOption[] {
  if (!principal || principal <= 0) return [];
  const tenures: { months: number; ratePa: number; noCost: boolean }[] = [
    { months: 3, ratePa: 0, noCost: true },
    { months: 6, ratePa: 0, noCost: true },
    { months: 9, ratePa: 13.5, noCost: false },
    { months: 12, ratePa: 14.0, noCost: false },
    { months: 18, ratePa: 14.5, noCost: false },
    { months: 24, ratePa: 15.0, noCost: false },
  ];

  return tenures.map(({ months, ratePa, noCost }) => {
    if (noCost || ratePa === 0) {
      const monthlyAmount = Math.ceil(principal / months);
      return {
        months,
        interestRatePa: 0,
        noCost: true,
        monthlyAmount,
        totalAmount: principal,
        label: `${months}M No-Cost EMI · ₹${monthlyAmount.toLocaleString("en-IN")}/mo`,
      };
    }
    const r = ratePa / 12 / 100;
    const factor = Math.pow(1 + r, months);
    const monthlyAmount = Math.ceil((principal * r * factor) / (factor - 1));
    const totalAmount = monthlyAmount * months;
    return {
      months,
      interestRatePa: ratePa,
      noCost: false,
      monthlyAmount,
      totalAmount,
      label: `${months}M EMI (${ratePa}% p.a.) · ₹${monthlyAmount.toLocaleString("en-IN")}/mo`,
    };
  });
}

type CasePricingRow = {
  id: string;
  ref: string;
  org_id: string;
  store_id: string;
  customer: string | null;
  repair: string | null;
  manual_repair: string | null;
  payable: number | null;
  trade_value: number | null;
  bonus_value: number | null;
  premium_value: number | null;
  quote: string | null;
  upgrade: string | null;
};

export const DEFAULT_REPAIR_AMOUNT = 5000;

function resolveCaseTotals(row: CasePricingRow): {
  repairTotal: number;
  swapTotal: number | null;
  customerName: string | null;
  customerPhone: string | null;
} {
  let repairTotal: number | null = null;
  try {
    if (row.manual_repair) {
      const mr = JSON.parse(row.manual_repair) as { amount?: number };
      if (typeof mr?.amount === "number" && mr.amount > 0) repairTotal = mr.amount;
    }
    if (repairTotal === null && row.repair) {
      const rep = JSON.parse(row.repair) as { customerPays?: number | null };
      if (typeof rep?.customerPays === "number" && rep.customerPays > 0) repairTotal = rep.customerPays;
    }
  } catch {
    // ignore parse error
  }
  if (repairTotal === null || repairTotal <= 0) {
    repairTotal = DEFAULT_REPAIR_AMOUNT;
  }

  let swapTotal: number | null = typeof row.payable === "number" && row.payable > 0 ? row.payable : null;
  if (swapTotal === null) {
    try {
      const upg = row.upgrade ? (JSON.parse(row.upgrade) as { price?: number }) : null;
      const q = row.quote ? (JSON.parse(row.quote) as { amount?: number | null }) : null;
      const tradeVal = typeof row.trade_value === "number" ? row.trade_value : typeof q?.amount === "number" ? q.amount : 0;
      const bonusVal = typeof row.bonus_value === "number" ? row.bonus_value : 0;
      const premVal = typeof row.premium_value === "number" ? row.premium_value : 0;
      if (upg && typeof upg.price === "number" && upg.price > 0) {
        const net = upg.price - tradeVal - premVal - bonusVal;
        if (net > 0) swapTotal = net;
      }
    } catch {
      // ignore
    }
  }

  let customerName: string | null = null;
  let customerPhone: string | null = null;
  try {
    if (row.customer) {
      const c = JSON.parse(row.customer) as { name?: string; phone?: string };
      customerName = c.name || null;
      customerPhone = c.phone || null;
    }
  } catch {
    // ignore
  }

  return { repairTotal, swapTotal, customerName, customerPhone };
}

export async function getCaseRazorpaySummary(caseId: string): Promise<CaseRazorpaySummary> {
  await ensureRazorpayTable();
  const c = await queryOne<CasePricingRow>(
    `SELECT id, ref, org_id, store_id, customer, repair, manual_repair, payable, trade_value, bonus_value, premium_value, quote, upgrade
     FROM cases WHERE id = $1`,
    [caseId]
  );
  if (!c) throw new HttpError(404, "Case not found.");

  const payments = await query<RazorpayPaymentRow>(
    `SELECT * FROM razorpay_payments WHERE case_id = $1 ORDER BY created_at DESC`,
    [caseId]
  );

  const { repairTotal, swapTotal } = resolveCaseTotals(c);
  const cfg = getRazorpayConfig();

  const paidRepair = payments
    .filter((p) => p.journey === "repair" && p.status === "paid")
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);

  const paidSwap = payments
    .filter((p) => p.journey === "swap" && p.status === "paid")
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);

  const repairRemaining = repairTotal !== null ? Math.max(0, repairTotal - paidRepair) : 0;
  const suggestedAdvance =
    repairTotal !== null && repairTotal > 0
      ? Math.max(100, Math.min(repairTotal - 10, Math.round((repairTotal * 0.3) / 10) * 10))
      : 0;

  const swapRemaining = swapTotal !== null ? Math.max(0, swapTotal - paidSwap) : 0;

  return {
    caseId: c.id,
    caseRef: c.ref,
    keyId: cfg.keyId,
    liveKeysConfigured: cfg.liveKeysConfigured,
    repair: {
      totalPayable: repairTotal,
      paidAmount: paidRepair,
      remainingBalance: repairRemaining,
      suggestedAdvance,
      hasAdvancePaid: paidRepair > 0 && repairRemaining > 0,
      fullyPaid: repairTotal !== null && repairTotal > 0 && repairRemaining === 0,
    },
    swap: {
      totalPayable: swapTotal,
      paidAmount: paidSwap,
      remainingBalance: swapRemaining,
      fullyPaid: swapTotal !== null && swapTotal > 0 && swapRemaining === 0,
      emiPlans: computeEmiPlans(swapRemaining > 0 ? swapRemaining : swapTotal),
    },
    payments,
  };
}

export async function createRazorpayOrder(
  user: SessionUser,
  input: {
    caseId: string;
    journey: RazorpayJourney;
    paymentPlan: RazorpayPaymentPlan;
    customAdvanceAmount?: number | null;
    overrideTotalAmount?: number | null;
    emiMonths?: number | null;
    customerName?: string | null;
    customerPhone?: string | null;
  }
): Promise<{
  payment: RazorpayPaymentRow;
  keyId: string;
  liveKeysConfigured: boolean;
  summary: CaseRazorpaySummary;
}> {
  await ensureRazorpayTable();
  const c = await queryOne<CasePricingRow>(
    `SELECT id, ref, org_id, store_id, customer, repair, manual_repair, payable, trade_value, bonus_value, premium_value, quote, upgrade
     FROM cases WHERE id = $1`,
    [input.caseId]
  );
  if (!c) throw new HttpError(404, "Case not found.");

  const summaryBefore = await getCaseRazorpaySummary(input.caseId);
  const { repairTotal, swapTotal, customerName: dbName, customerPhone: dbPhone } = resolveCaseTotals(c);

  const journey = input.journey;
  const plan = input.paymentPlan;
  let totalCasePayable = 0;
  let amountToCharge = 0;
  let remainingDue = 0;
  let stage: InstallmentStage = "full";
  let emiMonths: number | null = null;
  let emiMonthlyAmount: number | null = null;

  if (journey === "repair") {
    totalCasePayable =
      typeof input.overrideTotalAmount === "number" && input.overrideTotalAmount > 0
        ? Math.round(input.overrideTotalAmount)
        : repairTotal ?? 0;
    if (totalCasePayable <= 0) {
      throw new HttpError(400, "Repair quote is not priced yet for this case.");
    }
    const alreadyPaid = summaryBefore.repair.paidAmount;
    const balance = Math.max(0, totalCasePayable - alreadyPaid);
    if (balance <= 0) {
      throw new HttpError(400, "Repair amount is already paid in full for this case.");
    }

    if (plan === "repair_part_advance") {
      stage = "advance";
      const defaultAdv = Math.max(100, Math.round((balance * 0.3) / 10) * 10);
      const requestedAdv =
        typeof input.customAdvanceAmount === "number" && input.customAdvanceAmount > 0
          ? Math.round(input.customAdvanceAmount)
          : defaultAdv;
      if (requestedAdv <= 0 || requestedAdv >= balance) {
        throw new HttpError(400, `Part advance must be between ₹1 and ₹${balance - 1}.`);
      }
      amountToCharge = requestedAdv;
      remainingDue = balance - amountToCharge;
    } else if (plan === "repair_remaining") {
      stage = "remaining";
      amountToCharge = balance;
      remainingDue = 0;
    } else {
      stage = "full";
      amountToCharge = balance;
      remainingDue = 0;
    }
  } else if (journey === "swap") {
    totalCasePayable =
      typeof input.overrideTotalAmount === "number" && input.overrideTotalAmount > 0
        ? Math.round(input.overrideTotalAmount)
        : swapTotal ?? 0;
    if (totalCasePayable <= 0) {
      throw new HttpError(400, "Swap customer payable amount is not priced yet. Select an upgrade phone first.");
    }
    const alreadyPaid = summaryBefore.swap.paidAmount;
    const balance = Math.max(0, totalCasePayable - alreadyPaid);
    if (balance <= 0) {
      throw new HttpError(400, "Swap payable amount is already paid in full for this case.");
    }

    amountToCharge = balance;
    remainingDue = 0;

    if (plan === "swap_emi") {
      stage = "emi";
      const tenure = Number(input.emiMonths || 6);
      const plans = computeEmiPlans(amountToCharge);
      const matched = plans.find((p) => p.months === tenure) ?? plans[1] ?? plans[0];
      emiMonths = matched?.months ?? tenure;
      emiMonthlyAmount = matched?.monthlyAmount ?? Math.ceil(amountToCharge / emiMonths);
    } else {
      stage = "full";
    }
  } else {
    throw new HttpError(400, "Invalid payment journey.");
  }

  const cfg = getRazorpayConfig();
  let razorpayOrderId = `order_${newId("rzp").replace(/^rzp_/, "")}`;

  if (cfg.liveKeysConfigured) {
    const authHeader = Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64");
    const orderRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${authHeader}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amountToCharge * 100, // in paise
        currency: "INR",
        receipt: `${c.ref}-${stage}`,
        notes: {
          case_id: c.id,
          case_ref: c.ref,
          journey,
          payment_plan: plan,
          installment_stage: stage,
          emi_months: emiMonths ? String(emiMonths) : "",
        },
      }),
    });

    if (orderRes.ok) {
      const orderJson = (await orderRes.json()) as { id?: string };
      if (orderJson.id) razorpayOrderId = orderJson.id;
    } else {
      const errText = await orderRes.text().catch(() => "");
      throw new HttpError(502, `Razorpay order creation failed (${orderRes.status}): ${errText.slice(0, 180)}`);
    }
  }

  const id = newId("rpay");
  const now = nowIso();
  const cName = (input.customerName || dbName || "").trim() || null;
  const cPhone = (input.customerPhone || dbPhone || "").trim() || null;

  await tx(async () => {
    await execute(
      `INSERT INTO razorpay_payments (
        id, case_id, case_ref, org_id, store_id, journey, payment_plan, installment_stage,
        total_case_payable, amount, remaining_due, emi_months, emi_monthly_amount, currency,
        razorpay_order_id, status, customer_name, customer_phone, notes, created_by, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'INR',$14,'created',$15,$16,$17,$18,$19)`,
      [
        id,
        c.id,
        c.ref,
        c.org_id,
        c.store_id,
        journey,
        plan,
        stage,
        totalCasePayable,
        amountToCharge,
        remainingDue,
        emiMonths,
        emiMonthlyAmount,
        razorpayOrderId,
        cName,
        cPhone,
        JSON.stringify({ live: cfg.liveKeysConfigured }),
        user.id,
        now,
      ]
    );
    await audit({
      userId: user.id,
      orgId: c.org_id,
      storeId: c.store_id,
      action: "razorpay.order.create",
      entity: "razorpay_payment",
      entityId: id,
      detail: {
        caseId: c.id,
        caseRef: c.ref,
        journey,
        paymentPlan: plan,
        stage,
        amount: amountToCharge,
        remainingDue,
        emiMonths,
        razorpayOrderId,
      },
    });
  });

  const payment = (await queryOne<RazorpayPaymentRow>(
    `SELECT * FROM razorpay_payments WHERE id = $1`,
    [id]
  ))!;
  const summary = await getCaseRazorpaySummary(c.id);

  return {
    payment,
    keyId: cfg.keyId,
    liveKeysConfigured: cfg.liveKeysConfigured,
    summary,
  };
}

export async function verifyRazorpayPayment(
  user: SessionUser,
  input: {
    caseId: string;
    razorpayOrderId: string;
    razorpayPaymentId?: string | null;
    razorpaySignature?: string | null;
    paymentMethod?: string | null;
  }
): Promise<{
  payment: RazorpayPaymentRow;
  summary: CaseRazorpaySummary;
}> {
  await ensureRazorpayTable();
  const row = await queryOne<RazorpayPaymentRow>(
    `SELECT * FROM razorpay_payments WHERE razorpay_order_id = $1 AND case_id = $2`,
    [input.razorpayOrderId, input.caseId]
  );
  if (!row) throw new HttpError(404, "Razorpay order not found for this case.");
  if (row.status === "paid") {
    return {
      payment: row,
      summary: await getCaseRazorpaySummary(input.caseId),
    };
  }

  const cfg = getRazorpayConfig();
  const paymentId = (input.razorpayPaymentId || `pay_${newId("rzp").replace(/^rzp_/, "")}`).trim();
  let signature = (input.razorpaySignature || "").trim();

  if (cfg.liveKeysConfigured) {
    if (!signature) {
      throw new HttpError(400, "Missing Razorpay payment signature.");
    }
    const expected = createHmac("sha256", cfg.keySecret)
      .update(`${row.razorpay_order_id}|${paymentId}`)
      .digest("hex");
    if (expected !== signature) {
      throw new HttpError(400, "Razorpay signature verification failed.");
    }
  } else if (!signature) {
    signature = createHmac("sha256", cfg.keySecret)
      .update(`${row.razorpay_order_id}|${paymentId}`)
      .digest("hex");
  }

  const method = (input.paymentMethod || (row.payment_plan === "swap_emi" ? "emi" : "upi")).trim();
  const now = nowIso();

  await tx(async () => {
    await execute(
      `UPDATE razorpay_payments
       SET status = 'paid',
           razorpay_payment_id = $1,
           razorpay_signature = $2,
           payment_method = $3,
           paid_at = $4
       WHERE id = $5`,
      [paymentId, signature, method, now, row.id]
    );
    await audit({
      userId: user.id,
      orgId: row.org_id,
      storeId: row.store_id,
      action: "razorpay.payment.paid",
      entity: "razorpay_payment",
      entityId: row.id,
      detail: {
        caseId: row.case_id,
        caseRef: row.case_ref,
        journey: row.journey,
        paymentPlan: row.payment_plan,
        amount: row.amount,
        remainingDue: row.remaining_due,
        emiMonths: row.emi_months,
        razorpayOrderId: row.razorpay_order_id,
        razorpayPaymentId: paymentId,
        paymentMethod: method,
      },
    });
  });

  const updated = (await queryOne<RazorpayPaymentRow>(
    `SELECT * FROM razorpay_payments WHERE id = $1`,
    [row.id]
  ))!;
  const summary = await getCaseRazorpaySummary(input.caseId);

  return {
    payment: updated,
    summary,
  };
}

const PLAN_LABELS: Record<RazorpayPaymentPlan, string> = {
  repair_part_advance: "Repair · Part Advance",
  repair_remaining: "Repair · Remaining Balance",
  repair_full: "Repair · Full Payment (100%)",
  swap_direct: "Swap Up · Direct Payment",
  swap_emi: "Swap Up · Razorpay EMI",
};

function fmtInr(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return "—";
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

export async function sendCaseReceiptEmail(
  user: SessionUser,
  input: {
    caseId: string;
    toEmail: string;
    paymentId?: string | null;
  }
): Promise<{
  ok: true;
  to: string;
  subject: string;
  sentAt: string;
  deliveryMode: "resend_api" | "recorded";
  html: string;
  text: string;
  summary: CaseRazorpaySummary;
}> {
  await ensureRazorpayTable();
  const to = (input.toEmail || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new HttpError(400, "Enter a valid email address for the receipt.");
  }

  const c = await queryOne<
    CasePricingRow & {
      model_id: string | null;
      variant: string | null;
      imei: string | null;
    }
  >(
    `SELECT id, ref, org_id, store_id, customer, model_id, variant, imei, repair, manual_repair,
            payable, trade_value, bonus_value, premium_value, quote, upgrade
     FROM cases WHERE id = $1`,
    [input.caseId]
  );
  if (!c) throw new HttpError(404, "Case not found.");

  const store = await queryOne<{ name: string; city: string | null; code: string }>(
    `SELECT name, city, code FROM stores WHERE id = $1`,
    [c.store_id]
  );
  const org = await queryOne<{ name: string }>(`SELECT name FROM orgs WHERE id = $1`, [c.org_id]);
  const modelRow = c.model_id
    ? await queryOne<{ brand: string; model: string }>(
        `SELECT brand, model FROM trade_models WHERE id = $1`,
        [c.model_id]
      )
    : null;

  const summary = await getCaseRazorpaySummary(c.id);
  const { repairTotal, swapTotal, customerName, customerPhone } = resolveCaseTotals(c);

  const paidPayments = summary.payments.filter((p) => p.status === "paid");
  const targetPayments = input.paymentId
    ? paidPayments.filter((p) => p.id === input.paymentId || p.razorpay_order_id === input.paymentId)
    : paidPayments;
  const paymentsToShow = targetPayments.length > 0 ? targetPayments : paidPayments;

  const deviceLabel = modelRow
    ? `${modelRow.brand} ${modelRow.model}${c.variant ? ` (${c.variant})` : ""}`
    : c.model_id || "Customer Phone";
  const storeName = store?.name || "SwapUp Experience Centre";
  const storeLoc = [store?.city, store?.code ? `Store Code ${store.code}` : null].filter(Boolean).join(" · ");
  const sentAt = nowIso();
  const dateFormatted = new Date(sentAt).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  let upgradeLabel: string | null = null;
  let upgradePrice: number | null = null;
  try {
    if (c.upgrade) {
      const u = JSON.parse(c.upgrade) as { label?: string; price?: number };
      upgradeLabel = u.label || null;
      upgradePrice = typeof u.price === "number" ? u.price : null;
    }
  } catch {
    // ignore
  }

  const latestPayment = paymentsToShow[0] ?? null;
  const subject = latestPayment
    ? `Payment Receipt · ${c.ref} (${fmtInr(latestPayment.amount)} — ${PLAN_LABELS[latestPayment.payment_plan]})`
    : `SwapUp Receipt · ${c.ref} (${storeName})`;

  const paymentRowsHtml =
    paymentsToShow.length > 0
      ? paymentsToShow
          .map(
            (p) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">
            <div style="font-weight:700;color:#0f172a;">${PLAN_LABELS[p.payment_plan]}</div>
            <div style="font-size:12px;color:#64748b;">
              Order: ${p.razorpay_order_id} · Payment: ${p.razorpay_payment_id || "—"} · ${(p.payment_method || "UPI").toUpperCase()}
              ${p.emi_months ? ` · ${p.emi_months}M EMI (${fmtInr(p.emi_monthly_amount)}/mo)` : ""}
            </div>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;color:#15803d;">
            ${fmtInr(p.amount)}
            ${p.remaining_due > 0 ? `<div style="font-size:11px;color:#b45309;font-weight:600;">Remaining due: ${fmtInr(p.remaining_due)}</div>` : ""}
          </td>
        </tr>`
          )
          .join("")
      : `<tr><td colspan="2" style="padding:10px 12px;color:#64748b;">No online Razorpay payments recorded yet.</td></tr>`;

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <div style="background:#072654;color:#ffffff;padding:20px 24px;display:flex;justify-content:space-between;align-items:flex-start;">
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:0.85;">${org?.name || "SwapUp"}</div>
        <div style="font-size:20px;font-weight:800;margin-top:2px;">${storeName}</div>
        <div style="font-size:13px;opacity:0.9;margin-top:2px;">${storeLoc}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.8px;opacity:0.85;">Official Receipt</div>
        <div style="font-size:16px;font-weight:700;margin-top:2px;">${c.ref}</div>
        <div style="font-size:12px;opacity:0.85;">${dateFormatted}</div>
      </div>
    </div>

    <div style="padding:24px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <tr>
          <td style="width:50%;vertical-align:top;padding-right:12px;">
            <div style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:700;">Customer</div>
            <div style="font-size:15px;font-weight:700;margin-top:4px;">${customerName || "Walk-in Customer"}</div>
            <div style="font-size:13px;color:#475569;">Phone: ${customerPhone || "—"}</div>
            <div style="font-size:13px;color:#475569;">Email: ${to}</div>
          </td>
          <td style="width:50%;vertical-align:top;padding-left:12px;">
            <div style="font-size:11px;text-transform:uppercase;color:#64748b;font-weight:700;">Device</div>
            <div style="font-size:15px;font-weight:700;margin-top:4px;">${deviceLabel}</div>
            ${c.imei ? `<div style="font-size:13px;color:#475569;">IMEI: ${c.imei}</div>` : ""}
            ${upgradeLabel ? `<div style="font-size:13px;color:#0f172a;margin-top:4px;">Upgrade: <strong>${upgradeLabel}</strong> (${fmtInr(upgradePrice)})</div>` : ""}
          </td>
        </tr>
      </table>

      ${
        repairTotal !== null && repairTotal > 0
          ? `<div style="margin-bottom:18px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
              <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#475569;margin-bottom:6px;">Repair Bill Summary</div>
              <div style="display:flex;justify-content:space-between;font-size:14px;">
                <span>Total Repair Quote: <strong>${fmtInr(repairTotal)}</strong></span>
                <span>Paid via Razorpay: <strong style="color:#15803d;">${fmtInr(summary.repair.paidAmount)}</strong></span>
                <span>Remaining Balance: <strong style="color:#b45309;">${fmtInr(summary.repair.remainingBalance)}</strong></span>
              </div>
            </div>`
          : ""
      }

      ${
        swapTotal !== null && swapTotal > 0
          ? `<div style="margin-bottom:18px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
              <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#475569;margin-bottom:6px;">Swap / Upgrade Summary</div>
              <div style="display:flex;justify-content:space-between;font-size:14px;">
                <span>Net Upgrade Payable: <strong>${fmtInr(swapTotal)}</strong></span>
                <span>Paid via Razorpay: <strong style="color:#15803d;">${fmtInr(summary.swap.paidAmount)}</strong></span>
                <span>Balance Due: <strong>${fmtInr(summary.swap.remainingBalance)}</strong></span>
              </div>
            </div>`
          : ""
      }

      <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:#475569;margin-bottom:8px;">Razorpay Payment Transactions</div>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f1f5f9;text-align:left;font-size:12px;color:#475569;">
            <th style="padding:8px 12px;">Payment Plan & Reference</th>
            <th style="padding:8px 12px;text-align:right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${paymentRowsHtml}
        </tbody>
      </table>

      <div style="margin-top:20px;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:12px;">
        Thank you for visiting ${storeName}. Keep case reference <strong>${c.ref}</strong> for any queries.
      </div>
    </div>
  </div>
</body>
</html>`;

  const textLines = [
    `${storeName} (${storeLoc})`,
    `Receipt for Case: ${c.ref}`,
    `Date: ${dateFormatted}`,
    `Customer: ${customerName || "Walk-in Customer"} (${customerPhone || "—"})`,
    `Device: ${deviceLabel}`,
    repairTotal ? `Repair Total: ${fmtInr(repairTotal)} | Paid: ${fmtInr(summary.repair.paidAmount)} | Remaining: ${fmtInr(summary.repair.remainingBalance)}` : null,
    swapTotal ? `Swap Net Payable: ${fmtInr(swapTotal)} | Paid: ${fmtInr(summary.swap.paidAmount)} | Remaining: ${fmtInr(summary.swap.remainingBalance)}` : null,
    "",
    "Razorpay Payments:",
    ...paymentsToShow.map(
      (p) =>
        `- ${PLAN_LABELS[p.payment_plan]}: ${fmtInr(p.amount)}${
          p.emi_months ? ` (${p.emi_months}M EMI @ ${fmtInr(p.emi_monthly_amount)}/mo)` : ""
        }${p.remaining_due > 0 ? ` | Remaining Due: ${fmtInr(p.remaining_due)}` : ""} [Order: ${p.razorpay_order_id} / Payment: ${p.razorpay_payment_id || "—"}]`
    ),
  ].filter(Boolean);
  const text = textLines.join("\n");

  let deliveryMode: "resend_api" | "recorded" = "recorded";
  const resendKey = (process.env.RESEND_API_KEY || "").trim();
  const fromEmail = (process.env.RECEIPT_FROM_EMAIL || "SwapUp Receipts <onboarding@resend.dev>").trim();

  if (resendKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [to],
          subject,
          html,
          text,
        }),
      });
      if (res.ok) {
        deliveryMode = "resend_api";
      }
    } catch {
      // Fallback to recorded mode if network call fails
    }
  }

  await tx(async () => {
    for (const p of paymentsToShow) {
      let parsedNotes: Record<string, unknown> = {};
      try {
        if (p.notes) parsedNotes = JSON.parse(p.notes) as Record<string, unknown>;
      } catch {
        // ignore
      }
      parsedNotes.emailedTo = to;
      parsedNotes.emailedAt = sentAt;
      await execute(`UPDATE razorpay_payments SET notes = $1 WHERE id = $2`, [
        JSON.stringify(parsedNotes),
        p.id,
      ]);
    }

    await audit({
      userId: user.id,
      orgId: c.org_id,
      storeId: c.store_id,
      action: "receipt.email.sent",
      entity: "case",
      entityId: c.id,
      detail: {
        caseRef: c.ref,
        to,
        subject,
        paymentId: input.paymentId ?? null,
        deliveryMode,
        sentAt,
      },
    });
  });

  const updatedSummary = await getCaseRazorpaySummary(c.id);
  return {
    ok: true,
    to,
    subject,
    sentAt,
    deliveryMode,
    html,
    text,
    summary: updatedSummary,
  };
}

