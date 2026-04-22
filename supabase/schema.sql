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

-- Policy: Anyone can insert invoices (for public vendor submission)
CREATE POLICY "Anyone can insert invoices" 
    ON public.invoices FOR INSERT 
    WITH CHECK (true);

-- Policy: Only authenticated users can read invoices
CREATE POLICY "Authenticated users can select invoices" 
    ON public.invoices FOR SELECT 
    USING (auth.role() = 'authenticated');

-- Policy: Only authenticated users can update invoices
CREATE POLICY "Authenticated users can update invoices" 
    ON public.invoices FOR UPDATE 
    USING (auth.role() = 'authenticated');

-- Add RLS to profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policy: Authenticated users can read profiles
CREATE POLICY "Authenticated users can select profiles"
    ON public.profiles FOR SELECT
    USING (auth.role() = 'authenticated');

-- Policy: Authenticated users can update profiles
CREATE POLICY "Authenticated users can update profiles"
    ON public.profiles FOR UPDATE
    USING (auth.role() = 'authenticated');

-- Storage Configuration
-- Note: Requires superuser/supabase_admin permissions if run outside Supabase SQL editor.
-- Assuming buckets do not exist yet.

INSERT INTO storage.buckets (id, name, public) VALUES ('invoices', 'invoices', false) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('receipts', 'receipts', false) ON CONFLICT (id) DO NOTHING;

-- Storage policies for invoices bucket (Authenticated users can read/write, anonymous can upload)
CREATE POLICY "Anyone can upload to invoices bucket"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'invoices');

CREATE POLICY "Authenticated users can read invoices bucket"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'invoices' AND auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update/delete invoices bucket"
    ON storage.objects FOR UPDATE
    USING (bucket_id = 'invoices' AND auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can delete from invoices bucket"
    ON storage.objects FOR DELETE
    USING (bucket_id = 'invoices' AND auth.role() = 'authenticated');

-- Storage policies for receipts bucket
CREATE POLICY "Anyone can upload to receipts bucket"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'receipts');

CREATE POLICY "Authenticated users can read receipts bucket"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'receipts' AND auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update/delete receipts bucket"
    ON storage.objects FOR UPDATE
    USING (bucket_id = 'receipts' AND auth.role() = 'authenticated');
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
