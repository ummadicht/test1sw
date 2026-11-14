/**
 * Role-Based Access Control (RBAC), Store Manager Approval Workflow, Immutable Payout Ledger,
 * and Razorpay Payouts + Webhooks test suite.
 *
 * Run: node --test --experimental-strip-types --no-warnings lib/server/payouts.server.test.ts
 */
import "./testing/register.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "swapup-payouts-"));
process.env.SWAPUP_DB = join(dir, "test.db");
process.env.GRADEIQ_ENABLED = "0";
for (const k of Object.keys(process.env)) {
  if (k.startsWith("PRICEIQ_") || k.startsWith("RAZORPAY_")) delete process.env[k];
}

const origLog = console.log;
console.log = () => {};
const { ensureSeeded } = await import("./seed.ts");
await ensureSeeded();
const { db } = await import("./db.ts");
const { creditSummary } = await import("./credit.ts");
const cases = await import("./cases.ts");
const { getCaseForViewer } = await import("./counter-extra.ts");
const { uploadRateCard } = await import("./catalog.ts");
const { DEFECT_DEDUCTIONS } = await import("../domain/ratecard.ts");
const { luhnCheckDigit } = await import("../domain/imei.ts");
const {
  createPayoutRequest,
  approvePayoutRequest,
  rejectPayoutRequest,
  listPayoutRequests,
  getStoreBalanceForManager,
} = await import("./payouts.ts");
const { handleRazorpayWebhook } = await import("./razorpay.ts");

after(() => {
  console.log = origLog;
  rmSync(dir, { recursive: true, force: true });
});

type U = import("./auth.ts").SessionUser;
const userNamed = (username: string): U => {
  const r = db()
    .prepare(`SELECT id, username, name, role, org_id, store_id FROM users WHERE username = ?`)
    .get(username) as {
    id: string;
    username: string;
    name: string;
    role: U["role"];
    org_id: string;
    store_id: string | null;
  };
  return {
    id: r.id,
    username: r.username,
    name: r.name,
    role: r.role,
    orgId: r.org_id,
    storeId: r.store_id,
    exp: Date.now() + 3_600_000,
  };
};

const adv = userNamed("advisor");
const mgr = userNamed("manager");
const partner = userNamed("partner");
const S26U_256 = (
  db()
    .prepare(`SELECT id FROM new_devices WHERE org_id = ? AND model = 'Galaxy S26 Ultra' AND variant = '256GB'`)
    .get(adv.orgId) as { id: string }
).id;

const ZERO = JSON.parse(
  JSON.stringify(DEFECT_DEDUCTIONS, (_k, v) => (typeof v === "number" ? 0 : v))
) as typeof DEFECT_DEDUCTIONS;

await uploadRateCard(partner, {
  label: "Oct Payout Test Card",
  effectiveFrom: "2026-10-05",
  quoteValidityDays: 7,
  csv: "model_id,variant,max_price,good_price,fair_price,best_value_price\ngalaxy-s23-ultra,256GB,40000,30000,25000,20000\n",
  deductions: ZERO,
  activate: true,
});

let imeiSeq = 0;
const nextImei = () => {
  const body = `3539501${String(2000000 + ++imeiSeq * 7).slice(-7)}`;
  return body + String(luhnCheckDigit(body));
};

async function createPricedCase(creator: U = adv) {
  const created = await cases.createCase(creator, {
    customerName: "Aarav Sharma",
    customerPhone: "9876543210",
  });
  const updated = await cases.updateCase(creator, created.id, {
    modelId: "galaxy-s23-ultra",
    variant: "256GB",
    imei: nextImei(),
    faults: ["screen_cracked"],
    condition: {
      powersOn: true,
      calls: true,
      screen: "cracked",
      body: "dented",
      issues: [],
      accessories: { charger: true, box: false, bill: false },
      age: "gt11m",
    },
    upgradeDeviceId: S26U_256,
  });
  return updated;
}

test("RBAC: store counter login (advisor) cannot see store balance in creditSummary, getStoreBalanceForManager, or getCaseForViewer", async () => {
  const c = await createPricedCase(adv);
  assert.ok(c.storeId);

  // 1. creditSummary throws 403 for advisor
  await assert.rejects(
    async () => creditSummary(adv, c.storeId),
    (err: Error & { status?: number }) => err.status === 403
  );

  // 2. getStoreBalanceForManager throws 403 for advisor
  await assert.rejects(
    async () => getStoreBalanceForManager(adv, c.storeId),
    (err: Error & { status?: number }) => err.status === 403
  );

  // 3. Store manager CAN view available balance
  const mgrBal = await getStoreBalanceForManager(mgr, c.storeId);
  assert.equal(typeof mgrBal.availableBalance, "number");
  assert.ok(mgrBal.availableBalance > 0);

  // 4. getCaseForViewer strips creditCheck for advisor, but keeps it for store_manager
  const advView = await getCaseForViewer(adv, c.id);
  assert.equal(advView.creditCheck, null, "advisor must not receive creditCheck / availableAfter");
  const advJson = JSON.stringify(advView);
  assert.ok(!advJson.includes("availableAfter"), "availableAfter must be stripped server-side for advisor");

  const mgrView = await getCaseForViewer(mgr, c.id);
  assert.ok(mgrView.creditCheck !== null, "store_manager receives creditCheck");
  assert.equal(typeof mgrView.creditCheck?.availableAfter, "number");
});

test("Customer payout flow: counter creates PENDING_APPROVAL request (idempotent), balance is stripped for counter, and manager sees balanceBefore & balanceAfter", async () => {
  const c = await createPricedCase(adv);
  const idemKey = "idem-counter-req-001";

  const req1 = await createPayoutRequest(adv, {
    caseId: c.id,
    amount: 26_000,
    payoutMode: "upi",
    fundAccountUpi: "aarav@okicici",
    customerName: "Aarav Sharma",
    customerPhone: "9876543210",
    idempotencyKey: idemKey,
  });

  assert.equal(req1.status, "PENDING_APPROVAL");
  assert.equal(req1.amount, 26_000);
  assert.equal("balanceBefore" in req1, false, "counter response must not contain balanceBefore");
  assert.equal("balanceAfter" in req1, false, "counter response must not contain balanceAfter");

  // Retry with the same idempotencyKey -> returns exact same request without duplicate
  const req1Retry = await createPayoutRequest(adv, {
    caseId: c.id,
    amount: 26_000,
    payoutMode: "upi",
    fundAccountUpi: "aarav@okicici",
    idempotencyKey: idemKey,
  });
  assert.equal(req1Retry.id, req1.id, "idempotency key prevents duplicate payout requests");

  // Counter listPayoutRequests strips storeBalance and ledger
  const advList = await listPayoutRequests(adv, { storeId: c.storeId });
  assert.equal("storeBalance" in advList, false, "advisor list response must not include storeBalance");
  assert.equal("ledger" in advList, false, "advisor list response must not include ledger");
  assert.equal("balanceBefore" in advList.payouts[0], false);

  // Manager listPayoutRequests includes storeBalance, balanceBefore, balanceAfter, and pendingCount
  const mgrList = await listPayoutRequests(mgr, { storeId: c.storeId });
  assert.ok(mgrList.storeBalance, "manager receives storeBalance");
  assert.ok(mgrList.pendingCount >= 1);
  const mgrItem = mgrList.payouts.find((p) => p.id === req1.id) as import("./payouts.ts").ManagerPayoutView;
  assert.ok(mgrItem);
  assert.equal(mgrItem.balanceBefore, mgrList.storeBalance!.availableBalance);
  assert.equal(mgrItem.balanceAfter, mgrList.storeBalance!.availableBalance - 26_000);
});

test("RBAC & Security: counter user cannot approve or reject; manager cannot self-approve their own payout request", async () => {
  const c = await createPricedCase(adv);

  // Counter creates a request
  const counterReq = await createPayoutRequest(adv, {
    caseId: c.id,
    amount: 15_000,
    payoutMode: "upi",
    fundAccountUpi: "customer@upi",
    idempotencyKey: "idem-rbac-check-001",
  });

  // Counter user tries to approve -> 403
  await assert.rejects(
    async () => approvePayoutRequest(adv, counterReq.id),
    (err: Error & { status?: number }) => err.status === 403
  );

  // Counter user tries to reject -> 403
  await assert.rejects(
    async () => rejectPayoutRequest(adv, counterReq.id, "Trying to reject"),
    (err: Error & { status?: number }) => err.status === 403
  );

  // Manager creates a payout request themselves
  const mgrCreatedReq = await createPayoutRequest(mgr, {
    caseId: c.id,
    amount: 18_000,
    payoutMode: "upi",
    fundAccountUpi: "mgrcustomer@upi",
    idempotencyKey: "idem-mgr-self-001",
  });

  // Same manager tries to approve their own request -> 403 self-approval blocked
  await assert.rejects(
    async () => approvePayoutRequest(mgr, mgrCreatedReq.id),
    (err: Error & { status?: number }) =>
      err.status === 403 && /cannot approve a payout request that they created/i.test(err.message)
  );

  const selfAudit = db()
    .prepare(`SELECT detail FROM audit WHERE action = 'payout.approval.self_blocked' AND entity_id = ?`)
    .get(mgrCreatedReq.id) as { detail: string } | undefined;
  assert.ok(selfAudit, "self-approval block is recorded in audit log");
});

test("Rejection workflow: sets status to REJECTED, records reason, notifies counter user, and moves no money", async () => {
  const c = await createPricedCase(adv);
  const balBefore = (await getStoreBalanceForManager(mgr, c.storeId)).availableBalance;

  const req = await createPayoutRequest(adv, {
    caseId: c.id,
    amount: 24_000,
    payoutMode: "upi",
    fundAccountUpi: "wronghandle@upi",
    idempotencyKey: "idem-reject-flow-001",
  });

  const rejected = await rejectPayoutRequest(mgr, req.id, "UPI VPA name mismatch with customer ID");
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.rejectionReason, "UPI VPA name mismatch with customer ID");

  const balAfter = (await getStoreBalanceForManager(mgr, c.storeId)).availableBalance;
  assert.equal(balAfter, balBefore, "no money moves on rejection");

  // Counter user sees rejection status and reason, still without store balance
  const advList = await listPayoutRequests(adv, { caseId: c.id });
  const advItem = advList.payouts.find((p) => p.id === req.id)!;
  assert.equal(advItem.status, "REJECTED");
  assert.equal(advItem.rejectionReason, "UPI VPA name mismatch with customer ID");
  assert.equal("balanceBefore" in advItem, false);
});

test("Approval workflow: triggers Razorpay payout, marks COMPLETED, debits store balance, writes immutable ledger entry, and logs audit", async () => {
  const c = await createPricedCase(adv);
  const beforeBal = (await getStoreBalanceForManager(mgr, c.storeId)).availableBalance;

  const req = await createPayoutRequest(adv, {
    caseId: c.id,
    amount: 26_000,
    payoutMode: "upi",
    fundAccountUpi: "aarav.verified@okaxis",
    idempotencyKey: "idem-approve-success-001",
  });

  const completed = await approvePayoutRequest(mgr, req.id, { simulateOutcome: "processed" });
  assert.equal(completed.status, "COMPLETED");
  assert.ok(completed.razorpayPayoutId?.startsWith("pout_"));
  assert.equal(completed.balanceBefore, beforeBal);
  assert.equal(completed.balanceAfter, beforeBal - 26_000);

  // Store balance is debited in both getStoreBalanceForManager and creditSummary
  const afterBal = (await getStoreBalanceForManager(mgr, c.storeId)).availableBalance;
  assert.equal(afterBal, beforeBal - 26_000);
  const cs = await creditSummary(mgr, c.storeId);
  assert.equal(cs.position.available, beforeBal - 26_000);

  // Immutable ledger entry exists and cannot be updated or deleted
  const ledgerRow = db()
    .prepare(`SELECT * FROM payout_ledger WHERE payout_id = ? AND entry_type = 'DEBIT'`)
    .get(req.id) as { amount: number; balance_before: number; balance_after: number } | undefined;
  assert.ok(ledgerRow, "DEBIT ledger row written");
  assert.equal(ledgerRow.amount, 26_000);
  assert.equal(ledgerRow.balance_before, beforeBal);
  assert.equal(ledgerRow.balance_after, beforeBal - 26_000);

  assert.throws(
    () => db().prepare(`UPDATE payout_ledger SET amount = 1 WHERE payout_id = ?`).run(req.id),
    /immutable/i,
    "payout_ledger must reject UPDATE"
  );
  assert.throws(
    () => db().prepare(`DELETE FROM payout_ledger WHERE payout_id = ?`).run(req.id),
    /immutable/i,
    "payout_ledger must reject DELETE"
  );

  // Audit log entries record userId, role, timestamp, and amount
  const audits = db()
    .prepare(`SELECT action, user_id, detail FROM audit WHERE entity_id = ? ORDER BY id`)
    .all(req.id) as { action: string; user_id: string; detail: string }[];
  const actions = audits.map((a) => a.action);
  assert.ok(actions.includes("payout.request.created"));
  assert.ok(actions.includes("payout.request.approved"));
  assert.ok(actions.includes("payout.razorpay.attempt"));
  assert.ok(actions.includes("payout.completed"));
  for (const a of audits) {
    const d = JSON.parse(a.detail) as { userId: string; role: string; timestamp: string; amount: number };
    assert.ok(d.userId);
    assert.ok(d.role);
    assert.ok(d.timestamp);
    assert.equal(d.amount, 26_000);
  }
});

test("Processing, Failure & Webhook handling (payout.processed, payout.failed, payout.reversed) with idempotency", async () => {
  const c = await createPricedCase(adv);
  const startBal = (await getStoreBalanceForManager(mgr, c.storeId)).availableBalance;

  // 1. Payout returns PROCESSING -> balance is NOT debited until webhook confirms
  const reqProc = await createPayoutRequest(adv, {
    caseId: c.id,
    amount: 20_000,
    payoutMode: "imps",
    fundAccountNumber: "123456789012",
    fundAccountIfsc: "HDFC0001234",
    idempotencyKey: "idem-webhook-proc-001",
  });

  const procView = await approvePayoutRequest(mgr, reqProc.id, { simulateOutcome: "processing" });
  assert.equal(procView.status, "PROCESSING");
  assert.ok(procView.managerAlert, "manager is alerted on processing status");
  assert.equal(
    (await getStoreBalanceForManager(mgr, c.storeId)).availableBalance,
    startBal,
    "balance must NOT be debited while PROCESSING"
  );

  // 2. Webhook `payout.processed` arrives -> marks COMPLETED and debits balance once
  const webhookProcessedPayload = JSON.stringify({
    event: "payout.processed",
    payload: {
      payout: {
        entity: {
          id: procView.razorpayPayoutId,
          status: "processed",
          notes: { payout_request_id: reqProc.id },
        },
      },
    },
  });

  const wh1 = await handleRazorpayWebhook(webhookProcessedPayload, null);
  assert.equal(wh1.payoutStatus, "COMPLETED");
  assert.equal(wh1.idempotent, false);
  assert.equal(
    (await getStoreBalanceForManager(mgr, c.storeId)).availableBalance,
    startBal - 20_000,
    "balance debited on payout.processed webhook"
  );

  // Duplicate `payout.processed` webhook -> idempotent, no second debit
  const wh1Dup = await handleRazorpayWebhook(webhookProcessedPayload, null);
  assert.equal(wh1Dup.payoutStatus, "COMPLETED");
  assert.equal(wh1Dup.idempotent, true);
  assert.equal(
    (await getStoreBalanceForManager(mgr, c.storeId)).availableBalance,
    startBal - 20_000,
    "duplicate webhook must not double-debit balance"
  );

  // 3. Webhook `payout.reversed` arrives -> marks REVERSED, writes REVERSAL ledger entry, restores balance
  const webhookReversedPayload = JSON.stringify({
    event: "payout.reversed",
    payload: {
      payout: {
        entity: {
          id: procView.razorpayPayoutId,
          status: "reversed",
          failure_reason: "Beneficiary bank returned IMPS transfer",
          notes: { payout_request_id: reqProc.id },
        },
      },
    },
  });

  const whRev = await handleRazorpayWebhook(webhookReversedPayload, null);
  assert.equal(whRev.payoutStatus, "REVERSED");
  assert.equal(whRev.idempotent, false);
  assert.equal(
    (await getStoreBalanceForManager(mgr, c.storeId)).availableBalance,
    startBal,
    "store balance restored after payout.reversed webhook"
  );

  // Duplicate `payout.reversed` webhook -> idempotent
  const whRevDup = await handleRazorpayWebhook(webhookReversedPayload, null);
  assert.equal(whRevDup.idempotent, true);
  assert.equal((await getStoreBalanceForManager(mgr, c.storeId)).availableBalance, startBal);

  // 4. Failed payout -> does not debit balance, alerts manager, and `payout.failed` webhook is idempotent
  const reqFail = await createPayoutRequest(adv, {
    caseId: c.id,
    amount: 12_000,
    payoutMode: "upi",
    fundAccountUpi: "fail@upi",
    idempotencyKey: "idem-webhook-fail-001",
  });
  const failView = await approvePayoutRequest(mgr, reqFail.id, { simulateOutcome: "failed" });
  assert.equal(failView.status, "FAILED");
  assert.ok(failView.managerAlert);
  assert.equal((await getStoreBalanceForManager(mgr, c.storeId)).availableBalance, startBal);

  const webhookFailedPayload = JSON.stringify({
    event: "payout.failed",
    payload: {
      payout: {
        entity: {
          id: failView.razorpayPayoutId,
          status: "failed",
          failure_reason: "UPI handle invalid",
          notes: { payout_request_id: reqFail.id },
        },
      },
    },
  });
  const whFail = await handleRazorpayWebhook(webhookFailedPayload, null);
  assert.equal(whFail.payoutStatus, "FAILED");
  assert.equal(whFail.idempotent, true);
});
