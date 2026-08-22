-- ─────────────────────────────────────────────────────────────────────────────
-- Create the audit_logs table
--
-- Run this ONCE against your existing Supabase project (SQL Editor → paste →
-- Run). Safe to re-run: the table, indexes and policy are all guarded.
--
-- WHY THIS EXISTS
-- audit_logs ships in supabase/schema.sql, which is the FRESH-INSTALL script —
-- it only ever runs when a brand-new project is set up. A project created
-- before that section was added therefore never got the table, and nothing
-- surfaced the gap: logAuditEvent() deliberately swallows write failures so an
-- audit problem can never fail a payment, and the Audit Logs dashboard rendered
-- an empty list that looks identical to "nothing has happened yet".
--
-- The result is that every audit event since the feature shipped was dropped.
-- This file creates the table so recording starts working again. It cannot
-- recover the events already lost.
--
-- This is a copy of the audit-logging section of schema.sql, extracted so it
-- can be applied on its own — schema.sql as a whole cannot be re-run against a
-- live database, because ~17 of its CREATE TRIGGER / CREATE POLICY statements
-- have no IF NOT EXISTS guard and fail on the first one that already exists.
-- ─────────────────────────────────────────────────────────────────────────────


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
