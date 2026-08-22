-- ─────────────────────────────────────────────────────────────────────────────
-- REPAIR: payment dates stamped with the migration date
--
-- ONLY run this if you already applied the FIRST version of
-- 20260822_payment_date_and_bank_account.sql. A database that has not run that
-- file yet needs nothing from here — the corrected migration is now safe on its
-- own.
--
-- WHAT WENT WRONG
-- That version backfilled payment_batch_id BEFORE reading updated_at to recover
-- historical payment dates. public.invoices has a BEFORE UPDATE trigger
-- (update_invoices_updated_at) that resets updated_at to now() on any write, so
-- the batch-id backfill overwrote the very timestamps the next step then read.
-- Every date it "recovered" is the date the migration ran.
--
-- The original updated_at values are gone — overwritten in place. Unless you
-- restore from a Supabase backup / point-in-time recovery, those true payment
-- dates are not recoverable. This script therefore clears the wrong dates
-- rather than inventing replacements: the dashboards show "—", which is honest,
-- where before they showed a confident wrong date.
--
-- ORDER OF WORK
--   1. FIRST re-run the corrected 20260822_payment_date_and_bank_account.sql.
--      Do this before anything here: it revokes public EXECUTE on
--      record_invoice_payment, which until then is callable by anyone holding
--      the anon key. Re-running is safe — the migration snapshots
--      payment_batch_id before writing anything and will not recover a date for
--      a row an earlier run already touched, so it cannot re-stamp these rows.
--   2. Run STEP 1 below, read the result.
--   3. Run STEP 2 with the timestamp it gives you.
--   4. Run STEP 3 to confirm.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── STEP 1 (read-only): find the migration's write ──────────────────────────
-- now() is frozen for the duration of a transaction, so every row the migration
-- touched carries one identical updated_at, down to the microsecond. That is
-- its fingerprint. Expect one row with a far larger count than the rest —
-- that timestamp is the moment you ran the migration.
--
-- `affected_dates` should show a single date (the day you ran it). If it shows
-- a range, stop and ask before running step 2.

SELECT
    updated_at                                   AS migration_timestamp,
    count(*)                                     AS rows_written,
    count(payment_date)                          AS rows_with_a_payment_date,
    min(payment_date) || ' .. ' || max(payment_date) AS affected_dates
FROM public.invoices
WHERE status = 'Paid'
GROUP BY updated_at
ORDER BY count(*) DESC
LIMIT 5;


-- ── STEP 2: clear the fabricated dates ──────────────────────────────────────
-- Replace <<<PASTE migration_timestamp HERE>>> with the exact value from step 1
-- (keep the quotes), then run.
--
-- The match is deliberately narrow: the row must carry the migration's exact
-- timestamp AND its payment_date must be the date that timestamp falls on in
-- Riyadh. A real payment recorded through the app after the migration has a
-- different updated_at, so it cannot be caught by this.
--
-- Commented out so the file cannot be run wholesale by accident. Uncomment
-- after filling in the timestamp.

-- BEGIN;
--
-- UPDATE public.invoices
-- SET payment_date = NULL
-- WHERE status = 'Paid'
--   AND updated_at = '<<<PASTE migration_timestamp HERE>>>'::timestamptz
--   AND payment_date = ('<<<PASTE migration_timestamp HERE>>>'::timestamptz
--                       AT TIME ZONE 'Asia/Riyadh')::date;
--
-- -- Check the count looks like step 1's rows_with_a_payment_date before COMMIT.
-- -- If it does not, ROLLBACK instead.
-- COMMIT;


-- ── STEP 3: confirm ─────────────────────────────────────────────────────────
-- After step 2, this should report 0 fabricated dates remaining.

-- SELECT
--     count(*) FILTER (WHERE payment_date IS NOT NULL) AS dates_still_set,
--     count(*) FILTER (WHERE payment_date IS NULL)     AS shows_as_dash,
--     count(*)                                          AS total_paid_invoices
-- FROM public.invoices
-- WHERE status = 'Paid' AND type = 'invoice';
