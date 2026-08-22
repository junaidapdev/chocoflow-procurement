-- ─────────────────────────────────────────────────────────────────────────────
-- Payment date & bank account
--
-- Run this ONCE against your existing Supabase project (SQL Editor → paste →
-- Run). Safe to re-run: every statement is guarded, and the backfills only
-- touch rows that are still NULL.
--
-- ⚠️  Apply together with the matching application code — it changes the
--     signature of record_invoice_payment(), which the receipts API calls.
--
-- WHY THIS EXISTS
-- Until now nothing recorded when a payment actually happened. Every dashboard
-- showed `updated_at` under a "Paid Date" heading, but an UPDATE trigger bumps
-- that column on every write — so clicking "Notify Vendor" days later silently
-- moved the payment date forward. payment_date is entered by the payer and is
-- never touched again.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. New columns ──────────────────────────────────────────────────────────
-- payment_date     — the day money actually left the bank, typed by the payer.
--                    DATE (not a timestamp) because it reconciles against bank
--                    statements, which settle per day.
-- bank_account     — last 4 digits of the company account used. We store only
--                    the last 4 on purpose; full account numbers have no reason
--                    to be in this database. Deliberately NOT a CHECK
--                    constraint — the valid set lives in src/lib/constants.ts
--                    so accounts can be added without a migration (the same way
--                    BRANCHES works).
-- payment_batch_id — one bank transfer usually covers several invoices. Today
--                    a batch is only implied by a shared receipt_url. This gives
--                    it a real id, so per-transfer reporting (and promoting
--                    batches to their own table later) is a GROUP BY, not a
--                    forensic exercise.

ALTER TABLE public.invoices
    ADD COLUMN IF NOT EXISTS payment_date DATE,
    ADD COLUMN IF NOT EXISTS bank_account TEXT,
    ADD COLUMN IF NOT EXISTS payment_batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_invoices_payment_date
    ON public.invoices(payment_date DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_payment_batch
    ON public.invoices(payment_batch_id);


-- ── 2. record_invoice_payment(): now records date, account and batch ────────
-- Adding parameters creates an OVERLOAD rather than replacing the function, and
-- PostgREST then cannot tell which one an RPC call means. Drop the old 3-arg
-- version explicitly first.

DROP FUNCTION IF EXISTS public.record_invoice_payment(uuid[], uuid[], text);

CREATE OR REPLACE FUNCTION public.record_invoice_payment(
    p_invoice_ids  uuid[],
    p_return_ids   uuid[],
    p_receipt_url  text,
    p_payment_date date,
    p_bank_account text,
    p_batch_id     uuid
) RETURNS void AS $$
DECLARE
    v_expected_invoices int  := coalesce(array_length(p_invoice_ids, 1), 0);
    v_expected_returns  int  := coalesce(array_length(p_return_ids, 1), 0);
    v_today             date := (now() AT TIME ZONE 'Asia/Riyadh')::date;
    v_updated           int;
BEGIN
    IF v_expected_invoices = 0 THEN
        RAISE EXCEPTION 'At least one invoice is required';
    END IF;

    IF p_payment_date IS NULL THEN
        RAISE EXCEPTION 'Payment date is required';
    END IF;

    -- Compared in Riyadh time, not UTC. A payer entering "today" at 1am local
    -- is still on yesterday's UTC date, and a naive check would reject it.
    IF p_payment_date > v_today THEN
        RAISE EXCEPTION 'Payment date % cannot be in the future (today is % in Riyadh)',
            p_payment_date, v_today;
    END IF;

    IF p_bank_account IS NULL OR btrim(p_bank_account) = '' THEN
        RAISE EXCEPTION 'Bank account is required';
    END IF;

    -- Return credits get the payment date and batch, but never a bank account:
    -- applying a credit moves no money out of any account, so tagging one would
    -- inflate per-account payout totals.
    IF v_expected_returns > 0 THEN
        UPDATE public.invoices
            SET status                = 'Paid',
                applied_to_invoice_id = p_invoice_ids[1],
                payment_date          = p_payment_date,
                payment_batch_id      = p_batch_id
            WHERE id = ANY(p_return_ids)
              AND type = 'return'
              AND status = 'Approved'
              AND applied_to_invoice_id IS NULL;
        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated <> v_expected_returns THEN
            RAISE EXCEPTION 'Expected to apply % return credit(s) but matched %',
                v_expected_returns, v_updated;
        END IF;
    END IF;

    UPDATE public.invoices
        SET status           = 'Paid',
            receipt_url      = p_receipt_url,
            payment_date     = p_payment_date,
            bank_account     = p_bank_account,
            payment_batch_id = p_batch_id
        WHERE id = ANY(p_invoice_ids)
          AND type = 'invoice'
          AND status = 'ReadyToPay';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> v_expected_invoices THEN
        RAISE EXCEPTION 'Expected to pay % invoice(s) but matched %',
            v_expected_invoices, v_updated;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ── 3. Backfill: payment_batch_id ───────────────────────────────────────────
-- Everything paid in one transfer shares a receipt_url, so that groups a batch.

WITH batches AS (
    SELECT receipt_url, gen_random_uuid() AS batch_id
    FROM public.invoices
    WHERE status = 'Paid'
      AND type = 'invoice'
      AND receipt_url IS NOT NULL
      AND payment_batch_id IS NULL
    GROUP BY receipt_url
)
UPDATE public.invoices inv
SET payment_batch_id = b.batch_id
FROM batches b
WHERE inv.receipt_url = b.receipt_url
  AND inv.status = 'Paid'
  AND inv.type = 'invoice'
  AND inv.payment_batch_id IS NULL;

UPDATE public.invoices ret
SET payment_batch_id = inv.payment_batch_id
FROM public.invoices inv
WHERE ret.type = 'return'
  AND ret.status = 'Paid'
  AND ret.payment_batch_id IS NULL
  AND ret.applied_to_invoice_id = inv.id
  AND inv.payment_batch_id IS NOT NULL;


-- ── 4. Backfill: payment_date from the audit trail ──────────────────────────
-- A completed payment writes a `payment.batch_completed` audit row whose
-- created_at is the real moment of payment and whose metadata lists the invoice
-- ids. That is an accurate source; `updated_at` is not.
--
-- audit_logs may not exist: it ships in schema.sql, which is the fresh-install
-- script, so a project created before that section was added never got the
-- table. The whole step is therefore optional — without it, step 5 below is the
-- only source of historical dates. Guarded rather than assumed, so this file
-- runs on any vintage of the database.

DO $do$
BEGIN
    IF to_regclass('public.audit_logs') IS NULL THEN
        RAISE NOTICE 'audit_logs not found - skipping the audit-trail backfill. Historical payment dates will come only from step 5.';
        RETURN;
    END IF;

    -- Two guards inside, because a migration that aborts halfway is worse than
    -- one that skips a row:
    --   * the CASE keeps jsonb_array_elements_text away from any non-array
    --     value - it lives in the FROM clause, so it runs BEFORE the WHERE
    --     could filter it out, and a scalar would raise "cannot extract
    --     elements from a scalar";
    --   * MATERIALIZED fences the regex filter so the ::uuid cast can never be
    --     planned ahead of it.
    EXECUTE $backfill$
        WITH payment_events AS MATERIALIZED (
            SELECT
                elem.value AS invoice_id_text,
                al.created_at
            FROM public.audit_logs al
            CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE
                    WHEN jsonb_typeof(al.metadata->'invoice_ids') = 'array'
                    THEN al.metadata->'invoice_ids'
                    ELSE '[]'::jsonb
                END
            ) AS elem(value)
            WHERE al.action = 'payment.batch_completed'
              AND al.outcome = 'success'
              AND elem.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ),
        first_payment AS (
            SELECT DISTINCT ON (invoice_id_text)
                invoice_id_text::uuid AS invoice_id,
                (created_at AT TIME ZONE 'Asia/Riyadh')::date AS paid_date
            FROM payment_events
            ORDER BY invoice_id_text, created_at ASC
        )
        UPDATE public.invoices inv
        SET payment_date = fp.paid_date
        FROM first_payment fp
        WHERE inv.id = fp.invoice_id
          AND inv.status = 'Paid'
          AND inv.payment_date IS NULL;
    $backfill$;
END
$do$;


-- ── 5. Backfill: payments with no audit row ─────────────────────────────────
-- For a Paid invoice that was never notified, nothing has written to the row
-- since the payment itself - so updated_at IS the payment timestamp, exactly.
-- Rows that WERE notified are left NULL rather than filled with a date we know
-- is contaminated; the dashboards render those as "-".
--
-- If the notification columns don't exist either, then nothing was ever
-- notified and updated_at is exact for every Paid row - so the filter is
-- dropped rather than the step skipped.

DO $do$
DECLARE
    v_has_notify_cols boolean := (
        SELECT count(*) = 2
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'invoices'
          AND column_name IN ('vendor_notified_at', 'salam_notified_at')
    );
BEGIN
    EXECUTE format($backfill$
        UPDATE public.invoices
        SET payment_date = (updated_at AT TIME ZONE 'Asia/Riyadh')::date
        WHERE status = 'Paid'
          AND type = 'invoice'
          AND payment_date IS NULL
          AND updated_at IS NOT NULL
          %s;
    $backfill$,
    CASE
        WHEN v_has_notify_cols
        THEN 'AND vendor_notified_at IS NULL AND salam_notified_at IS NULL'
        ELSE ''
    END);
END
$do$;

UPDATE public.invoices ret
SET payment_date = inv.payment_date
FROM public.invoices inv
WHERE ret.type = 'return'
  AND ret.status = 'Paid'
  AND ret.payment_date IS NULL
  AND ret.applied_to_invoice_id = inv.id
  AND inv.payment_date IS NOT NULL;

-- Historical bank accounts cannot be recovered — no record of them exists.
-- They stay NULL and display as "Not recorded".
