-- ─────────────────────────────────────────────────────────────────────────────
-- Marwa and Salama get their salesmen
--
-- 20260824_icecream_branch_list.sql added Marwa and Salama as Jeddah branches
-- but never gave them a row in ice_branch_salesmen — the original seed wrote
-- branches, salesmen and assignments together, and the branch-list migration
-- only touched the first of the three. So both branches have had no current
-- salesman since the day they were created, which is why the weekly sheet
-- labels them "Unassigned".
--
-- Confirmed by the owner:
--     Marwa   المروة   → Nawab
--     Salama  السلامة  → Islam Ali
--
-- Both men are already in ice_salesmen from the August seed. Nawab covered
-- Haramain and Islam Ali covered Quraish and Obhur; all three of those branches
-- were retired by the branch-list migration, so neither man has a current
-- assignment today and neither insert can collide with one.
--
-- Idempotent: safe to run twice, and safe on a database seeded but not yet
-- carrying any bills.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Both men exist and are active ────────────────────────────────────────
-- Belt and braces. The seed in 20260823_icecream_module.sql already inserted
-- them, but this file is the one that makes them load-bearing, so it should not
-- depend on that having landed intact.

INSERT INTO public.ice_salesmen (name) VALUES
    ('Nawab'),
    ('Islam Ali')
ON CONFLICT (name) DO NOTHING;

UPDATE public.ice_salesmen
   SET active = true
 WHERE name IN ('Nawab', 'Islam Ali')
   AND NOT active;


-- ── 2. The assignments ──────────────────────────────────────────────────────
-- effective_from is the day the two branches were created rather than today,
-- so the assignment covers the branch's whole life. Nothing about these two
-- branches predates 2026-08-24, so there is no earlier period this could
-- wrongly claim.
--
-- Guarded on "no current assignment" rather than ON CONFLICT because the
-- uniqueness rule is a *partial* index (uq_ice_branch_current_salesman, WHERE
-- effective_to IS NULL) and ON CONFLICT cannot target it. The guard is also the
-- behaviour we want: if someone has already assigned a salesman to one of these
-- branches by hand, that is a live decision and this file must not overwrite it.

INSERT INTO public.ice_branch_salesmen (branch_id, salesman_id, effective_from)
SELECT br.id, sm.id, DATE '2026-08-24'
FROM (VALUES
    ('Marwa',  'Nawab'),
    ('Salama', 'Islam Ali')
) AS m(branch_name, salesman_name)
JOIN public.ice_branches br ON br.name_en = m.branch_name
JOIN public.ice_salesmen sm ON sm.name    = m.salesman_name
WHERE NOT EXISTS (
    SELECT 1 FROM public.ice_branch_salesmen x
    WHERE x.branch_id = br.id AND x.effective_to IS NULL
);


-- ── 3. Backfill the bills already filed against these two branches ──────────
-- file_bill() resolves the salesman at submission time and STORES it on the
-- bill, so that reassigning a salesman later never rewrites which sheets they
-- appear on. Every bill filed for Marwa or Salama so far therefore carries
-- salesman_id = NULL — there was nothing to resolve — and would keep reading
-- "Unassigned" on the sheet even after section 2 runs.
--
-- This is filling in a blank, not rewriting history: the rows updated are only
-- the ones where no salesman was ever recorded, and only on these two branches.
-- A bill that already names someone is left exactly as it is.
--
-- Batched and paid bills are included. ice_batches.snapshot froze the table as
-- it was sent to accounts, so what was actually sent stays on record untouched;
-- this only repairs the live view, where an old Marwa bill would otherwise sit
-- under "Unassigned" forever.
--
-- This does fire ice_bills_touch_updated_at and bump updated_at on the rows it
-- touches. Checked before writing it: nothing in the ice cream module reads
-- ice_bills.updated_at — a payment's date lives on ice_payments.payment_date
-- and is typed in by the person recording it — so no displayed date moves. That
-- check is the point; reading a payment date off a row timestamp is the exact
-- bug the chocolate side already had.

DO $backfill$
DECLARE
    v_updated int;
BEGIN
    UPDATE public.ice_bills bl
       SET salesman_id = a.salesman_id
      FROM public.ice_branches br
      JOIN public.ice_branch_salesmen a
        ON a.branch_id = br.id AND a.effective_to IS NULL
     WHERE bl.branch_id  = br.id
       AND br.name_en    IN ('Marwa', 'Salama')
       AND bl.salesman_id IS NULL;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RAISE NOTICE 'Backfilled % Marwa/Salama bill(s) that had no salesman', v_updated;
END
$backfill$;


-- ── 4. Read back every active branch and who covers it ──────────────────────

DO $verify$
DECLARE
    r record;
    v_unassigned int;
BEGIN
    RAISE NOTICE '── Active branches and their current salesman ──';
    FOR r IN
        SELECT b.city, b.sort_order, b.name_en,
               coalesce(s.name, '(none)') AS salesman
          FROM public.ice_branches b
          LEFT JOIN public.ice_branch_salesmen a
                 ON a.branch_id = b.id AND a.effective_to IS NULL
          LEFT JOIN public.ice_salesmen s ON s.id = a.salesman_id
         WHERE b.active
         ORDER BY b.city, b.sort_order
    LOOP
        RAISE NOTICE '  %  %  %', rpad(r.city, 8), rpad(r.name_en, 12), r.salesman;
    END LOOP;

    SELECT count(*) INTO v_unassigned
      FROM public.ice_branches b
     WHERE b.active
       AND NOT EXISTS (
           SELECT 1 FROM public.ice_branch_salesmen a
            WHERE a.branch_id = b.id AND a.effective_to IS NULL
       );

    IF v_unassigned > 0 THEN
        RAISE WARNING '% active branch(es) still have no salesman — see the list above', v_unassigned;
    END IF;
END
$verify$;
