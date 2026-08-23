-- ─────────────────────────────────────────────────────────────────────────────
-- Ice cream billing module
--
-- A second, self-contained procurement flow that shares this app's login,
-- storage and audit log but NONE of its data. Nothing here references
-- public.invoices, public.brands or public.receipts, and public.profiles is
-- read but never altered — its `role` column keeps its existing four values.
--
-- The flow it replaces: every Sunday, store managers' bill photos are read out
-- of two WhatsApp groups and retyped into an Excel sheet, which is sent to
-- accounts, paid, and posted back to the group with the receipt.
--
-- Run ONCE against the Supabase project (SQL Editor → paste → Run). Safe to
-- re-run: every statement is guarded.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Who may open the ice cream module ────────────────────────────────────
-- Deliberately NOT a fifth value in profiles.role. That column holds one value
-- per person, so reusing it would force a choice between chocolate access and
-- ice cream access. A separate list makes them independent switches: the ice
-- cream manager gets a profile with role = NULL (locked out of every chocolate
-- route by the existing middleware check) plus a row here, and anyone who later
-- needs both keeps their chocolate role untouched.

CREATE TABLE IF NOT EXISTS public.ice_members (
    profile_id  uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    active      boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Used by every RLS policy below. STABLE so the planner calls it once per
-- statement rather than once per row.
CREATE OR REPLACE FUNCTION public.is_ice_member()
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.ice_members
        WHERE profile_id = auth.uid() AND active
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;


-- ── 2. Reference data ───────────────────────────────────────────────────────
-- `city` is the WhatsApp group a branch reports into, and it is what splits the
-- weekly sheet in two. Salesmen are their own table rather than a text column
-- on the bill because the same person appears in the source spreadsheet under
-- more than one spelling ("MUHAMMED YAHYA" / "OMAR M.YAHYA", "AJMAL" /
-- "MUHAMMED AJMAL") — one row per person is what makes the summary totals add
-- up to a single line each.

CREATE TABLE IF NOT EXISTS public.ice_branches (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name_en     text NOT NULL UNIQUE,
    name_ar     text,
    city        text NOT NULL CHECK (city IN ('makkah', 'jeddah')),
    sort_order  int  NOT NULL DEFAULT 0,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ice_salesmen (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL UNIQUE,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Which salesman covers which branch. Effective-dated because salesmen move
-- between branches, and one salesman commonly covers several (Zubair covers
-- Ruseifa and Awali; Islam Ali covers Quraish and Obhur). A partial unique
-- index enforces "at most one *current* salesman per branch" while leaving the
-- closed historical rows alone.
CREATE TABLE IF NOT EXISTS public.ice_branch_salesmen (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id      uuid NOT NULL REFERENCES public.ice_branches(id) ON DELETE CASCADE,
    salesman_id    uuid NOT NULL REFERENCES public.ice_salesmen(id) ON DELETE RESTRICT,
    effective_from date NOT NULL DEFAULT current_date,
    effective_to   date,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ice_branch_salesmen_dates CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ice_branch_current_salesman
    ON public.ice_branch_salesmen (branch_id)
    WHERE effective_to IS NULL;


-- ── 3. Batches ──────────────────────────────────────────────────────────────
-- A batch is one thing sent to accounts. `kind` is the only difference between
-- the Sunday sheet and an urgent single-bill payment — 'urgent' is simply a
-- batch that happens to hold one bill. Keeping them the same object is what
-- guarantees a bill cannot be in two of them, which is what stops an urgent
-- payment being paid a second time on Sunday.
--
-- `snapshot` freezes the rendered table at approval time. The manager sends a
-- screenshot over WhatsApp and no file is kept anywhere, so without this there
-- would be no record at all of what was sent — only of what the numbers happen
-- to look like today.

CREATE TABLE IF NOT EXISTS public.ice_batches (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    city          text NOT NULL CHECK (city IN ('makkah', 'jeddah')),
    kind          text NOT NULL DEFAULT 'weekly' CHECK (kind IN ('weekly', 'urgent')),
    status        text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'sent', 'paid')),
    reference     text NOT NULL UNIQUE,
    period_start  date,
    period_end    date,
    total_amount  numeric(12,2) NOT NULL DEFAULT 0,
    bill_count    int  NOT NULL DEFAULT 0,
    snapshot      jsonb,
    approved_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    approved_at   timestamptz NOT NULL DEFAULT now(),
    sent_at       timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_ice_batches_status ON public.ice_batches (status, city);


-- ── 4. Bills ────────────────────────────────────────────────────────────────
-- Submitted from the public /bill link by store managers: branch, date, amount.
-- Nothing else is asked of them.
--
-- salesman_id is resolved from the branch at submission time and STORED, not
-- looked up when the sheet renders. Reassigning a salesman next year must not
-- silently rewrite which sheets they appeared on — the same class of bug as
-- reading a payment date off updated_at.

CREATE TABLE IF NOT EXISTS public.ice_bills (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id         uuid NOT NULL REFERENCES public.ice_branches(id) ON DELETE RESTRICT,
    salesman_id       uuid REFERENCES public.ice_salesmen(id) ON DELETE RESTRICT,
    bill_date         date NOT NULL,
    amount            numeric(12,2) NOT NULL CHECK (amount > 0),
    status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'batched', 'paid', 'void')),
    batch_id          uuid REFERENCES public.ice_batches(id) ON DELETE SET NULL,
    source            text NOT NULL DEFAULT 'link' CHECK (source IN ('link', 'manual')),
    submitted_by_name text,
    note              text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    -- A bill in a batch must have a batch id, and a pending one must not. This
    -- is the invariant the whole no-double-payment guarantee rests on, so the
    -- database enforces it rather than the application remembering to.
    CONSTRAINT ice_bills_batch_matches_status CHECK (
        (status IN ('batched', 'paid') AND batch_id IS NOT NULL)
        OR (status IN ('pending', 'void') AND batch_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS ix_ice_bills_pending ON public.ice_bills (status, branch_id, bill_date);
CREATE INDEX IF NOT EXISTS ix_ice_bills_batch   ON public.ice_bills (batch_id);

-- Same branch, same day, same amount is *usually* one bill entered twice — but
-- occasionally it is two genuine deliveries, so this is an index to flag on,
-- never a unique constraint to block on.
CREATE INDEX IF NOT EXISTS ix_ice_bills_dupe_probe
    ON public.ice_bills (branch_id, bill_date, amount)
    WHERE status <> 'void';

CREATE OR REPLACE FUNCTION public.ice_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS ice_bills_touch_updated_at ON public.ice_bills;
CREATE TRIGGER ice_bills_touch_updated_at
    BEFORE UPDATE ON public.ice_bills
    FOR EACH ROW EXECUTE FUNCTION public.ice_touch_updated_at();


-- ── 5. Payments ─────────────────────────────────────────────────────────────
-- payment_date is entered by the person recording it and is never derived from
-- a row timestamp: accounts often pay a day or two after the sheet is sent, and
-- "when the row was last written" is not that date.
--
-- bank_account holds the last 4 digits only. Enough to tell the accounts apart;
-- full account numbers have no reason to be in this database. Validated against
-- BANK_ACCOUNTS in src/lib/constants.ts by the API, matching how the chocolate
-- side does it.

CREATE TABLE IF NOT EXISTS public.ice_payments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id      uuid NOT NULL UNIQUE REFERENCES public.ice_batches(id) ON DELETE CASCADE,
    payment_date  date NOT NULL,
    bank_account  text NOT NULL CHECK (bank_account ~ '^[0-9]{4}$'),
    receipt_path  text,
    recorded_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    recorded_at   timestamptz NOT NULL DEFAULT now()
);


-- ── 6. RLS: reads for ice members, writes only through the API ──────────────
-- Same posture as the chocolate tables after the July hardening: the dashboards
-- SELECT with the signed-in user's session, and every write goes through an API
-- route holding the service role, which bypasses RLS. No client-facing INSERT /
-- UPDATE / DELETE policy exists on any table here — including for the public
-- /bill form, whose submissions go through /api/ice/bills rather than straight
-- from the browser.

ALTER TABLE public.ice_members         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ice_branches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ice_salesmen        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ice_branch_salesmen ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ice_batches         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ice_bills           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ice_payments        ENABLE ROW LEVEL SECURITY;

DO $policies$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'ice_branches', 'ice_salesmen', 'ice_branch_salesmen',
        'ice_batches', 'ice_bills', 'ice_payments'
    ] LOOP
        EXECUTE format('DROP POLICY IF EXISTS "Ice members can read" ON public.%I', t);
        EXECUTE format(
            'CREATE POLICY "Ice members can read" ON public.%I FOR SELECT TO authenticated USING (public.is_ice_member())',
            t
        );
    END LOOP;
END
$policies$;

-- A member may see that they are one; nobody can see the rest of the list.
DROP POLICY IF EXISTS "Members can read own membership" ON public.ice_members;
CREATE POLICY "Members can read own membership"
    ON public.ice_members FOR SELECT TO authenticated
    USING (profile_id = auth.uid());


-- ── 7. Approving a batch, atomically ────────────────────────────────────────
-- Collects every pending bill for a city into one new batch. Deliberately does
-- NOT filter by calendar week: the batch takes whatever is unpaid at the moment
-- of approval, so a bill submitted late — after its own week was already sent —
-- is picked up by the next batch instead of being orphaned in a week nobody
-- will look at again. period_start/period_end describe the bills it actually
-- caught, for the sheet header.
--
-- p_bill_ids restricts it to specific bills, which is how "Pay Now" on a single
-- urgent bill works: same function, one id, kind = 'urgent'.

CREATE OR REPLACE FUNCTION public.ice_approve_batch(
    p_city      text,
    p_kind      text,
    p_actor     uuid,
    p_bill_ids  uuid[] DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
    v_batch_id  uuid;
    v_reference text;
    v_ids       uuid[];
    v_count     int;
    v_total     numeric(12,2);
    v_from      date;
    v_to        date;
BEGIN
    IF p_city NOT IN ('makkah', 'jeddah') THEN
        RAISE EXCEPTION 'Unknown city: %', p_city;
    END IF;

    IF p_kind NOT IN ('weekly', 'urgent') THEN
        RAISE EXCEPTION 'Unknown batch kind: %', p_kind;
    END IF;

    -- Lock the candidate rows and hold their ids in an array.
    --
    -- Deliberately NOT a temp table: this repo already lost a migration to one
    -- (see "Drop the temp-table snapshot", Aug 2026). Inside a function body it
    -- would in fact survive, since the whole body is one transaction — but temp
    -- tables also interact badly with connection poolers, and an array needs
    -- neither caveat.
    --
    -- FOR UPDATE lives in the subquery because Postgres rejects it alongside an
    -- aggregate. ORDER BY gives concurrent approvals a consistent lock order,
    -- so two of them queue instead of deadlocking.
    SELECT array_agg(locked.id)
      INTO v_ids
      FROM (
          SELECT b.id
          FROM public.ice_bills b
          JOIN public.ice_branches br ON br.id = b.branch_id
          WHERE b.status = 'pending'
            AND br.city = p_city
            AND (p_bill_ids IS NULL OR b.id = ANY(p_bill_ids))
          ORDER BY b.id
          FOR UPDATE OF b
      ) locked;

    v_count := coalesce(array_length(v_ids, 1), 0);

    -- These two cases look identical to the query but not to the manager. A
    -- "Pay Now" on a bill someone already batched must not report that the city
    -- has nothing pending — that reads as "your bill vanished" rather than
    -- "this one is already handled".
    IF p_bill_ids IS NOT NULL AND v_count <> coalesce(array_length(p_bill_ids, 1), 0) THEN
        RAISE EXCEPTION 'Expected % bill(s) but matched % — the rest are already in a batch',
            coalesce(array_length(p_bill_ids, 1), 0), v_count;
    END IF;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'No pending bills to approve for %', p_city;
    END IF;

    SELECT coalesce(sum(amount), 0), min(bill_date), max(bill_date)
      INTO v_total, v_from, v_to
      FROM public.ice_bills
     WHERE id = ANY(v_ids);

    -- Human-readable handle for the WhatsApp conversation ("IC-JEDDAH-0007"),
    -- so the manager and accounts can refer to a sheet by name.
    v_reference := 'IC-' || upper(p_city) || '-' || to_char(
        (SELECT count(*) + 1 FROM public.ice_batches WHERE city = p_city), 'FM0000'
    );

    INSERT INTO public.ice_batches
        (city, kind, status, reference, period_start, period_end, total_amount, bill_count, approved_by)
    VALUES
        (p_city, p_kind, 'approved', v_reference, v_from, v_to, v_total, v_count, p_actor)
    RETURNING id INTO v_batch_id;

    UPDATE public.ice_bills
       SET status = 'batched', batch_id = v_batch_id
     WHERE id = ANY(v_ids)
       AND status = 'pending';

    -- The rows were locked above, so this can only disagree if something
    -- changed them inside this transaction. Checking anyway means a batch can
    -- never claim a total it did not actually capture.
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> coalesce(array_length(v_ids, 1), 0) THEN
        RAISE EXCEPTION 'Batch bill count drifted during approval (% of %)',
            v_count, coalesce(array_length(v_ids, 1), 0);
    END IF;

    RETURN v_batch_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;


-- ── 8. Recording a payment, atomically ──────────────────────────────────────
-- Writes the payment row and flips both the batch and every bill in it to paid,
-- in one transaction. A half-applied payment would show a paid batch holding
-- unpaid bills, which would then be swept into the next sheet.

CREATE OR REPLACE FUNCTION public.ice_record_payment(
    p_batch_id     uuid,
    p_payment_date date,
    p_bank_account text,
    p_receipt_path text,
    p_actor        uuid
) RETURNS void AS $$
DECLARE
    v_status text;
    v_count  int;
BEGIN
    SELECT status INTO v_status
      FROM public.ice_batches
     WHERE id = p_batch_id
       FOR UPDATE;

    IF v_status IS NULL THEN
        RAISE EXCEPTION 'Batch not found';
    END IF;

    IF v_status = 'paid' THEN
        RAISE EXCEPTION 'This batch is already paid';
    END IF;

    INSERT INTO public.ice_payments
        (batch_id, payment_date, bank_account, receipt_path, recorded_by)
    VALUES
        (p_batch_id, p_payment_date, p_bank_account, p_receipt_path, p_actor);

    UPDATE public.ice_batches
       SET status = 'paid', sent_at = coalesce(sent_at, now())
     WHERE id = p_batch_id;

    UPDATE public.ice_bills
       SET status = 'paid'
     WHERE batch_id = p_batch_id AND status = 'batched';
    GET DIAGNOSTICS v_count = ROW_COUNT;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'Batch % has no bills to pay', p_batch_id;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;


-- ── 9. Lock both functions down to the service role ─────────────────────────
-- Identical reasoning to record_invoice_payment in the August migration:
-- PostgreSQL grants EXECUTE to PUBLIC on new functions and Supabase adds grants
-- for anon/authenticated on the public schema, which is a PostgREST-exposed
-- schema. Without this, anyone holding NEXT_PUBLIC_SUPABASE_ANON_KEY — which
-- ships to every browser — could POST /rest/v1/rpc/ice_record_payment directly
-- and mark a batch paid, skipping the API's authorization and its audit entry.
-- SECURITY DEFINER makes that worse, not better.
--
-- service_role is BYPASSRLS but not superuser, so it needs the explicit GRANT:
-- never add it to the REVOKE list.

DO $lockdown$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('ice_approve_batch', 'ice_record_payment')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', r.sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
        RAISE NOTICE 'Locked down %', r.sig;
    END LOOP;
END
$lockdown$;

-- is_ice_member() is different: the RLS policies call it as the signed-in user,
-- so authenticated must keep EXECUTE. It reads only whether the *caller* is a
-- member and returns a boolean, so it leaks nothing.
REVOKE ALL ON FUNCTION public.is_ice_member() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_ice_member() TO authenticated, service_role;


-- ── 10. Seed: branches and salesmen ─────────────────────────────────────────
-- Taken from the August 2026 Makkah and Jeddah sheets and confirmed by the
-- owner. Six of these branches already exist on the chocolate side under the
-- same Arabic names; they are repeated here rather than shared, so that adding
-- or retiring an ice cream branch can never move a chocolate invoice.

INSERT INTO public.ice_branches (name_en, name_ar, city, sort_order) VALUES
    ('Ruseifa',    'الرصيفة',   'makkah', 10),
    ('Awali',      'العوالي',   'makkah', 20),
    ('Shawqia',    'الشوقية',   'makkah', 30),
    ('Hamdaniya',  'الحمدانية', 'jeddah', 10),
    ('Salhia',     'الصالحية',  'jeddah', 20),
    ('Quraish',    'قريش',      'jeddah', 30),
    ('Haramain',   'الحرمين',   'jeddah', 40),
    ('Al-Khumra',  'الخمرة',    'jeddah', 50),
    ('Sanabil',    'سنابل',     'jeddah', 60),
    ('Obhur',      'أبحر',      'jeddah', 70)
ON CONFLICT (name_en) DO NOTHING;

INSERT INTO public.ice_salesmen (name) VALUES
    ('Zubair'),
    ('Muhammed Ajmal'),
    ('Saifullah Khan'),
    ('Islam Ali'),
    ('Nawab'),
    ('Atif'),
    ('Muhammed Yahya')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.ice_branch_salesmen (branch_id, salesman_id, effective_from)
SELECT br.id, sm.id, DATE '2026-01-01'
FROM (VALUES
    ('Ruseifa',   'Zubair'),
    ('Awali',     'Zubair'),
    ('Shawqia',   'Muhammed Ajmal'),
    ('Hamdaniya', 'Saifullah Khan'),
    ('Salhia',    'Saifullah Khan'),
    ('Quraish',   'Islam Ali'),
    ('Obhur',     'Islam Ali'),
    ('Haramain',  'Nawab'),
    ('Al-Khumra', 'Atif'),
    ('Sanabil',   'Muhammed Yahya')
) AS m(branch_name, salesman_name)
JOIN public.ice_branches br ON br.name_en = m.branch_name
JOIN public.ice_salesmen sm ON sm.name    = m.salesman_name
WHERE NOT EXISTS (
    SELECT 1 FROM public.ice_branch_salesmen x
    WHERE x.branch_id = br.id AND x.effective_to IS NULL
);


-- ── 11. Receipt storage ─────────────────────────────────────────────────────
-- A private bucket of its own, so ice cream receipts and chocolate receipts can
-- never collide on a path and revoking access to one leaves the other alone.
--
-- Uploads are NOT granted to anyone here: /api/ice/payments writes with the
-- service role, exactly as the chocolate side does since the July hardening. The
-- SELECT policy exists only so the dashboard can mint a signed URL to view a
-- receipt — and is_ice_member() means a chocolate user cannot, even with a path.
--
-- Wrapped in a guard so this file still runs on a plain PostgreSQL database
-- (which has no storage schema) for testing.

DO $storage$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
        RAISE NOTICE 'No storage schema — skipping bucket setup (not a Supabase database)';
        RETURN;
    END IF;

    INSERT INTO storage.buckets (id, name, public)
    VALUES ('ice-receipts', 'ice-receipts', false)
    ON CONFLICT (id) DO NOTHING;

    DROP POLICY IF EXISTS "Ice members can read ice receipts" ON storage.objects;
    CREATE POLICY "Ice members can read ice receipts"
        ON storage.objects FOR SELECT TO authenticated
        USING (bucket_id = 'ice-receipts' AND public.is_ice_member());
END
$storage$;


-- ── 12. Grant the ice cream manager access ──────────────────────────────────
-- Run AFTER creating the icecream@ks.com user in Authentication → Users, and
-- after their public.profiles row exists with role left NULL. A NULL role is
-- what locks them out of every chocolate route: the middleware looks their path
-- up in DASHBOARD_ROUTE_ROLES and rejects any role not on that list.

INSERT INTO public.ice_members (profile_id)
SELECT id FROM public.profiles WHERE email = 'icecream@ks.com'
ON CONFLICT (profile_id) DO UPDATE SET active = true;
