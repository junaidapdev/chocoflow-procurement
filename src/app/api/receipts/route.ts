import { NextRequest, NextResponse } from 'next/server';
import { logAuditEvent } from '@/lib/audit-log';
import { requireRoles } from '@/lib/auth-context';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_RECEIPT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PaymentInvoice = {
  id: string;
  brand_name: string;
  branch_id: string;
  invoice_number: string;
  invoice_date: string;
  amount: number;
  status: string;
  type: 'invoice' | 'return';
  vendor_name: string | null;
  vendor_email: string | null;
  receipt_url: string | null;
  applied_to_invoice_id: string | null;
};

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

function validateUuidList(values: string[]) {
  return values.every(value => UUID_PATTERN.test(value));
}

function parseJsonStringArray(value: string | null, fieldName: string) {
  if (!value) return { ok: true as const, values: [] as string[] };

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return { ok: false as const, error: `${fieldName} must be a JSON array of strings` };
    }

    return {
      ok: true as const,
      values: uniqueStrings(parsed.filter((x): x is string => typeof x === 'string' && x.length > 0)),
    };
  } catch {
    return { ok: false as const, error: `${fieldName} must be a JSON array of strings` };
  }
}

function sumAmounts(rows: Pick<PaymentInvoice, 'amount'>[]) {
  return rows.reduce((sum, row) => sum + Number(row.amount), 0);
}

function buildPaymentMetadata(input: {
  invoiceIds?: string[];
  invoiceNumbers?: string[];
  grossTotal?: number | null;
  appliedReturnIds?: string[];
  returnNumbers?: string[];
  returnTotal?: number | null;
  netPayable?: number | null;
  receiptPath?: string | null;
  receiptPublicUrl?: string | null;
  file?: File | null;
  reason?: string;
}) {
  return {
    invoice_ids: input.invoiceIds || [],
    invoice_numbers: input.invoiceNumbers || [],
    gross_total: input.grossTotal ?? null,
    applied_return_ids: input.appliedReturnIds || [],
    return_numbers: input.returnNumbers || [],
    return_total: input.returnTotal ?? null,
    net_payable: input.netPayable ?? null,
    receipt_path: input.receiptPath || null,
    receipt_public_url: input.receiptPublicUrl || null,
    file_name: input.file?.name || null,
    file_type: input.file?.type || null,
    file_size: input.file?.size || null,
    reason: input.reason || null,
  };
}

// POST - Upload a single receipt and mark one OR many invoices as Paid.
//
// Input (multipart/form-data):
//   file          — receipt PDF/image (required)
//   filePath      — storage path (required)
//   invoiceIds    — JSON array of invoice UUIDs (preferred; batch mode)
//   invoiceId     — single invoice UUID (legacy; still accepted)
//   appliedReturnIds — JSON array of return invoice UUIDs (optional)
//
// One bank transfer often covers several branch invoices from the same
// vendor — the payer selects them and uploads a single bank receipt.
// All selected invoices share the same receipt_url.
export async function POST(request: NextRequest) {
  try {
    const auth = await requireRoles(request, ['payer', 'salam']);

    if (!auth.ok) {
      await logAuditEvent({
        action: 'payment.denied',
        entityType: 'payment_batch',
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: auth.error,
        metadata: buildPaymentMetadata({ reason: 'insufficient_permissions' }),
        request,
      });

      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const formData = await request.formData();

    const file = formData.get('file') as File | null;
    const filePath = formData.get('filePath') as string;
    const legacyInvoiceId = formData.get('invoiceId') as string | null;
    const invoiceIdsRaw = formData.get('invoiceIds') as string | null;
    const appliedReturnIdsRaw = formData.get('appliedReturnIds') as string | null;

    // --- Parse invoice IDs (batch or legacy single) ---
    let invoiceIds: string[] = [];
    if (invoiceIdsRaw) {
      const parsedInvoiceIds = parseJsonStringArray(invoiceIdsRaw, 'invoiceIds');
      if (!parsedInvoiceIds.ok) {
        await logAuditEvent({
          action: 'payment.denied',
          entityType: 'payment_batch',
          actor: auth.actor,
          outcome: 'denied',
          errorMessage: parsedInvoiceIds.error,
          metadata: buildPaymentMetadata({ reason: 'invalid_invoice_ids_json' }),
          request,
        });

        return NextResponse.json({ error: parsedInvoiceIds.error }, { status: 400 });
      }
      invoiceIds = parsedInvoiceIds.values;
    } else if (legacyInvoiceId) {
      invoiceIds = [legacyInvoiceId];
    }

    if (!file || !filePath || invoiceIds.length === 0) {
      await logAuditEvent({
        action: file ? 'payment.denied' : 'payment.receipt_upload_failed',
        entityType: 'payment_batch',
        actor: auth.actor,
        outcome: file ? 'denied' : 'failure',
        errorMessage: 'file, filePath, and at least one invoice ID are required',
        metadata: buildPaymentMetadata({
          invoiceIds,
          receiptPath: filePath,
          file,
          reason: 'missing_required_fields',
        }),
        request,
      });

      return NextResponse.json({ error: 'file, filePath, and at least one invoice ID are required' }, { status: 400 });
    }

    // --- Parse applied return IDs (optional) ---
    let appliedReturnIds: string[] = [];
    if (appliedReturnIdsRaw) {
      const parsedReturnIds = parseJsonStringArray(appliedReturnIdsRaw, 'appliedReturnIds');
      if (!parsedReturnIds.ok) {
        await logAuditEvent({
          action: 'payment.denied',
          entityType: 'payment_batch',
          actor: auth.actor,
          outcome: 'denied',
          errorMessage: parsedReturnIds.error,
          metadata: buildPaymentMetadata({
            invoiceIds,
            receiptPath: filePath,
            file,
            reason: 'invalid_applied_return_ids_json',
          }),
          request,
        });

        return NextResponse.json({ error: parsedReturnIds.error }, { status: 400 });
      }
      appliedReturnIds = parsedReturnIds.values;
    }

    invoiceIds = uniqueStrings(invoiceIds);
    appliedReturnIds = uniqueStrings(appliedReturnIds);

    if (!validateUuidList(invoiceIds) || !validateUuidList(appliedReturnIds)) {
      await logAuditEvent({
        action: 'payment.denied',
        entityType: 'payment_batch',
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: 'Invoice and return IDs must be valid UUIDs',
        metadata: buildPaymentMetadata({
          invoiceIds,
          appliedReturnIds,
          receiptPath: filePath,
          file,
          reason: 'invalid_uuid',
        }),
        request,
      });

      return NextResponse.json({ error: 'Invoice and return IDs must be valid UUIDs' }, { status: 400 });
    }

    // --- File validation ---
    if (!ALLOWED_RECEIPT_TYPES.includes(file.type)) {
      await logAuditEvent({
        action: 'payment.receipt_upload_failed',
        entityType: 'payment_batch',
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: 'Only PDF and image files (JPEG, PNG, WebP) are accepted for receipts.',
        metadata: buildPaymentMetadata({
          invoiceIds,
          appliedReturnIds,
          receiptPath: filePath,
          file,
          reason: 'invalid_receipt_file_type',
        }),
        request,
      });

      return NextResponse.json({ error: 'Only PDF and image files (JPEG, PNG, WebP) are accepted for receipts.' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      await logAuditEvent({
        action: 'payment.receipt_upload_failed',
        entityType: 'payment_batch',
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: 'File exceeds the 5MB size limit.',
        metadata: buildPaymentMetadata({
          invoiceIds,
          appliedReturnIds,
          receiptPath: filePath,
          file,
          reason: 'receipt_file_too_large',
        }),
        request,
      });

      return NextResponse.json({ error: 'File exceeds the 5MB size limit.' }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdminClient();

    // --- Fetch and validate selected invoices before mutating money state ---
    const { data: invoiceRows, error: invoiceFetchError } = await supabaseAdmin
      .from('invoices')
      .select('id, brand_name, branch_id, invoice_number, invoice_date, amount, status, type, vendor_name, vendor_email, receipt_url, applied_to_invoice_id')
      .in('id', invoiceIds);

    const invoices = (invoiceRows || []) as PaymentInvoice[];
    const invoiceNumbers = invoices.map(inv => inv.invoice_number);
    const grossTotal = sumAmounts(invoices);
    const invoiceIdSet = new Set(invoices.map(inv => inv.id));
    const missingInvoiceIds = invoiceIds.filter(id => !invoiceIdSet.has(id));

    if (invoiceFetchError || missingInvoiceIds.length > 0) {
      await logAuditEvent({
        action: 'payment.denied',
        entityType: 'payment_batch',
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: invoiceFetchError?.message || 'One or more invoices were not found',
        metadata: buildPaymentMetadata({
          invoiceIds,
          invoiceNumbers,
          grossTotal,
          appliedReturnIds,
          receiptPath: filePath,
          file,
          reason: missingInvoiceIds.length > 0 ? 'invoice_not_found' : 'invoice_fetch_failed',
        }),
        request,
      });

      return NextResponse.json({ error: invoiceFetchError?.message || 'One or more invoices were not found' }, { status: 400 });
    }

    const invalidInvoices = invoices.filter(inv => inv.type !== 'invoice' || inv.status !== 'ReadyToPay');
    if (invalidInvoices.length > 0) {
      await logAuditEvent({
        action: 'payment.denied',
        entityType: 'payment_batch',
        entityId: invoices[0]?.id || null,
        entityLabel: invoiceNumbers[0] || null,
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: 'All selected invoices must be invoice rows in ReadyToPay status',
        metadata: buildPaymentMetadata({
          invoiceIds,
          invoiceNumbers,
          grossTotal,
          appliedReturnIds,
          receiptPath: filePath,
          file,
          reason: 'invoice_not_ready_to_pay',
        }),
        request,
      });

      return NextResponse.json({ error: 'All selected invoices must be invoice rows in ReadyToPay status' }, { status: 400 });
    }

    // --- Fetch and validate selected return credits before applying them ---
    let returnCredits: PaymentInvoice[] = [];
    let returnNumbers: string[] = [];
    let returnTotal = 0;

    if (appliedReturnIds.length > 0) {
      const { data: returnRows, error: returnFetchError } = await supabaseAdmin
        .from('invoices')
        .select('id, brand_name, branch_id, invoice_number, invoice_date, amount, status, type, vendor_name, vendor_email, receipt_url, applied_to_invoice_id')
        .in('id', appliedReturnIds);

      returnCredits = (returnRows || []) as PaymentInvoice[];
      returnNumbers = returnCredits.map(ret => ret.invoice_number);
      returnTotal = sumAmounts(returnCredits);

      const returnIdSet = new Set(returnCredits.map(ret => ret.id));
      const missingReturnIds = appliedReturnIds.filter(id => !returnIdSet.has(id));
      const invoiceBrands = uniqueStrings(invoices.map(inv => inv.brand_name));
      const selectedBrand = invoiceBrands.length === 1 ? invoiceBrands[0] : null;
      const invalidReturns = returnCredits.filter(ret =>
        ret.type !== 'return' ||
        ret.status !== 'Approved' ||
        ret.applied_to_invoice_id !== null ||
        !selectedBrand ||
        ret.brand_name !== selectedBrand
      );

      if (returnFetchError || missingReturnIds.length > 0 || invalidReturns.length > 0) {
        await logAuditEvent({
          action: 'payment.denied',
          entityType: 'payment_batch',
          entityId: invoices[0]?.id || null,
          entityLabel: invoiceNumbers[0] || null,
          actor: auth.actor,
          outcome: 'denied',
          errorMessage: returnFetchError?.message || 'Applied return credits are invalid for this payment',
          metadata: buildPaymentMetadata({
            invoiceIds,
            invoiceNumbers,
            grossTotal,
            appliedReturnIds,
            returnNumbers,
            returnTotal,
            netPayable: Math.max(0, grossTotal - returnTotal),
            receiptPath: filePath,
            file,
            reason: returnFetchError
              ? 'return_credit_fetch_failed'
              : missingReturnIds.length > 0
                ? 'return_credit_not_found'
                : 'return_credit_invalid_or_wrong_brand',
          }),
          request,
        });

        return NextResponse.json({ error: returnFetchError?.message || 'Applied return credits are invalid for this payment' }, { status: 400 });
      }

      if (returnTotal > grossTotal) {
        await logAuditEvent({
          action: 'payment.denied',
          entityType: 'payment_batch',
          entityId: invoices[0]?.id || null,
          entityLabel: invoiceNumbers[0] || null,
          actor: auth.actor,
          outcome: 'denied',
          errorMessage: 'Applied return credits cannot exceed the selected invoice total',
          metadata: buildPaymentMetadata({
            invoiceIds,
            invoiceNumbers,
            grossTotal,
            appliedReturnIds,
            returnNumbers,
            returnTotal,
            netPayable: Math.max(0, grossTotal - returnTotal),
            receiptPath: filePath,
            file,
            reason: 'return_credit_exceeds_gross_total',
          }),
          request,
        });

        return NextResponse.json({ error: 'Applied return credits cannot exceed the selected invoice total' }, { status: 400 });
      }
    }

    const netPayable = Math.max(0, grossTotal - returnTotal);

    // --- 1. Upload receipt to storage (once) ---
    const buffer = Buffer.from(await file.arrayBuffer());
    const { error: uploadError } = await supabaseAdmin.storage
      .from('receipts')
      .upload(filePath, buffer, { upsert: true, contentType: file.type });

    if (uploadError) {
      console.error('Receipt upload error:', uploadError);
      await logAuditEvent({
        action: 'payment.receipt_upload_failed',
        entityType: 'payment_batch',
        entityId: invoices[0]?.id || null,
        entityLabel: invoiceNumbers[0] || null,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: uploadError.message,
        metadata: buildPaymentMetadata({
          invoiceIds,
          invoiceNumbers,
          grossTotal,
          appliedReturnIds,
          returnNumbers,
          returnTotal,
          netPayable,
          receiptPath: filePath,
          file,
          reason: 'storage_upload_failed',
        }),
        request,
      });

      return NextResponse.json({ error: `Receipt upload failed: ${uploadError.message}` }, { status: 500 });
    }

    // --- 2. Get public URL ---
    const { data: urlData } = supabaseAdmin.storage
      .from('receipts')
      .getPublicUrl(filePath);

    // --- 3. Apply selected return credits first, then mark invoices as paid.
    // Without a database transaction, this order lets us reject invoice update
    // failures while attempting to roll return credits back to Approved.
    let appliedReturnRows: { id: string; invoice_number: string }[] = [];
    if (appliedReturnIds.length > 0) {
      const { data: updatedReturns, error: returnUpdateError } = await supabaseAdmin
        .from('invoices')
        .update({ status: 'Paid', applied_to_invoice_id: invoiceIds[0] })
        .in('id', appliedReturnIds)
        .eq('type', 'return')
        .eq('status', 'Approved')
        .is('applied_to_invoice_id', null)
        .select('id, invoice_number');

      appliedReturnRows = updatedReturns || [];

      if (returnUpdateError || appliedReturnRows.length !== appliedReturnIds.length) {
        if (appliedReturnRows.length > 0) {
          await supabaseAdmin
            .from('invoices')
            .update({ status: 'Approved', applied_to_invoice_id: null })
            .in('id', appliedReturnRows.map(row => row.id))
            .eq('applied_to_invoice_id', invoiceIds[0]);
        }

        await supabaseAdmin.storage.from('receipts').remove([filePath]);
        await logAuditEvent({
          action: 'payment.database_update_failed',
          entityType: 'payment_batch',
          entityId: invoices[0]?.id || null,
          entityLabel: invoiceNumbers[0] || null,
          actor: auth.actor,
          outcome: 'failure',
          errorMessage: returnUpdateError?.message || 'Could not apply all selected return credits',
          metadata: buildPaymentMetadata({
            invoiceIds,
            invoiceNumbers,
            grossTotal,
            appliedReturnIds,
            returnNumbers,
            returnTotal,
            netPayable,
            receiptPath: filePath,
            receiptPublicUrl: urlData.publicUrl,
            file,
            reason: 'return_credit_update_failed',
          }),
          request,
        });

        return NextResponse.json(
          { error: returnUpdateError?.message || 'Could not apply all selected return credits' },
          { status: 500 }
        );
      }
    }

    // --- 4. Update ALL invoices in the batch with the same receipt URL ---
    const { data: paidRows, error: dbError } = await supabaseAdmin
      .from('invoices')
      .update({
        status: 'Paid',
        receipt_url: urlData.publicUrl,
      })
      .in('id', invoiceIds)
      .eq('type', 'invoice')
      .eq('status', 'ReadyToPay')
      .select('id, invoice_number');

    if (dbError || !paidRows || paidRows.length !== invoiceIds.length) {
      console.error('DB update error after receipt upload:', dbError);
      // Cleanup: remove the uploaded receipt since DB update failed.
      await supabaseAdmin.storage.from('receipts').remove([filePath]);

      if (appliedReturnRows.length > 0) {
        await supabaseAdmin
          .from('invoices')
          .update({ status: 'Approved', applied_to_invoice_id: null })
          .in('id', appliedReturnRows.map(row => row.id))
          .eq('applied_to_invoice_id', invoiceIds[0]);
      }

      await logAuditEvent({
        action: 'payment.database_update_failed',
        entityType: 'payment_batch',
        entityId: invoices[0]?.id || null,
        entityLabel: invoiceNumbers[0] || null,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: dbError?.message || 'Could not mark all selected invoices as paid',
        metadata: buildPaymentMetadata({
          invoiceIds,
          invoiceNumbers,
          grossTotal,
          appliedReturnIds,
          returnNumbers,
          returnTotal,
          netPayable,
          receiptPath: filePath,
          receiptPublicUrl: urlData.publicUrl,
          file,
          reason: 'invoice_payment_update_failed',
        }),
        request,
      });

      return NextResponse.json(
        { error: `Payment could not be recorded. The receipt was not saved. Please try again. (${dbError?.message || 'Not all invoices could be marked as paid'})` },
        { status: 500 }
      );
    }

    if (appliedReturnIds.length > 0) {
      await logAuditEvent({
        action: 'payment.return_credit_applied',
        entityType: 'return_credit',
        entityId: appliedReturnIds[0],
        entityLabel: returnNumbers[0] || null,
        actor: auth.actor,
        outcome: 'success',
        beforeState: {
          status: 'Approved',
          applied_to_invoice_id: null,
        },
        afterState: {
          status: 'Paid',
          applied_to_invoice_id: invoiceIds[0],
        },
        metadata: buildPaymentMetadata({
          invoiceIds,
          invoiceNumbers,
          grossTotal,
          appliedReturnIds,
          returnNumbers,
          returnTotal,
          netPayable,
          receiptPath: filePath,
          receiptPublicUrl: urlData.publicUrl,
          file,
        }),
        request,
      });
    }

    await logAuditEvent({
      action: 'payment.batch_completed',
      entityType: 'payment_batch',
      entityId: invoices[0]?.id || null,
      entityLabel: invoiceNumbers[0] || null,
      actor: auth.actor,
      outcome: 'success',
      beforeState: {
        invoice_status: 'ReadyToPay',
        return_status: appliedReturnIds.length > 0 ? 'Approved' : null,
      },
      afterState: {
        invoice_status: 'Paid',
        receipt_url: urlData.publicUrl,
        return_status: appliedReturnIds.length > 0 ? 'Paid' : null,
      },
      metadata: buildPaymentMetadata({
        invoiceIds,
        invoiceNumbers,
        grossTotal,
        appliedReturnIds,
        returnNumbers,
        returnTotal,
        netPayable,
        receiptPath: filePath,
        receiptPublicUrl: urlData.publicUrl,
        file,
      }),
      request,
    });

    return NextResponse.json({ success: true, publicUrl: urlData.publicUrl, paidCount: invoiceIds.length });
  } catch (err) {
    console.error('Error in POST /api/receipts:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
