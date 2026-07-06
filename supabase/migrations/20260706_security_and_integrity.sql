-- ─────────────────────────────────────────────────────────────────────────────
-- Security & data-integrity hardening
--
-- Run this ONCE against your existing Supabase project (SQL Editor → paste →
-- Run). It is safe to re-run: every statement is guarded with IF EXISTS /
-- CREATE OR REPLACE. A fresh install gets all of this from schema.sql already,
-- so you only need this file for a database that was created before the fix.
--
-- ⚠️  Apply this migration together with the matching application code
--     (it adds the record_invoice_payment function that the receipts API calls).
--     Test it on a Supabase branch / staging project first if you can.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. profiles: stop privilege escalation ──────────────────────────────────
-- Before: any authenticated user could UPDATE any profile row, including their
-- own `role`, e.g. promote themselves to 'salam'. Now a user may edit only
-- their own row, and the role column can only be changed with the service role
-- (i.e. from the server or the Supabase dashboard).

DROP POLICY IF EXISTS "Authenticated users can update profiles" ON public.profiles;

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.prevent_profile_role_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow role changes only when the request is made with the service role.
  IF NEW.role IS DISTINCT FROM OLD.role AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Role can only be changed by an administrator';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS enforce_profile_role_immutable ON public.profiles;
CREATE TRIGGER enforce_profile_role_immutable
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_profile_role_change();


-- ── 2. invoices: force all writes through the API ───────────────────────────
-- Before: any authenticated user could directly UPDATE any invoice (e.g. set
-- status='Paid') or INSERT rows, bypassing the approval state machine in the
-- API routes. The API writes with the service role (which ignores RLS), so we
-- can safely remove these client-facing write policies. SELECT stays so the
-- dashboards can still read invoices with the signed-in user's session.

DROP POLICY IF EXISTS "Authenticated users can update invoices" ON public.invoices;
DROP POLICY IF EXISTS "Anyone can insert invoices" ON public.invoices;


-- ── 3. storage: only the server writes files ────────────────────────────────
-- Before: anyone (even anonymous) could upload to the invoices AND receipts
-- buckets directly. Vendor uploads and receipts both actually go through the
-- API (service role), so the anonymous upload policies were an abuse vector.

DROP POLICY IF EXISTS "Anyone can upload to invoices bucket" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can upload to receipts bucket" ON storage.objects;


-- ── 4. invoices: block duplicate submissions at the database level ──────────
-- The API does an application-level "does this already exist?" check, but two
-- submissions racing at the same time can both pass it. A unique index makes
-- the database the final arbiter.
--
-- NOTE: if this fails with a "could not create unique index" error, you have
-- pre-existing duplicates. Find them with:
--   SELECT brand_name, invoice_number, type, count(*)
--   FROM public.invoices GROUP BY 1,2,3 HAVING count(*) > 1;
-- resolve them, then re-run.

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_brand_number_type
  ON public.invoices (brand_name, invoice_number, type);


-- ── 5. payments: make "record a payment" atomic ─────────────────────────────
-- Before: the receipts API applied return credits (Approved→Paid) and then
-- marked invoices Paid in two separate updates, with hand-written rollback in
-- between. A crash between the two left return credits consumed with no invoice
-- paid. This function does both updates in ONE transaction: if anything is off,
-- it raises and Postgres rolls the whole thing back — nothing is half-applied.

CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_ids uuid[],
  p_return_ids  uuid[],
  p_receipt_url text
) RETURNS void AS $$
DECLARE
  v_expected_invoices int := coalesce(array_length(p_invoice_ids, 1), 0);
  v_expected_returns  int := coalesce(array_length(p_return_ids, 1), 0);
  v_updated int;
BEGIN
  IF v_expected_invoices = 0 THEN
    RAISE EXCEPTION 'At least one invoice is required';
  END IF;

  -- Apply the selected return credits first, linking them to the first invoice.
  IF v_expected_returns > 0 THEN
    UPDATE public.invoices
      SET status = 'Paid', applied_to_invoice_id = p_invoice_ids[1]
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

  -- Mark all selected invoices as paid with the shared receipt URL.
  UPDATE public.invoices
    SET status = 'Paid', receipt_url = p_receipt_url
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
