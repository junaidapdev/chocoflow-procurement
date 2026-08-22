import type { NextRequest } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

export type AuditActor = {
  userId?: string | null;
  role?: string | null;
  email?: string | null;
  name?: string | null;
  type?: 'authenticated' | 'public' | 'system';
};

export type AuditOutcome = 'success' | 'failure' | 'denied';

type JsonLike =
  | string
  | number
  | boolean
  | null
  | JsonLike[]
  | { [key: string]: JsonLike };

export type AuditLogInput = {
  action: string;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  actor?: AuditActor | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  request?: NextRequest | Request | null;
  outcome?: AuditOutcome;
  errorMessage?: string | null;
};

const SENSITIVE_KEY_PATTERN = /password|token|secret|key|authorization|cookie|session/i;

function getRequestIp(request?: NextRequest | Request | null) {
  if (!request) return null;

  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0]?.trim() || null;

  return (
    request.headers.get('x-real-ip') ||
    request.headers.get('cf-connecting-ip') ||
    null
  );
}

function sanitizeForJson(value: unknown): JsonLike {
  if (value == null) return null;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof File !== 'undefined' && value instanceof File) {
    return {
      name: value.name,
      type: value.type,
      size: value.size,
    };
  }

  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return {
      type: value.type,
      size: value.size,
    };
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForJson(item));
  }

  if (typeof value === 'object') {
    const safe: Record<string, JsonLike> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        safe[key] = '[REDACTED]';
        continue;
      }
      safe[key] = sanitizeForJson(nestedValue);
    }
    return safe;
  }

  return String(value);
}

function normalizeObject(value?: Record<string, unknown> | null) {
  if (!value) return null;
  return sanitizeForJson(value);
}

// Audit writes must never fail the business operation that triggered them — a
// payment going through matters more than its ledger row. The cost of that
// choice is silence: audit_logs was missing from the live database for months
// and every insert failed unnoticed, because a swallowed error looks exactly
// like no error.
//
// So we still don't throw, but we make the failure loud in the server logs and
// countable, so the Audit Logs dashboard can tell "nothing happened" apart from
// "nothing was recorded".

// PostgREST reports a missing table as PGRST205; Postgres itself uses 42P01.
const MISSING_TABLE_CODES = new Set(['PGRST205', '42P01']);

export type AuditLogHealth = {
  failures: number;
  lastError: string | null;
  lastFailedAt: string | null;
  tableMissing: boolean;
};

let health: AuditLogHealth = {
  failures: 0,
  lastError: null,
  lastFailedAt: null,
  tableMissing: false,
};

function recordAuditFailure(message: string, code?: string, action?: string) {
  const tableMissing = code ? MISSING_TABLE_CODES.has(code) : /audit_logs/.test(message);

  health = {
    failures: health.failures + 1,
    lastError: message,
    lastFailedAt: new Date().toISOString(),
    tableMissing: health.tableMissing || tableMissing,
  };

  console.error(
    `[AUDIT-LOG FAILURE] action=${action || 'unknown'} code=${code || 'none'} ` +
      `total_failures=${health.failures}: ${message}` +
      (tableMissing
        ? ' — the audit_logs table does not exist. Run supabase/migrations/20260822_create_audit_logs.sql.'
        : '')
  );
}

// Read by the Audit Logs dashboard. Counts are per server instance and reset on
// deploy, so treat this as a live signal rather than a historical total.
export function getAuditLogHealth(): AuditLogHealth {
  return { ...health };
}

export async function logAuditEvent(input: AuditLogInput): Promise<void> {
  const actor = input.actor;

  try {
    const supabaseAdmin = getSupabaseAdminClient();
    const { error } = await supabaseAdmin.from('audit_logs').insert({
      actor_user_id: actor?.userId || null,
      actor_role: actor?.role || null,
      actor_email: actor?.email || null,
      actor_name: actor?.name || null,
      actor_type: actor?.type || (actor?.userId ? 'authenticated' : 'system'),
      action: input.action,
      outcome: input.outcome || 'success',
      error_message: input.errorMessage || null,
      entity_type: input.entityType,
      entity_id: input.entityId || null,
      entity_label: input.entityLabel || null,
      before_state: normalizeObject(input.beforeState),
      after_state: normalizeObject(input.afterState),
      metadata: normalizeObject(input.metadata) || {},
      request_ip: getRequestIp(input.request),
      user_agent: input.request?.headers.get('user-agent') || null,
    });

    if (error) {
      recordAuditFailure(error.message, error.code, input.action);
    }
  } catch (err) {
    recordAuditFailure(
      err instanceof Error ? err.message : String(err),
      undefined,
      input.action
    );
  }
}
