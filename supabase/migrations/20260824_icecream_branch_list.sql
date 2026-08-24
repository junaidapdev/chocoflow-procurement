-- ─────────────────────────────────────────────────────────────────────────────
-- Ice cream branch list: the nine branches that actually take deliveries
--
-- The August seed in 20260823_icecream_module.sql was taken off the Makkah and
-- Jeddah sheets. Three of those Jeddah entries are not branches this business
-- delivers ice cream to, and two that are were missing. Confirmed by the owner:
--
--     Makkah   Ruseifa · Awali · Shawqia                     (unchanged)
--     Jeddah   Marwa · Salama · Hamdaniya · Al-Khumra
--              Sanabil · Salhia
--
--     Going    Quraish · Haramain · Obhur
--
-- Chocolate keeps its own list in src/lib/constants.ts (BRANCHES) and is not
-- touched here — that separation is the whole reason the ice cream branches
-- were seeded into a table of their own rather than shared.
--
-- WHY NOT JUST DELETE THE THREE
-- ice_bills.branch_id is ON DELETE RESTRICT, deliberately: a paid bill must
-- keep pointing at the branch it was delivered to, forever. So a branch that
-- has bills is *deactivated*, not deleted — every list in the app filters on
-- active = true, so it leaves the dropdown and the dashboard immediately, while
-- its history stays readable (buildSheet already rescues bills whose branch is
-- no longer in the active list). A branch with no bills at all has no history
-- worth keeping and is deleted outright, so a fresh database does not carry
-- three dead rows around. The block below decides per branch.
--
-- Idempotent: safe to run twice, and safe on a database that has not been
-- seeded yet.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. The two missing Jeddah branches ──────────────────────────────────────
-- name_en follows the bare-transliteration style of the existing rows (Salhia,
-- Hamdaniya) rather than the "Al " prefix — it is a join key in the seed files
-- and the label the English view and the exports show. name_ar is what the
-- managers actually see: the public bill form renders Arabic by default.
--
-- DO UPDATE rather than DO NOTHING so re-running this repairs a row that was
-- half-created or manually deactivated, instead of silently skipping it.

INSERT INTO public.ice_branches (name_en, name_ar, city, sort_order) VALUES
    ('Marwa',  'المروة',  'jeddah', 10),
    ('Salama', 'السلامة', 'jeddah', 20)
ON CONFLICT (name_en) DO UPDATE
   SET name_ar    = EXCLUDED.name_ar,
       city       = EXCLUDED.city,
       sort_order = EXCLUDED.sort_order,
       active     = true;


-- ── 2. Jeddah order ─────────────────────────────────────────────────────────
-- Both the dropdown and the weekly sheet order by sort_order, so this is the
-- order the owner listed the branches in. Makkah already matches (10/20/30) and
-- is left alone.

UPDATE public.ice_branches b
   SET sort_order = v.sort_order
  FROM (VALUES
        ('Hamdaniya', 30),
        ('Al-Khumra', 40),
        ('Sanabil',   50),
        ('Salhia',    60)
       ) AS v(name_en, sort_order)
 WHERE b.name_en = v.name_en
   AND b.sort_order IS DISTINCT FROM v.sort_order;


-- ── 3. A keeper is never left inactive ──────────────────────────────────────
-- Covers the case where one of these was switched off by hand at some point.

UPDATE public.ice_branches
   SET active = true
 WHERE name_en IN ('Ruseifa', 'Awali', 'Shawqia',
                   'Marwa', 'Salama', 'Hamdaniya', 'Al-Khumra', 'Sanabil', 'Salhia')
   AND NOT active;


-- ── 4. Retire the three that are going ──────────────────────────────────────
-- Delete where nothing depends on the row, deactivate where bills exist. Their
-- ice_branch_salesmen rows are ON DELETE CASCADE, so a delete cleans up its own
-- assignment; a deactivated branch keeps its assignment, which is invisible
-- while the branch is inactive and correct again if it is ever switched back on.

DO $retire$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT b.id,
               b.name_en,
               EXISTS (SELECT 1 FROM public.ice_bills bl WHERE bl.branch_id = b.id) AS has_bills
          FROM public.ice_branches b
         WHERE b.name_en IN ('Quraish', 'Haramain', 'Obhur')
    LOOP
        IF r.has_bills THEN
            UPDATE public.ice_branches SET active = false WHERE id = r.id;
            RAISE NOTICE 'Deactivated % — it has bills on record, so the row stays', r.name_en;
        ELSE
            DELETE FROM public.ice_branches WHERE id = r.id;
            RAISE NOTICE 'Deleted % — no bills ever referenced it', r.name_en;
        END IF;
    END LOOP;
END
$retire$;


-- ── 5. Read back what the form will now show ────────────────────────────────

DO $verify$
DECLARE
    r record;
    v_count int;
BEGIN
    SELECT count(*) INTO v_count FROM public.ice_branches WHERE active;

    RAISE NOTICE '── Active ice cream branches (%) ──', v_count;
    FOR r IN
        SELECT city, sort_order, name_en, name_ar
          FROM public.ice_branches
         WHERE active
         ORDER BY city, sort_order
    LOOP
        RAISE NOTICE '  %  %  %  (%)', rpad(r.city, 8), lpad(r.sort_order::text, 3), rpad(r.name_en, 12), r.name_ar;
    END LOOP;

    IF v_count <> 9 THEN
        RAISE WARNING 'Expected 9 active branches, found % — check the list above', v_count;
    END IF;
END
$verify$;
