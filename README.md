# SwapUp

**Repair it, or swap up?** An in-store desk for Samsung service centres — and any client's
experience centres — that puts the repair quote and the trade-in value side by side, gives
an honest recommendation, and turns the upgrade into a new Samsung with a 2–5% bonus. Every
store's trade-in exposure is kept inside a credit limit until the buyback partner
(Cashify) collects or clears the phones.

## The flow

1. **Counter** (`/desk`, `/cases/:id`) — the advisor records the phone (model, storage,
   IMEI, warranty / Care+ cover) and what is wrong with it. The faults drive both the
   repair quote and the trade-in condition, so the two can never disagree.
2. **Repair quote** — Samsung India's published spare-part price for the part that fixes
   the fault, plus the published labour charge for the model's tier, plus GST. Faults with
   no published price (liquid, no power, charging port on most models) need the centre's own
   bench quote — the app never guesses one.
3. **Trade-in value** — from the buyback partner: its live API when connected, otherwise
   the amount and reference code read off the partner's own app, otherwise its uploaded
   rate card. A built-in **sample** card exists only for demos and is labelled everywhere.
4. **Decision** — repair vs upgrade, with the rules that fired (the 50% rule against the
   new phone's price, repair vs resale value, update support, age). The upgrade bonus is
   shown but never counted as a reason; a covered repair is always "repair".
5. **Upgrade** — the customer picks a new Samsung; the bonus campaign (2–5% of the new
   price, clamped, optionally capped) is applied; the trade-in is **locked**: value held on
   the store's credit line, receipt and device tag printed.
6. **Pickup** (`/store`, `/pickups/:id`, `/partner`) — the store books a pickup, the
   partner schedules and collects (handover named on both sides), inspects each phone
   (cleared / regraded / rejected / not received) and settles. The credit line frees up at
   collection or clearance (per client), and any shortfall comes back as a chargeback.
7. **Programme** (`/admin`) — stores and credit limits, bonus campaigns, catalogue and
   repair price book, programme settings, bonus-claim export for the brand.

## Where the numbers come from

| Number | Source |
|---|---|
| Repair part prices | Samsung India "Mobile Spare Part Cost" page, read 2026-10-15 (excl. GST and labour; premium colour / max storage) — `scripts/research-samsung-spare-parts-2026-10-15.csv` |
| Labour per job | Samsung India out-of-warranty repair charges: Galaxy Z ₹525, S ₹425, others ₹350 (L2, taxes extra) |
| Care+ plan fee | Samsung Care+ smartphone terms (ADLD processing fee per repair, tax incl.) where published per model; otherwise the programme default |
| New phone prices | samsung.com/in selling prices, read 2026-10-15 — `scripts/research-samsung-lineup-2026-10-15.csv` |
| Trade-in values | the partner (live API / app reading / rate card). The demo **sample** card is illustrative only |
| Update support | release year + Samsung's update policy per series (approximate; check Samsung's security-update page) |

Regenerate the seed after refreshing the snapshots: `python3 scripts/build-seed-data.py`.

## Connecting Cashify

Cashify publishes no partner API. Until a contract exists, stores use one of:

- **Read the quote off the Cashify app** — on the case, "Enter the quote from the Cashify
  app": amount + reference code (+ optional repaired-condition value). Expires after the
  stated days; any change to the device description clears it.
- **Rate card** — the partner's operations team uploads its sheet (`model_id,variant,max_price`)
  on `/partner/rate-cards`; SwapUp applies the card's condition deductions.
- **Live API** — `lib/server/buyback.ts` `liveQuote()` is the only place SwapUp talks to the
  partner. Set `CASHIFY_API_BASE`, `CASHIFY_PARTNER_ID`, `CASHIFY_API_KEY`, and — only after
  the request/response mapping has been checked against Cashify's document —
  `CASHIFY_CONTRACT_CONFIRMED=1`.

## Run

```bash
npm install
npm run dev        # http://localhost:4500 — seeds a demo programme on first request
npm test           # domain tests (node type-stripping, no build)
npx tsc --noEmit
```

Demo accounts (password `swapup2026`, override with `SWAPUP_DEMO_PASSWORD` before first
boot): `advisor`, `manager`, `samsung` (programme admin), `cashify` (partner), `platform`;
`advisor.kor` / `manager.kor`; `xc.admin` / `xc.manager` / `xc.advisor`.

## Deploy

`bash deploy/deploy.sh` — builds locally in a clean copy (webpack), ships to the
denovo-erp VM, installs production dependencies there, runs pm2 `swapup` on :4500 and
adds the Caddy site `swapup.104-197-168-25.sslip.io`. The session secret lives in
`/etc/swapup.env` on the VM, minted once and reused.
