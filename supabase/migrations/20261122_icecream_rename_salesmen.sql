-- ─────────────────────────────────────────────────────────────────────────────
-- Two ice cream salesmen renamed
--
-- Requested by the owner, with the areas each one covers:
--
--     Saifullah Khan  →  Mohamed Saleem   (Salhia & Hamdaniya)
--     Muhammed Yahya  →  Abdul Jaleel     (Sanabil)
--
-- The areas are exactly what these two rows already cover in
-- ice_branch_salesmen, so this is a rename of the existing rows, not a
-- reassignment. Every bill points at ice_salesmen by id, so the new names show
-- up everywhere at once — the weekly sheet, the summary and old bills alike.
-- Batches already sent to accounts keep the names they were sent with: their
-- ice_batches.snapshot froze the sheet at approval time.
--
-- Idempotent: safe to run twice. Each UPDATE only matches the old name, and is
-- skipped if a row with the new name already exists (name is UNIQUE).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. The renames ──────────────────────────────────────────────────────────

UPDATE public.ice_salesmen
   SET name = 'Mohamed Saleem'
 WHERE name = 'Saifullah Khan'
   AND NOT EXISTS (SELECT 1 FROM public.ice_salesmen WHERE name = 'Mohamed Saleem');

UPDATE public.ice_salesmen
   SET name = 'Abdul Jaleel'
 WHERE name = 'Muhammed Yahya'
   AND NOT EXISTS (SELECT 1 FROM public.ice_salesmen WHERE name = 'Abdul Jaleel');


-- ── 2. Read back who covers what ────────────────────────────────────────────

DO $verify$
DECLARE
    r record;
BEGIN
    RAISE NOTICE '── Current assignments for the renamed salesmen ──';
    FOR r IN
        SELECT s.name AS salesman, b.name_en AS branch, b.active
          FROM public.ice_salesmen s
          JOIN public.ice_branch_salesmen a
            ON a.salesman_id = s.id AND a.effective_to IS NULL
          JOIN public.ice_branches b ON b.id = a.branch_id
         WHERE s.name IN ('Mohamed Saleem', 'Abdul Jaleel')
         ORDER BY s.name, b.sort_order
    LOOP
        RAISE NOTICE '  %  %', rpad(r.salesman, 16),
            r.branch || CASE WHEN r.active THEN '' ELSE '  (inactive branch)' END;
    END LOOP;

    IF EXISTS (SELECT 1 FROM public.ice_salesmen
                WHERE name IN ('Saifullah Khan', 'Muhammed Yahya')) THEN
        RAISE WARNING 'An old name is still present — a row with the new name probably already existed. Check ice_salesmen by hand.';
    END IF;
END
$verify$;
