-- ─────────────────────────────────────────────────────────────────────────────
-- Ice cream bill photo
--
-- Lets the store manager attach a photo of the paper bill when they file it from
-- the public /bill link, and lets the office see that photo against the bill in
-- the dashboard.
--
-- This softens the module's founding premise a little. The original design kept
-- NO file — the manager screenshotted the WhatsApp thread and `snapshot` froze
-- the rendered sheet — precisely because there was nothing to keep. Capturing
-- the bill at source is strictly more evidence than that, not less, so the
-- snapshot stays exactly as it is; this only adds the picture the branch was
-- already holding in its hand.
--
-- The photo is OPTIONAL. The public link is effectively public (a forwarded
-- screenshot puts it in anyone's hands), so a required upload would turn a leaked
-- link into a way to push arbitrary files into storage. It is also absent on the
-- manual backlog path, where the office types in a bill that only ever lived in
-- WhatsApp text. Both cases file a bill with no photo and that is correct.
--
-- Run ONCE against the Supabase project (SQL Editor → paste → Run). Safe to
-- re-run: every statement is guarded.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. The column ───────────────────────────────────────────────────────────
-- Storage PATH, not a URL — the bucket is private and the dashboard mints a
-- short-lived signed URL to view it, exactly like ice_payments.receipt_path.
-- Nullable, because a bill with no photo is a first-class case here, not a gap.

ALTER TABLE public.ice_bills
    ADD COLUMN IF NOT EXISTS bill_photo_path text;


-- ── 2. Carry the path through the same insert ───────────────────────────────
-- The path is written in the one transaction that creates the bill, not in a
-- follow-up UPDATE. The API uploads the file first, and if this insert is then
-- rejected — a hit daily cap, an unavailable branch — it deletes the object it
-- just uploaded. That cleanup is only safe if a committed bill and its stored
-- photo are inseparable, which means the path has to land with the row.
--
-- CREATE OR REPLACE cannot add a parameter (it would create a second overload
-- and leave PostgREST to guess between them), so the old signature is dropped
-- first — the same move the August migration made for ice_approve_batch. Every
-- caller passes named arguments, so the added trailing parameter is transparent
-- to them.

DROP FUNCTION IF EXISTS public.ice_submit_bill(uuid, date, numeric, text, text, int);

CREATE OR REPLACE FUNCTION public.ice_submit_bill(
    p_branch_id    uuid,
    p_bill_date    date,
    p_amount       numeric,
    p_submitted_by text,
    p_source       text,
    p_daily_cap    int  DEFAULT NULL,
    p_photo_path   text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
    v_bill_id     uuid;
    v_active      boolean;
    v_today_count int;
    v_salesman    uuid;
BEGIN
    IF p_source NOT IN ('link', 'manual') THEN
        RAISE EXCEPTION 'Unknown bill source: %', p_source;
    END IF;

    SELECT active INTO v_active FROM public.ice_branches WHERE id = p_branch_id;

    IF v_active IS NULL OR NOT v_active THEN
        RAISE EXCEPTION 'branch_unavailable';
    END IF;

    IF p_daily_cap IS NOT NULL THEN
        -- Held until the transaction ends, so the count below cannot be stale
        -- by the time the insert lands.
        PERFORM pg_advisory_xact_lock(hashtext('ice_bill_submit'), hashtext(p_branch_id::text));

        -- "Today" is the Riyadh day, not the UTC one. The business runs in
        -- Riyadh (UTC+3), so a UTC-midnight boundary would leave the first
        -- three hours of every local day uncounted.
        SELECT count(*) INTO v_today_count
          FROM public.ice_bills
         WHERE branch_id = p_branch_id
           AND (created_at AT TIME ZONE 'Asia/Riyadh')::date
             = (now() AT TIME ZONE 'Asia/Riyadh')::date;

        IF v_today_count >= p_daily_cap THEN
            RAISE EXCEPTION 'daily_cap_reached';
        END IF;
    END IF;

    -- Resolved now and stored on the bill: reassigning a salesman later must
    -- not change which sheets they appear on.
    SELECT salesman_id INTO v_salesman
      FROM public.ice_branch_salesmen
     WHERE branch_id = p_branch_id AND effective_to IS NULL;

    INSERT INTO public.ice_bills
        (branch_id, salesman_id, bill_date, amount, status, source, submitted_by_name, bill_photo_path)
    VALUES
        (p_branch_id, v_salesman, p_bill_date, p_amount, 'pending', p_source, p_submitted_by, p_photo_path)
    RETURNING id INTO v_bill_id;

    RETURN v_bill_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;


-- ── 3. Re-lock the function down to the service role ────────────────────────
-- A freshly created function is granted EXECUTE to PUBLIC, and Supabase adds
-- anon/authenticated grants on the public schema — the exact hole the August
-- migration closed for this function the first time. Dropping and recreating it
-- reopened that hole, so close it again. Identical reasoning to section 9 of
-- 20260823_icecream_module.sql.

DO $lockdown$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'ice_submit_bill'
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', r.sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
        RAISE NOTICE 'Locked down %', r.sig;
    END LOOP;
END
$lockdown$;


-- ── 4. Bill photo storage ───────────────────────────────────────────────────
-- Its own private bucket, separate from 'ice-receipts', for the same reasons
-- that one is separate from the chocolate 'receipts' bucket: two kinds of file
-- can never collide on a path, and access to one can be revoked without touching
-- the other. A bill photo is submitted evidence; a payment receipt is proof the
-- money moved — different sensitivities, different buckets.
--
-- No INSERT policy is granted: uploads go through /api/ice/bills with the
-- service role, exactly like receipts. The SELECT policy exists only so the
-- dashboard can mint a signed URL, and is_ice_member() keeps a chocolate user
-- out even if they somehow hold a path.
--
-- Guarded so this file still runs on a plain PostgreSQL database (no storage
-- schema) for testing.

DO $storage$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
        RAISE NOTICE 'No storage schema — skipping bucket setup (not a Supabase database)';
        RETURN;
    END IF;

    -- DO UPDATE, not DO NOTHING: a bill photo is submitted evidence and must
    -- never be world-readable, so if a bucket of this id already exists — left
    -- over from a test, or created public by hand — this forces it back to
    -- private rather than trusting whatever it happened to be. DO NOTHING would
    -- silently leave a pre-existing public bucket public.
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('ice-bills', 'ice-bills', false)
    ON CONFLICT (id) DO UPDATE SET public = false;

    DROP POLICY IF EXISTS "Ice members can read ice bills" ON storage.objects;
    CREATE POLICY "Ice members can read ice bills"
        ON storage.objects FOR SELECT TO authenticated
        USING (bucket_id = 'ice-bills' AND public.is_ice_member());
END
$storage$;
