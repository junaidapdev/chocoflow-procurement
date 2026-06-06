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
      console.error('Audit log insert failed:', error);
    }
  } catch (err) {
    console.error('Audit log write crashed:', err);
  }
}
