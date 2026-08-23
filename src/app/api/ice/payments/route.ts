import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { logAuditEvent } from '@/lib/audit-log';
import { requireIceMember } from '@/lib/ice-auth';
import { isBankAccount } from '@/lib/constants';
import { validatePaymentDate } from '@/lib/dates';
import { ICE_RECEIPT_BUCKET } from '@/lib/icecream';
import { isUuid } from '@/lib/uuid';

// Recording that accounts paid a batch, plus the receipt they sent back.
//
// payment_date is entered by the person recording it and is never inferred from
// a row timestamp. Accounts commonly pay a day or two after the sheet reaches
// them, so "when this row was written" is not the date the money moved — the
// same distinction the chocolate side had to be repaired for.

const MAX_RECEIPT_SIZE = 10 * 1024 * 1024; // 10MB — receipts arrive as photos
const ACCEPTED_RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

export async function POST(request: NextRequest) {
  const auth = await requireIceMember(request);

  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let form: FormData;

  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const batchId = form.get('batch_id');
  const paymentDate = form.get('payment_date');
  const bankAccount = form.get('bank_account');
  const receipt = form.get('receipt');

  if (!isUuid(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id.' }, { status: 400 });
  }

  const dateError = validatePaymentDate(paymentDate);
  if (dateError) {
    return NextResponse.json({ error: dateError }, { status: 400 });
  }

  if (!isBankAccount(bankAccount)) {
    return NextResponse.json(
      { error: 'Select which account the payment came from.' },
      { status: 400 }
    );
  }

  // The receipt is the only evidence that accounts actually paid, so unlike the
  // bill photo on the submission form this one is required.
  if (!(receipt instanceof File) || receipt.size === 0) {
    return NextResponse.json({ error: 'Attach the payment receipt.' }, { status: 400 });
  }

  if (receipt.size > MAX_RECEIPT_SIZE) {
    return NextResponse.json({ error: 'The receipt must be under 10MB.' }, { status: 400 });
  }

  if (!ACCEPTED_RECEIPT_TYPES.includes(receipt.type)) {
    return NextResponse.json(
      { error: 'The receipt must be an image or a PDF.' },
      { status: 400 }
    );
  }

  const supabaseAdmin = getSupabaseAdminClient();
  let receiptPath: string | null = null;

  try {
    const { data: batch, error: batchError } = await supabaseAdmin
      .from('ice_batches')
      .select('id, reference, city, status, total_amount, bill_count')
      .eq('id', batchId)
      .maybeSingle();

    if (batchError) throw batchError;

    if (!batch) {
      return NextResponse.json({ error: 'Batch not found.' }, { status: 404 });
    }

    if (batch.status === 'paid') {
      return NextResponse.json({ error: 'This batch is already paid.' }, { status: 409 });
    }

    const extension = EXTENSION_BY_TYPE[receipt.type] || 'bin';
    receiptPath = `${batch.city}/${batch.reference}.${extension}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(ICE_RECEIPT_BUCKET)
      .upload(receiptPath, receipt, { contentType: receipt.type, upsert: true });

    if (uploadError) throw uploadError;

    const { error: paymentError } = await supabaseAdmin.rpc('ice_record_payment', {
      p_batch_id: batchId,
      p_payment_date: paymentDate,
      p_bank_account: bankAccount,
      p_receipt_path: receiptPath,
      p_actor: auth.context.user.id,
    });

    if (paymentError) {
      // The receipt is already in storage but no payment was recorded. Left
      // there it would shadow the next attempt for this batch, since the path
      // is derived from the reference and uploaded with upsert.
      await supabaseAdmin.storage.from(ICE_RECEIPT_BUCKET).remove([receiptPath]);
      return NextResponse.json({ error: paymentError.message }, { status: 409 });
    }

    await logAuditEvent({
      action: 'ice.payment.recorded',
      entityType: 'ice_batch',
      entityId: batch.id,
      entityLabel: batch.reference,
      actor: auth.actor,
      afterState: {
        payment_date: paymentDate,
        bank_account: bankAccount,
        total_amount: batch.total_amount,
        bill_count: batch.bill_count,
      },
      request,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Ice payment recording failed:', err);

    if (receiptPath) {
      await supabaseAdmin.storage
        .from(ICE_RECEIPT_BUCKET)
        .remove([receiptPath])
        .catch(() => undefined);
    }

    await logAuditEvent({
      action: 'ice.payment.recorded',
      entityType: 'ice_batch',
      entityId: batchId,
      actor: auth.actor,
      outcome: 'failure',
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
      request,
    });

    return NextResponse.json({ error: 'Could not record the payment.' }, { status: 500 });
  }
}
