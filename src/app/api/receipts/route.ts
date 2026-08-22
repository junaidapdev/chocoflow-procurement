import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { logAuditEvent } from '@/lib/audit-log';
import { requireRoles } from '@/lib/auth-context';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { areUuids } from '@/lib/uuid';
import { isBankAccount } from '@/lib/constants';
import { isValidDateString, validatePaymentDate } from '@/lib/dates';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const RECEIPT_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const ALLOWED_RECEIPT_TYPES = Object.keys(RECEIPT_EXT);

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
  return areUuids(values);
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
  paymentDate?: string | null;
  bankAccount?: string | null;
  batchId?: string | null;
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
    payment_date: input.paymentDate || null,
    bank_account: input.bankAccount || null,
    payment_batch_id: input.batchId || null,
    file_name: input.file?.name || null,
    file_type: input.file?.type || null,
    file_size: input.file?.size || null,
    reason: input.reason || null,
  };
}

// POST - Upload a single receipt and mark one OR many invoices as Paid.
//
// Input (multipart/form-data):
//   file          — receipt PDF/image (required). The storage path is generated
//                   server-side; any client-sent path is ignored.
//   invoiceIds    — JSON array of invoice UUIDs (preferred; batch mode)
//   invoiceId     — single invoice UUID (legacy; still accepted)
//   appliedReturnIds — JSON array of return invoice UUIDs (optional)
//   paymentDate   — YYYY-MM-DD, the day money left the bank (required)
//   bankAccount   — last 4 digits of the company account used (required)
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
    const legacyInvoiceId = formData.get('invoiceId') as string | null;
    const invoiceIdsRaw = formData.get('invoiceIds') as string | null;
    const appliedReturnIdsRaw = formData.get('appliedReturnIds') as string | null;
    const paymentDate = formData.get('paymentDate') as string | null;
    const bankAccount = formData.get('bankAccount') as string | null;

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

    if (!file || invoiceIds.length === 0) {
      await logAuditEvent({
        action: file ? 'payment.denied' : 'payment.receipt_upload_failed',
        entityType: 'payment_batch',
        actor: auth.actor,
        outcome: file ? 'denied' : 'failure',
        errorMessage: 'file and at least one invoice ID are required',
        metadata: buildPaymentMetadata({
          invoiceIds,
          file,
          reason: 'missing_required_fields',
        }),
        request,
      });

      return NextResponse.json({ error: 'file and at least one invoice ID are required' }, { status: 400 });
    }

    // Build the receipt storage path on the SERVER — never trust a client path,
    // which (with upsert) could overwrite another receipt.
    const receiptPath = `${randomUUID()}.${RECEIPT_EXT[file.type] || 'bin'}`;

    // One bank transfer covering several invoices is one batch. Stamping every
    // affected row with the same id makes the transfer addressable afterwards,
    // instead of only being implied by a shared receipt URL.
    const batchId = randomUUID();

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
            receiptPath,
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
          receiptPath,
          file,
          reason: 'invalid_uuid',
        }),
        request,
      });

      return NextResponse.json({ error: 'Invoice and return IDs must be valid UUIDs' }, { status: 400 });
    }

    // --- Payment date & bank account ---
    // Both required. They are what reconciles this payment against a bank
    // statement later, and an invoice is terminal once Paid — there is no
    // correction flow — so anything missing here is missing permanently.
    const paymentDateError = validatePaymentDate(paymentDate);
    if (paymentDateError !== null || !isValidDateString(paymentDate)) {
      const message = paymentDateError ?? 'Payment date is required (YYYY-MM-DD).';
      await logAuditEvent({
        action: 'payment.denied',
        entityType: 'payment_batch',
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: message,
        metadata: buildPaymentMetadata({
          invoiceIds,
          appliedReturnIds,
          receiptPath,
          paymentDate: typeof paymentDate === 'string' ? paymentDate : null,
          bankAccount: typeof bankAccount === 'string' ? bankAccount : null,
          batchId,
          file,
          reason: 'invalid_payment_date',
        }),
        request,
      });

      return NextResponse.json({ error: message }, { status: 400 });
    }

    if (!isBankAccount(bankAccount)) {
      await logAuditEvent({
        action: 'payment.denied',
        entityType: 'payment_batch',
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: 'A valid company bank account must be selected.',
        metadata: buildPaymentMetadata({
          invoiceIds,
          appliedReturnIds,
          receiptPath,
          paymentDate,
          bankAccount: typeof bankAccount === 'string' ? bankAccount : null,
          batchId,
          file,
          reason: 'invalid_bank_account',
        }),
        request,
      });

      return NextResponse.json(
        { error: 'A valid company bank account must be selected.' },
        { status: 400 }
      );
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
          receiptPath,
          paymentDate,
          bankAccount,
          batchId,
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
          receiptPath,
          paymentDate,
          bankAccount,
          batchId,
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
          receiptPath,
          paymentDate,
          bankAccount,
          batchId,
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
          receiptPath,
          paymentDate,
          bankAccount,
          batchId,
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
            receiptPath,
            paymentDate,
            bankAccount,
            batchId,
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
            receiptPath,
            paymentDate,
            bankAccount,
            batchId,
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
      .upload(receiptPath, buffer, { upsert: true, contentType: file.type });

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
          receiptPath,
          paymentDate,
          bankAccount,
          batchId,
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
      .getPublicUrl(receiptPath);

    // --- 3. Apply return credits and mark invoices Paid in ONE transaction.
    // record_invoice_payment (defined in supabase/schema.sql) does both updates
    // atomically and raises if any row count is off, so Postgres rolls the whole
    // thing back — a payment can never be left half-applied.
    const { error: paymentError } = await supabaseAdmin.rpc('record_invoice_payment', {
      p_invoice_ids: invoiceIds,
      p_return_ids: appliedReturnIds,
      p_receipt_url: urlData.publicUrl,
      p_payment_date: paymentDate,
      p_bank_account: bankAccount,
      p_batch_id: batchId,
    });

    if (paymentError) {
      console.error('Atomic payment failed:', paymentError);
      // Storage isn't transactional — remove the receipt we just uploaded.
      await supabaseAdmin.storage.from('receipts').remove([receiptPath]);

      await logAuditEvent({
        action: 'payment.database_update_failed',
        entityType: 'payment_batch',
        entityId: invoices[0]?.id || null,
        entityLabel: invoiceNumbers[0] || null,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: paymentError.message,
        metadata: buildPaymentMetadata({
          invoiceIds,
          invoiceNumbers,
          grossTotal,
          appliedReturnIds,
          returnNumbers,
          returnTotal,
          netPayable,
          receiptPath,
          paymentDate,
          bankAccount,
          batchId,
          receiptPublicUrl: urlData.publicUrl,
          file,
          reason: 'atomic_payment_failed',
        }),
        request,
      });

      return NextResponse.json(
        { error: `Payment could not be recorded. The receipt was not saved. Please try again. (${paymentError.message})` },
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
          receiptPath,
          paymentDate,
          bankAccount,
          batchId,
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
        receiptPath,
        paymentDate,
        bankAccount,
        batchId,
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
