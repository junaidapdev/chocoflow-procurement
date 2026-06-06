import { NextRequest, NextResponse } from 'next/server';
import { logAuditEvent, type AuditActor } from '@/lib/audit-log';
import { requireAuthContext, type ProfileRole } from '@/lib/auth-context';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_INVOICE_TYPES = ['application/pdf'];
const VALID_STATUSES = ['Pending', 'Verified', 'Rejected', 'Approved', 'ReadyToPay', 'Paid'] as const;

type InvoiceStatus = typeof VALID_STATUSES[number];

type InvoiceForAudit = {
  id: string;
  brand_name: string;
  branch_id: string;
  invoice_number: string;
  invoice_date: string;
  amount: number;
  invoice_url: string | null;
  receipt_url: string | null;
  status: InvoiceStatus;
  rejection_comment: string | null;
  vendor_name: string | null;
  vendor_email: string | null;
  type: 'invoice' | 'return';
};

type TransitionDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function vendorSubmissionActor(vendorName?: string | null): AuditActor {
  return {
    type: 'public',
    role: 'vendor-submission',
    name: vendorName || null,
  };
}

function buildSubmissionMetadata(input: {
  invoice_number?: string | null;
  brand_name?: string | null;
  branch_id?: string | null;
  amountRaw?: string | null;
  amount?: number | null;
  type: 'invoice' | 'return';
  vendor_name?: string | null;
  filePath?: string | null;
  file?: File | null;
  rejectionReason?: string;
}) {
  return {
    invoice_number: input.invoice_number || null,
    brand_name: input.brand_name || null,
    branch_id: input.branch_id || null,
    amount: input.amount ?? input.amountRaw ?? null,
    type: input.type,
    vendor_name: input.vendor_name || null,
    file_path: input.filePath || null,
    file_name: input.file?.name || null,
    file_type: input.file?.type || null,
    file_size: input.file?.size || null,
    rejection_reason: input.rejectionReason || null,
  };
}

function isInvoiceStatus(status: unknown): status is InvoiceStatus {
  return typeof status === 'string' && VALID_STATUSES.includes(status as InvoiceStatus);
}

function safeEntityId(id: unknown) {
  return typeof id === 'string' && UUID_PATTERN.test(id) ? id : null;
}

function invoiceSnapshot(invoice: InvoiceForAudit) {
  return {
    status: invoice.status,
    rejection_comment: invoice.rejection_comment,
    receipt_url: invoice.receipt_url,
    type: invoice.type,
  };
}

function buildStatusMetadata(input: {
  invoice?: Partial<InvoiceForAudit> | null;
  requestedStatus?: unknown;
  rejectionComment?: unknown;
  receiptUrl?: unknown;
  reason?: string;
}) {
  return {
    invoice_number: input.invoice?.invoice_number || null,
    brand_name: input.invoice?.brand_name || null,
    branch_id: input.invoice?.branch_id || null,
    amount: input.invoice?.amount ?? null,
    type: input.invoice?.type || null,
    vendor_name: input.invoice?.vendor_name || null,
    requested_status: typeof input.requestedStatus === 'string' ? input.requestedStatus : null,
    rejection_comment: typeof input.rejectionComment === 'string' ? input.rejectionComment : null,
    receipt_url: typeof input.receiptUrl === 'string' ? input.receiptUrl : null,
    reason: input.reason || null,
  };
}

function getStatusTransitionAction(from: InvoiceStatus, to: InvoiceStatus) {
  if (to === 'Verified') return 'invoice.verified';
  if (to === 'Rejected') return 'invoice.rejected';
  if (from === 'Rejected' && to === 'Pending') return 'invoice.reopened';
  if (to === 'Approved') return 'invoice.approved';
  if (to === 'ReadyToPay') return 'invoice.payment_authorized';
  return 'invoice.status_changed';
}

function validateStatusTransition(input: {
  role: ProfileRole | null;
  from: InvoiceStatus;
  to: InvoiceStatus;
  rejectionComment?: unknown;
}): TransitionDecision {
  const { role, from, to, rejectionComment } = input;

  if (to === 'Paid') {
    return {
      allowed: false,
      reason: 'Paid status must be set through the receipt upload flow.',
    };
  }

  if (role === 'amin') {
    if ((from === 'Pending' || from === 'Rejected') && to === 'Verified') {
      return { allowed: true };
    }

    if (from === 'Pending' && to === 'Rejected') {
      if (typeof rejectionComment !== 'string' || rejectionComment.trim().length === 0) {
        return {
          allowed: false,
          reason: 'Rejection comment is required.',
        };
      }
      return { allowed: true };
    }
  }

  if (role === 'salam') {
    if (from === 'Verified' && to === 'Approved') {
      return { allowed: true };
    }

    if (from === 'Rejected' && to === 'Pending') {
      return { allowed: true };
    }
  }

  if (role === 'accountant' && from === 'Approved' && to === 'ReadyToPay') {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Role ${role || 'unknown'} cannot transition invoice from ${from} to ${to}.`,
  };
}

// POST - Create a new invoice (file upload + DB insert)
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    
    const file = formData.get('file') as File | null;
    const filePath = formData.get('filePath') as string;
    const brand_name = formData.get('brand_name') as string;
    const branch_id = formData.get('branch_id') as string;
    const invoice_number = formData.get('invoice_number') as string;
    const invoice_date = formData.get('invoice_date') as string;
    const amountRaw = formData.get('amount') as string;
    const vendor_name = formData.get('vendor_name') as string;
    const vendor_email = formData.get('vendor_email') as string;
    const typeRaw = (formData.get('type') as string) || 'invoice';
    const type = typeRaw === 'return' ? 'return' : 'invoice';
    const actor = vendorSubmissionActor(vendor_name);

    // --- Validation ---
    if (!file || !filePath) {
      await logAuditEvent({
        action: 'invoice.upload_rejected_invalid_file',
        entityType: type,
        entityLabel: invoice_number,
        actor,
        outcome: 'failure',
        errorMessage: 'File and filePath are required',
        metadata: buildSubmissionMetadata({
          invoice_number,
          brand_name,
          branch_id,
          amountRaw,
          type,
          vendor_name,
          filePath,
          file,
          rejectionReason: 'missing_file_or_file_path',
        }),
        request,
      });
      return NextResponse.json({ error: 'File and filePath are required' }, { status: 400 });
    }

    if (!ALLOWED_INVOICE_TYPES.includes(file.type)) {
      await logAuditEvent({
        action: 'invoice.upload_rejected_invalid_file',
        entityType: type,
        entityLabel: invoice_number,
        actor,
        outcome: 'failure',
        errorMessage: 'Only PDF files are accepted.',
        metadata: buildSubmissionMetadata({
          invoice_number,
          brand_name,
          branch_id,
          amountRaw,
          type,
          vendor_name,
          filePath,
          file,
          rejectionReason: 'invalid_file_type',
        }),
        request,
      });
      return NextResponse.json({ error: 'Only PDF files are accepted.' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      await logAuditEvent({
        action: 'invoice.upload_rejected_too_large',
        entityType: type,
        entityLabel: invoice_number,
        actor,
        outcome: 'failure',
        errorMessage: 'File exceeds the 5MB size limit.',
        metadata: buildSubmissionMetadata({
          invoice_number,
          brand_name,
          branch_id,
          amountRaw,
          type,
          vendor_name,
          filePath,
          file,
          rejectionReason: 'file_too_large',
        }),
        request,
      });
      return NextResponse.json({ error: 'File exceeds the 5MB size limit.' }, { status: 400 });
    }

    const amount = Number(amountRaw);
    if (isNaN(amount) || amount <= 0) {
      await logAuditEvent({
        action: 'invoice.upload_rejected_invalid_amount',
        entityType: type,
        entityLabel: invoice_number,
        actor,
        outcome: 'failure',
        errorMessage: 'Amount must be a positive number greater than zero.',
        metadata: buildSubmissionMetadata({
          invoice_number,
          brand_name,
          branch_id,
          amountRaw,
          type,
          vendor_name,
          filePath,
          file,
          rejectionReason: 'invalid_amount',
        }),
        request,
      });
      return NextResponse.json({ error: 'Amount must be a positive number greater than zero.' }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdminClient();

    // --- Duplicate check (scoped by type, so an invoice and a return
    // with the same number don't collide) ---
    const { data: existingInvoice } = await supabaseAdmin
      .from('invoices')
      .select('id')
      .eq('invoice_number', invoice_number)
      .eq('brand_name', brand_name)
      .eq('type', type)
      .limit(1)
      .maybeSingle();

    if (existingInvoice) {
      const label = type === 'return' ? 'return bill number' : 'invoice number';
      await logAuditEvent({
        action: 'invoice.duplicate_rejected',
        entityType: type,
        entityId: existingInvoice.id,
        entityLabel: invoice_number,
        actor,
        outcome: 'denied',
        errorMessage: `Duplicate ${label} for this brand`,
        metadata: buildSubmissionMetadata({
          invoice_number,
          brand_name,
          branch_id,
          amount,
          type,
          vendor_name,
          filePath,
          file,
          rejectionReason: 'duplicate_invoice_number_for_brand',
        }),
        request,
      });
      return NextResponse.json(
        { error: `This ${label} already exists for this brand. Please check and resubmit.` },
        { status: 409 }
      );
    }

    // --- 1. Upload file to storage ---
    const buffer = Buffer.from(await file.arrayBuffer());
    const { error: uploadError } = await supabaseAdmin.storage
      .from('invoices')
      .upload(filePath, buffer, { 
        upsert: true,
        contentType: file.type 
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      await logAuditEvent({
        action: 'invoice.storage_upload_failed',
        entityType: type,
        entityLabel: invoice_number,
        actor,
        outcome: 'failure',
        errorMessage: uploadError.message,
        metadata: buildSubmissionMetadata({
          invoice_number,
          brand_name,
          branch_id,
          amount,
          type,
          vendor_name,
          filePath,
          file,
          rejectionReason: 'storage_upload_failed',
        }),
        request,
      });
      return NextResponse.json({ error: `Upload Failed: ${uploadError.message}` }, { status: 500 });
    }

    // --- 2. Insert into DB ---
    const { data: insertedInvoice, error: dbError } = await supabaseAdmin
      .from('invoices')
      .insert({
        brand_name,
        branch_id,
        invoice_number,
        invoice_date,
        amount,
        invoice_url: filePath,
        vendor_name,
        vendor_email,
        status: 'Pending',
        type,
      })
      .select('id')
      .single();

    if (dbError) {
      console.error('DB insert error:', dbError);
      // Cleanup: remove the uploaded file since DB insert failed
      await supabaseAdmin.storage.from('invoices').remove([filePath]);
      await logAuditEvent({
        action: 'invoice.database_insert_failed',
        entityType: type,
        entityLabel: invoice_number,
        actor,
        outcome: 'failure',
        errorMessage: dbError.message,
        metadata: buildSubmissionMetadata({
          invoice_number,
          brand_name,
          branch_id,
          amount,
          type,
          vendor_name,
          filePath,
          file,
          rejectionReason: 'database_insert_failed',
        }),
        request,
      });
      return NextResponse.json({ error: `Database Error: ${dbError.message}` }, { status: 500 });
    }

    await logAuditEvent({
      action: type === 'return' ? 'return.submitted' : 'invoice.submitted',
      entityType: type,
      entityId: insertedInvoice?.id || null,
      entityLabel: invoice_number,
      actor,
      outcome: 'success',
      afterState: {
        status: 'Pending',
        type,
      },
      metadata: buildSubmissionMetadata({
        invoice_number,
        brand_name,
        branch_id,
        amount,
        type,
        vendor_name,
        filePath,
        file,
      }),
      request,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error in POST /api/invoices:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PUT - Update invoice status
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, status, rejection_comment, receipt_url } = body;

    const auth = await requireAuthContext(request);

    if (!auth.ok) {
      await logAuditEvent({
        action: 'invoice.status_change_denied',
        entityType: 'invoice',
        entityId: safeEntityId(id),
        entityLabel: typeof id === 'string' ? id : null,
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: auth.error,
        metadata: buildStatusMetadata({
          requestedStatus: status,
          rejectionComment: rejection_comment,
          receiptUrl: receipt_url,
          reason: 'auth_context_missing_or_invalid',
        }),
        request,
      });

      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    if (!id || !status) {
      await logAuditEvent({
        action: 'invoice.status_change_failed',
        entityType: 'invoice',
        entityId: safeEntityId(id),
        entityLabel: typeof id === 'string' ? id : null,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: 'ID and status are required',
        metadata: buildStatusMetadata({
          requestedStatus: status,
          rejectionComment: rejection_comment,
          receiptUrl: receipt_url,
          reason: 'missing_required_fields',
        }),
        request,
      });

      return NextResponse.json({ error: 'ID and status are required' }, { status: 400 });
    }

    if (!isInvoiceStatus(status)) {
      await logAuditEvent({
        action: 'invoice.status_change_failed',
        entityType: 'invoice',
        entityId: safeEntityId(id),
        entityLabel: typeof id === 'string' ? id : null,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
        metadata: buildStatusMetadata({
          requestedStatus: status,
          rejectionComment: rejection_comment,
          receiptUrl: receipt_url,
          reason: 'invalid_requested_status',
        }),
        request,
      });

      return NextResponse.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 });
    }

    const invoiceId = safeEntityId(id);
    if (!invoiceId) {
      await logAuditEvent({
        action: 'invoice.status_change_failed',
        entityType: 'invoice',
        entityLabel: typeof id === 'string' ? id : null,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: 'Invoice ID must be a valid UUID',
        metadata: buildStatusMetadata({
          requestedStatus: status,
          rejectionComment: rejection_comment,
          receiptUrl: receipt_url,
          reason: 'invalid_invoice_id',
        }),
        request,
      });

      return NextResponse.json({ error: 'Invoice ID must be a valid UUID' }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdminClient();

    const { data: currentInvoice, error: fetchError } = await supabaseAdmin
      .from('invoices')
      .select('id, brand_name, branch_id, invoice_number, invoice_date, amount, invoice_url, receipt_url, status, rejection_comment, vendor_name, vendor_email, type')
      .eq('id', invoiceId)
      .single();

    if (fetchError || !currentInvoice) {
      await logAuditEvent({
        action: 'invoice.status_change_failed',
        entityType: 'invoice',
        entityId: invoiceId,
        entityLabel: invoiceId,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: fetchError?.message || 'Invoice not found',
        metadata: buildStatusMetadata({
          requestedStatus: status,
          rejectionComment: rejection_comment,
          receiptUrl: receipt_url,
          reason: 'invoice_fetch_failed',
        }),
        request,
      });

      return NextResponse.json({ error: fetchError?.message || 'Invoice not found' }, { status: 404 });
    }

    const invoice = currentInvoice as InvoiceForAudit;

    if (!isInvoiceStatus(invoice.status)) {
      await logAuditEvent({
        action: 'invoice.status_change_failed',
        entityType: invoice.type,
        entityId: invoice.id,
        entityLabel: invoice.invoice_number,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: `Current invoice status is invalid: ${invoice.status}`,
        metadata: buildStatusMetadata({
          invoice,
          requestedStatus: status,
          rejectionComment: rejection_comment,
          receiptUrl: receipt_url,
          reason: 'invalid_current_status',
        }),
        request,
      });

      return NextResponse.json({ error: 'Current invoice status is invalid' }, { status: 500 });
    }

    if (receipt_url) {
      await logAuditEvent({
        action: 'invoice.status_change_denied',
        entityType: invoice.type,
        entityId: invoice.id,
        entityLabel: invoice.invoice_number,
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: 'Receipt URL must be set through the receipt upload flow.',
        beforeState: invoiceSnapshot(invoice),
        metadata: buildStatusMetadata({
          invoice,
          requestedStatus: status,
          rejectionComment: rejection_comment,
          receiptUrl: receipt_url,
          reason: 'receipt_url_not_allowed_on_status_route',
        }),
        request,
      });

      return NextResponse.json(
        { error: 'Receipt URL must be set through the receipt upload flow.' },
        { status: 403 }
      );
    }

    const transition = validateStatusTransition({
      role: auth.context.profile.role,
      from: invoice.status,
      to: status,
      rejectionComment: rejection_comment,
    });

    if (!transition.allowed) {
      await logAuditEvent({
        action: 'invoice.status_change_denied',
        entityType: invoice.type,
        entityId: invoice.id,
        entityLabel: invoice.invoice_number,
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: transition.reason,
        beforeState: invoiceSnapshot(invoice),
        metadata: buildStatusMetadata({
          invoice,
          requestedStatus: status,
          rejectionComment: rejection_comment,
          reason: transition.reason,
        }),
        request,
      });

      return NextResponse.json({ error: transition.reason }, { status: 403 });
    }

    const updateData: Record<string, string | null> = { status };
    if (status === 'Rejected') updateData.rejection_comment = rejection_comment.trim();

    const { error } = await supabaseAdmin
      .from('invoices')
      .update(updateData)
      .eq('id', invoiceId);

    if (error) {
      console.error('Error updating invoice:', error);
      await logAuditEvent({
        action: 'invoice.status_change_failed',
        entityType: invoice.type,
        entityId: invoice.id,
        entityLabel: invoice.invoice_number,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: error.message,
        beforeState: invoiceSnapshot(invoice),
        afterState: {
          ...invoiceSnapshot(invoice),
          status,
          rejection_comment: status === 'Rejected' ? rejection_comment.trim() : invoice.rejection_comment,
        },
        metadata: buildStatusMetadata({
          invoice,
          requestedStatus: status,
          rejectionComment: rejection_comment,
          reason: 'database_update_failed',
        }),
        request,
      });

      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await logAuditEvent({
      action: getStatusTransitionAction(invoice.status, status),
      entityType: invoice.type,
      entityId: invoice.id,
      entityLabel: invoice.invoice_number,
      actor: auth.actor,
      outcome: 'success',
      beforeState: invoiceSnapshot(invoice),
      afterState: {
        ...invoiceSnapshot(invoice),
        status,
        rejection_comment: status === 'Rejected' ? rejection_comment.trim() : invoice.rejection_comment,
      },
      metadata: buildStatusMetadata({
        invoice,
        requestedStatus: status,
        rejectionComment: rejection_comment,
      }),
      request,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error in PUT /api/invoices:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
