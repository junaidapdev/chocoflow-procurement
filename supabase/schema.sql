-- Create updated_at function if it doesn't exist
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create invoices table
CREATE TABLE IF NOT EXISTS public.invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_name TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    invoice_number TEXT NOT NULL,
    invoice_date DATE NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    invoice_url TEXT,
    receipt_url TEXT,
    status TEXT DEFAULT 'Pending' CHECK (status IN ('Pending', 'Verified', 'Rejected', 'Approved', 'ReadyToPay', 'Paid')),
    rejection_comment TEXT,
    vendor_name TEXT,
    vendor_email TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Trigger for updated_at on invoices
CREATE TRIGGER update_invoices_updated_at
    BEFORE UPDATE ON public.invoices
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Create profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT CHECK (role IN ('amin', 'salam', 'accountant', 'payer')),
    full_name TEXT,
    email TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Trigger for updated_at on profiles
CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to handle new user signups
CREATE OR REPLACE FUNCTION public.handle_new_user() 
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name', null);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to automatically create a profile for new users
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Add RLS to invoices
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- Policy: Only authenticated users can read invoices
-- (dashboards read with the signed-in user's session).
CREATE POLICY "Authenticated users can select invoices"
    ON public.invoices FOR SELECT
    USING (auth.role() = 'authenticated');

-- NOTE: There are intentionally NO client-facing INSERT or UPDATE policies on
-- invoices. Vendor submissions and every status change go through the API,
-- which writes with the service role (bypassing RLS) and enforces the approval
-- state machine. Leaving these open would let any authenticated user set
-- status='Paid' directly and skip the whole workflow.

-- Add RLS to profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policy: Authenticated users can read profiles
CREATE POLICY "Authenticated users can select profiles"
    ON public.profiles FOR SELECT
    USING (auth.role() = 'authenticated');

-- Policy: Users can update ONLY their own profile (not anyone else's).
CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- Guard: a normal user can never change their own `role`. Role changes must be
-- made with the service role (server / Supabase dashboard). Without this, a
-- 'payer' could promote themselves to 'salam'.
CREATE OR REPLACE FUNCTION public.prevent_profile_role_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Role can only be changed by an administrator';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER enforce_profile_role_immutable
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.prevent_profile_role_change();

-- Storage Configuration
-- Note: Requires superuser/supabase_admin permissions if run outside Supabase SQL editor.
-- Assuming buckets do not exist yet.

INSERT INTO storage.buckets (id, name, public) VALUES ('invoices', 'invoices', false) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('receipts', 'receipts', false) ON CONFLICT (id) DO NOTHING;

-- Storage policies for invoices bucket.
-- Uploads happen through the API (service role), so no anonymous/public INSERT
-- policy is needed — that would let anyone drop arbitrary files in the bucket.
CREATE POLICY "Authenticated users can read invoices bucket"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'invoices' AND auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update/delete invoices bucket"
    ON storage.objects FOR UPDATE
    USING (bucket_id = 'invoices' AND auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can delete from invoices bucket"
    ON storage.objects FOR DELETE
    USING (bucket_id = 'invoices' AND auth.role() = 'authenticated');

-- Storage policies for receipts bucket.
-- Receipts are internal bank-transfer proofs uploaded by the API (service
-- role) only — never directly by a browser client.
CREATE POLICY "Authenticated users can read receipts bucket"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'receipts' AND auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update/delete receipts bucket"
    ON storage.objects FOR UPDATE
    USING (bucket_id = 'receipts' AND auth.role() = 'authenticated');

-- Create brands table
CREATE TABLE IF NOT EXISTS public.brands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_name TEXT UNIQUE NOT NULL,
    contact_name TEXT,
    whatsapp_number TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Trigger for updated_at on brands
CREATE TRIGGER update_brands_updated_at
    BEFORE UPDATE ON public.brands
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add RLS to brands
ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can select brands
CREATE POLICY "Anyone can select brands"
    ON public.brands FOR SELECT
    USING (true);

-- Policy: Admins can update brands
CREATE POLICY "Admins can update brands"
    ON public.brands FOR UPDATE
    USING (
        auth.uid() IN (SELECT id FROM profiles WHERE role IN ('amin', 'salam'))
    );
CREATE POLICY "Admins can insert brands"
    ON public.brands FOR INSERT
    WITH CHECK (
        auth.uid() IN (SELECT id FROM profiles WHERE role IN ('amin', 'salam'))
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- Returns support
-- A "return" is a credit note from the vendor (they owe us money back).
-- It flows through the same Pending → Verified → Approved pipeline as an
-- invoice. When Finance pays an invoice, approved returns for the same
-- brand can be applied to reduce the net payable amount. Once applied,
-- the return's status becomes 'Paid' and applied_to_invoice_id links it
-- to the invoice it reduced.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invoices
    ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'invoice'
        CHECK (type IN ('invoice', 'return')),
    ADD COLUMN IF NOT EXISTS applied_to_invoice_id UUID REFERENCES public.invoices(id);

CREATE INDEX IF NOT EXISTS idx_invoices_type_status ON public.invoices(type, status);
CREATE INDEX IF NOT EXISTS idx_invoices_applied_to ON public.invoices(applied_to_invoice_id);

-- One invoice/return number per brand per type. Backs the API's duplicate check
-- so two submissions racing at once can't both slip through.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_brand_number_type
    ON public.invoices (brand_name, invoice_number, type);

-- ─────────────────────────────────────────────────────────────────────────────
-- Payment authorization step
-- Splits the old "Approved → Paid" transition into two:
--   Approved        — manager has signed off; finance/accountant must authorize
--   ReadyToPay      — accountant has authorized; payer must transfer + upload
--   Paid            — payer has uploaded receipt
-- The 'payer' role above owns the final step.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invoices
    DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE public.invoices
    ADD CONSTRAINT invoices_status_check
    CHECK (status IN ('Pending', 'Verified', 'Rejected', 'Approved', 'ReadyToPay', 'Paid'));

ALTER TABLE public.profiles
    DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('amin', 'salam', 'accountant', 'payer'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Notification tracking
-- Timestamps for when the accountant sent the "payment done" WhatsApp to the
-- vendor, and when they notified Salam. These replace the previous
-- localStorage-based tracking, which was per-browser and polluted stale data
-- across users. Nullable — null means "not yet notified".
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invoices
    ADD COLUMN IF NOT EXISTS vendor_notified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS salam_notified_at TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────────
-- Payment date, bank account & batch id
-- payment_date     — the day money actually left the bank, typed by the payer.
--                    DATE because it reconciles against bank statements, which
--                    settle per day. Never derived from updated_at: an UPDATE
--                    trigger bumps that column on every later write (e.g. a
--                    notification), which would silently move the payment date.
-- bank_account     — last 4 digits of the company account used. Only the last 4
--                    on purpose; full account numbers do not belong here. Not a
--                    CHECK constraint — the valid set lives in
--                    src/lib/constants.ts so accounts can change without a
--                    migration, the same way BRANCHES does.
-- payment_batch_id — one bank transfer usually covers several invoices. This
--                    makes that batch addressable instead of merely implied by
--                    a shared receipt_url.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invoices
    ADD COLUMN IF NOT EXISTS payment_date DATE,
    ADD COLUMN IF NOT EXISTS bank_account TEXT,
    ADD COLUMN IF NOT EXISTS payment_batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_invoices_payment_date
    ON public.invoices(payment_date DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_payment_batch
    ON public.invoices(payment_batch_id);


-- Function to cascade brand_name updates to invoices table
CREATE OR REPLACE FUNCTION public.cascade_brand_name_update()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.brand_name <> OLD.brand_name THEN
        UPDATE public.invoices SET brand_name = NEW.brand_name WHERE brand_name = OLD.brand_name;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to cascade
CREATE TRIGGER on_brand_name_update
    AFTER UPDATE ON public.brands
    FOR EACH ROW EXECUTE FUNCTION public.cascade_brand_name_update();

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit logging
-- Append-only event ledger for business-critical activity across vendor,
-- admin, accountant, payer, and system/API flows.
--
-- We intentionally do not add UPDATE or DELETE policies. Application code
-- should insert audit rows through a privileged server-side client, and Salam
-- is the only dashboard role allowed to read the full audit trail.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Who caused the event. Public vendor submissions and system failures will
    -- not always have an authenticated user.
    actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    actor_role TEXT,
    actor_email TEXT,
    actor_name TEXT,
    actor_type TEXT NOT NULL DEFAULT 'authenticated'
        CHECK (actor_type IN ('authenticated', 'public', 'system')),

    -- What happened and whether the operation succeeded.
    action TEXT NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'success'
        CHECK (outcome IN ('success', 'failure', 'denied')),
    error_message TEXT,

    -- What business object was affected.
    entity_type TEXT NOT NULL,
    entity_id UUID,
    entity_label TEXT,

    -- Snapshot fields for state transition debugging.
    before_state JSONB,
    after_state JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Request/debug context. Keep secrets and full file contents out of logs.
    request_ip INET,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
    ON public.audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_id
    ON public.audit_logs(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_role
    ON public.audit_logs(actor_role, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action
    ON public.audit_logs(action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_outcome
    ON public.audit_logs(outcome, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
    ON public.audit_logs(entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_label
    ON public.audit_logs(entity_label);

CREATE INDEX IF NOT EXISTS idx_audit_logs_metadata
    ON public.audit_logs USING GIN (metadata);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Salam can select audit logs" ON public.audit_logs;
CREATE POLICY "Salam can select audit logs"
    ON public.audit_logs FOR SELECT
    USING (
        auth.uid() IN (
            SELECT id FROM public.profiles WHERE role = 'salam'
        )
    );


-- ─────────────────────────────────────────────────────────────────────────────
-- Atomic payment
-- Applies return credits (Approved → Paid) and marks invoices Paid in a single
-- transaction, stamping every affected row with the payment date, bank account
-- and batch id. If any count is off, it raises and the whole thing rolls back,
-- so a payment can never be left half-recorded. Called by the receipts API.
-- ─────────────────────────────────────────────────────────────────────────────
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
