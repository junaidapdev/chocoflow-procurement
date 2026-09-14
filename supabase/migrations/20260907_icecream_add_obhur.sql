-- ─────────────────────────────────────────────────────────────────────────────
-- Obhur rejoins the Jeddah list
--
-- 20260824_icecream_branch_list.sql retired Quraish, Haramain and Obhur on the
-- owner's confirmation. Obhur is taking deliveries again, so it comes back:
--
--     Jeddah   Marwa · Salama · Hamdaniya · Al-Khumra · Sanabil · Salhia
--              · Obhur                                          (ten branches)
--
-- Confirmed by the owner: Obhur is covered by Islam Ali, who also covers
-- Salama. One salesman covering two branches is normal here and the schema is
-- built for it — Saifullah Khan already covers Hamdaniya and Salhia, and the
-- weekly sheet lists one row per branch *assignment*, so Islam Ali correctly
-- appears twice in the summary.
--
-- THE TWO STATES OBHUR COULD BE IN
-- The retirement decided per branch: delete where nothing referenced the row,
-- deactivate where bills existed. Which of the two happened to Obhur depends on
-- whether it had bills on the day that migration ran, which this file cannot
-- know. It does not need to — both paths below converge on the same result:
--
--   deleted      → section 1 recreates the row (new uuid, no assignment
--                  survived the cascade), section 2 assigns Islam Ali.
--   deactivated  → section 1 flips active back on. Its original assignment to
--                  Islam Ali was never closed, so section 2's guard finds a
--                  current assignment and correctly leaves it alone.
--
-- No bill backfill is needed here, unlike the Marwa/Salama repair. A branch was
-- only ever deleted when it had no bills, and a deactivated Obhur's bills were
-- filed while Islam Ali was assigned, so they already carry his id. There is no
-- state in which an Obhur bill holds a null salesman.
--
-- ⚠ ORDERING: 20260824_icecream_branch_list.sql section 4 retires Obhur, and
-- its section 5 warns unless exactly 9 branches are active. Re-running that
-- file after this one would deactivate Obhur again. It is a historical
-- migration and should not be re-run; this file is the current word on the
-- branch list.
--
-- Idempotent: safe to run twice.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. The branch ───────────────────────────────────────────────────────────
-- name_en, name_ar and sort_order are the values Obhur carried in the original
-- August seed, so a recreated row is indistinguishable from the one that was
-- retired. sort_order 70 puts it after Salhia (60), at the end of Jeddah.
--
-- DO UPDATE rather than DO NOTHING is what makes this work for the deactivated
-- case: the row already exists, and `active = true` is the whole point.

INSERT INTO public.ice_branches (name_en, name_ar, city, sort_order) VALUES
    ('Obhur', 'أبحر', 'jeddah', 70)
ON CONFLICT (name_en) DO UPDATE
   SET name_ar    = EXCLUDED.name_ar,
       city       = EXCLUDED.city,
       sort_order = EXCLUDED.sort_order,
       active     = true;


-- ── 2. Islam Ali covers it ──────────────────────────────────────────────────
-- Guarded on "no current assignment" rather than ON CONFLICT, because the
-- uniqueness rule is a partial index (uq_ice_branch_current_salesman, WHERE
-- effective_to IS NULL) and ON CONFLICT cannot target it. The guard is also the
-- behaviour we want twice over: it is what makes the deactivated case a no-op,
-- and it means a hand-made assignment is a live decision this file won't
-- overwrite.
--
-- effective_from is today, not backdated. Obhur was off the list until now, so
-- there is no earlier period this assignment can honestly claim. Where the row
-- survived deactivation its original 2026-01-01 date stands instead, which is
-- equally honest — Islam Ali never stopped covering Obhur, the branch just left
-- the list for a fortnight.

INSERT INTO public.ice_salesmen (name) VALUES ('Islam Ali')
ON CONFLICT (name) DO NOTHING;

UPDATE public.ice_salesmen
   SET active = true
 WHERE name = 'Islam Ali' AND NOT active;

INSERT INTO public.ice_branch_salesmen (branch_id, salesman_id, effective_from)
SELECT br.id, sm.id, DATE '2026-09-07'
FROM public.ice_branches br
CROSS JOIN public.ice_salesmen sm
WHERE br.name_en = 'Obhur'
  AND sm.name    = 'Islam Ali'
  AND NOT EXISTS (
      SELECT 1 FROM public.ice_branch_salesmen x
      WHERE x.branch_id = br.id AND x.effective_to IS NULL
  );


-- ── 3. Read back what the form and the sheet will now show ──────────────────

DO $verify$
DECLARE
    r record;
    v_count      int;
    v_unassigned int;
BEGIN
    SELECT count(*) INTO v_count FROM public.ice_branches WHERE active;

    RAISE NOTICE '── Active branches and their current salesman (%) ──', v_count;
    FOR r IN
        SELECT b.city, b.sort_order, b.name_en, b.name_ar,
               coalesce(s.name, '(none)') AS salesman
          FROM public.ice_branches b
          LEFT JOIN public.ice_branch_salesmen a
                 ON a.branch_id = b.id AND a.effective_to IS NULL
          LEFT JOIN public.ice_salesmen s ON s.id = a.salesman_id
         WHERE b.active
         ORDER BY b.city, b.sort_order
    LOOP
        RAISE NOTICE '  %  %  %  %  (%)',
            rpad(r.city, 8), lpad(r.sort_order::text, 3),
            rpad(r.name_en, 12), rpad(r.salesman, 16), r.name_ar;
    END LOOP;

    SELECT count(*) INTO v_unassigned
      FROM public.ice_branches b
     WHERE b.active
       AND NOT EXISTS (
           SELECT 1 FROM public.ice_branch_salesmen a
            WHERE a.branch_id = b.id AND a.effective_to IS NULL
       );

    IF v_count <> 10 THEN
        RAISE WARNING 'Expected 10 active branches, found % — check the list above', v_count;
    END IF;

    IF v_unassigned > 0 THEN
        RAISE WARNING '% active branch(es) have no salesman — check the list above', v_unassigned;
    END IF;
END
$verify$;
