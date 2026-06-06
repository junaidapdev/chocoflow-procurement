import { NextRequest, NextResponse } from 'next/server';
import { logAuditEvent } from '@/lib/audit-log';
import { requireRoles } from '@/lib/auth-context';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

type NotificationTarget = 'vendor' | 'salam';

type InvoiceNotificationRecord = {
  id: string;
  brand_name: string;
  branch_id: string;
  invoice_number: string;
  amount: number;
  vendor_notified_at: string | null;
  salam_notified_at: string | null;
};

function safeInvoiceId(id: unknown) {
  return typeof id === 'string' && UUID_PATTERN.test(id) ? id : null;
}

function isNotificationTarget(target: unknown): target is NotificationTarget {
  return target === 'vendor' || target === 'salam';
}

function notificationSnapshot(invoice: InvoiceNotificationRecord) {
  return {
    vendor_notified_at: invoice.vendor_notified_at,
    salam_notified_at: invoice.salam_notified_at,
  };
}

function buildNotificationMetadata(input: {
  invoice?: Partial<InvoiceNotificationRecord> | null;
  target?: unknown;
  reason?: string;
}) {
  return {
    invoice_number: input.invoice?.invoice_number || null,
    brand_name: input.invoice?.brand_name || null,
    branch_id: input.invoice?.branch_id || null,
    amount: input.invoice?.amount ?? null,
    target: typeof input.target === 'string' ? input.target : null,
    reason: input.reason || null,
  };
}

// POST /api/invoices/notify
//
// Marks an invoice as having been notified — either to the vendor (WhatsApp
// "your payment is done" message) or to Salam (internal team notification).
// State lives on the invoice row itself so it's authoritative across all
// browsers and users, not local to whoever clicked first.
//
// Body: { id: string, target: 'vendor' | 'salam' }
export async function POST(request: NextRequest) {
  try {
    const { id, target } = await request.json();
    const invoiceId = safeInvoiceId(id);

    const auth = await requireRoles(request, ['accountant', 'salam']);

    if (!auth.ok) {
      await logAuditEvent({
        action: 'notification.denied',
        entityType: 'invoice',
        entityId: invoiceId,
        entityLabel: typeof id === 'string' ? id : null,
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: auth.error,
        metadata: buildNotificationMetadata({ target, reason: 'insufficient_permissions' }),
        request,
      });

      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    if (!id || !target) {
      await logAuditEvent({
        action: 'notification.denied',
        entityType: 'invoice',
        entityId: invoiceId,
        entityLabel: typeof id === 'string' ? id : null,
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: 'id and target are required',
        metadata: buildNotificationMetadata({ target, reason: 'missing_required_fields' }),
        request,
      });

      return NextResponse.json({ error: 'id and target are required' }, { status: 400 });
    }

    if (!invoiceId) {
      await logAuditEvent({
        action: 'notification.denied',
        entityType: 'invoice',
        entityLabel: typeof id === 'string' ? id : null,
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: 'Invoice ID must be a valid UUID',
        metadata: buildNotificationMetadata({ target, reason: 'invalid_invoice_id' }),
        request,
      });

      return NextResponse.json({ error: 'Invoice ID must be a valid UUID' }, { status: 400 });
    }

    if (!isNotificationTarget(target)) {
      await logAuditEvent({
        action: 'notification.denied',
        entityType: 'invoice',
        entityId: invoiceId,
        entityLabel: typeof id === 'string' ? id : null,
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: "target must be 'vendor' or 'salam'",
        metadata: buildNotificationMetadata({ target, reason: 'invalid_target' }),
        request,
      });

      return NextResponse.json({ error: "target must be 'vendor' or 'salam'" }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdminClient();
    const { data: invoiceRow, error: fetchError } = await supabaseAdmin
      .from('invoices')
      .select('id, brand_name, branch_id, invoice_number, amount, vendor_notified_at, salam_notified_at')
      .eq('id', invoiceId)
      .single();

    if (fetchError || !invoiceRow) {
      await logAuditEvent({
        action: 'notification.update_failed',
        entityType: 'invoice',
        entityId: invoiceId,
        entityLabel: invoiceId,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: fetchError?.message || 'Invoice not found',
        metadata: buildNotificationMetadata({ target, reason: 'invoice_fetch_failed' }),
        request,
      });

      return NextResponse.json({ error: fetchError?.message || 'Invoice not found' }, { status: 404 });
    }

    const invoice = invoiceRow as InvoiceNotificationRecord;
    const column = target === 'vendor' ? 'vendor_notified_at' : 'salam_notified_at';
    const now = new Date().toISOString();
    const afterState = {
      ...notificationSnapshot(invoice),
      [column]: now,
    };

    const { error } = await supabaseAdmin
      .from('invoices')
      .update({ [column]: now })
      .eq('id', invoiceId);

    if (error) {
      console.error('Failed to mark notification:', error);
      await logAuditEvent({
        action: 'notification.update_failed',
        entityType: 'invoice',
        entityId: invoice.id,
        entityLabel: invoice.invoice_number,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: error.message,
        beforeState: notificationSnapshot(invoice),
        afterState,
        metadata: buildNotificationMetadata({
          invoice,
          target,
          reason: 'database_update_failed',
        }),
        request,
      });

      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await logAuditEvent({
      action: target === 'vendor'
        ? 'notification.vendor_marked_sent'
        : 'notification.salam_marked_sent',
      entityType: 'invoice',
      entityId: invoice.id,
      entityLabel: invoice.invoice_number,
      actor: auth.actor,
      outcome: 'success',
      beforeState: notificationSnapshot(invoice),
      afterState,
      metadata: buildNotificationMetadata({ invoice, target }),
      request,
    });

    return NextResponse.json({ success: true, notified_at: now });
  } catch (err) {
    console.error('Error in POST /api/invoices/notify:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
