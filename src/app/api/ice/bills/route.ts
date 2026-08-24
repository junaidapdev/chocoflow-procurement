import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { logAuditEvent } from '@/lib/audit-log';
import { requireIceMember } from '@/lib/ice-auth';
import { EARLIEST_PAYMENT_DATE, isValidDateString, riyadhToday } from '@/lib/dates';
import { ICE_BILL_BUCKET } from '@/lib/icecream';
import { isUuid } from '@/lib/uuid';

// Bills submitted from the public /bill link.
//
// The link is pinned in two WhatsApp groups, so it is effectively public: a
// screenshot forwarded once puts it in anyone's hands. That is acceptable here
// because nothing submitted through it moves money — the ice cream manager
// reviews every row before a batch is approved, and this endpoint can only
// create rows in the 'pending' state.
//
// What it must not become is an amplifier, hence the per-branch daily cap
// below. Reads are not exposed at all: the endpoint never returns other
// people's submissions, so a store manager holding the link cannot use it to
// see another branch's numbers.

// How far back the public form will accept a bill date. Generous enough for a
// manager catching up after a week off, tight enough that a mistyped year
// ("2025" for "2026") is rejected at the door rather than surfacing as a
// mysterious row in a sheet six months from now. Backdating beyond this is
// possible from the dashboard, where a signed-in manager is making the call.
const MAX_BACKDATE_DAYS = 180;

// Ceiling on how many bills one branch can file in a day. Well above any real
// day — the busiest branch in the source sheets filed two — while still capping
// what a leaked link can do to a night's data.
const MAX_BILLS_PER_BRANCH_PER_DAY = 20;

// Rejects amounts that are almost certainly a typo. The largest bill in the
// source sheets was 3,258.82; a five-figure ice cream delivery to a single
// branch would be unprecedented and is worth stopping to check.
const MAX_BILL_AMOUNT = 100000;

// The bill photo is optional (see the migration for why), but when one is sent
// it is a phone photo of a paper bill — the same shape as the payment receipt,
// so the same limits apply.
const MAX_BILL_PHOTO_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000
  );
}

function validateBillDate(value: unknown, isManual: boolean): string | null {
  if (!isValidDateString(value)) {
    return 'Please pick a valid bill date.';
  }

  const today = riyadhToday();

  if (value > today) {
    return 'The bill date cannot be in the future.';
  }

  // A signed-in manager entering a bill by hand is knowingly backdating — they
  // are usually catching up on something that sat in WhatsApp unnoticed. The
  // tight window exists to catch a store manager mistyping a year on the public
  // form, not to stop the office correcting the record.
  if (isManual) {
    return value < EARLIEST_PAYMENT_DATE
      ? `That date looks wrong — it must be on or after ${EARLIEST_PAYMENT_DATE}.`
      : null;
  }

  if (daysBetween(value, today) > MAX_BACKDATE_DAYS) {
    return `That date is more than ${MAX_BACKDATE_DAYS} days ago — please check the year.`;
  }

  return null;
}

// Whether this request could plausibly carry a signed-in session. Checked
// before attempting authorization so that a store manager's submission — which
// never has a session — does not pay for an auth round-trip on every bill.
function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some(cookie => cookie.name.startsWith('sb-'));
}

// A JSON body is not a form: it can carry any type. `Number(true)` is 1 and
// `Number([5])` is 5, so coercing whatever arrives would accept `true` as a
// one-riyal bill. Only the two types a real client sends are considered.
function parseAmount(value: unknown): { amount: number } | { error: string } {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { error: 'Please enter the bill amount.' };
  }

  const text = typeof value === 'number' ? String(value) : value.trim();
  const amount = Number(text);

  if (text === '' || !Number.isFinite(amount)) {
    return { error: 'Please enter the bill amount.' };
  }

  if (amount <= 0) {
    return { error: 'The amount must be more than zero.' };
  }

  if (amount > MAX_BILL_AMOUNT) {
    return { error: 'That amount looks too large — please check it.' };
  }

  // Rejected rather than rounded. `Math.round(1.005 * 100) / 100` is 1.00,
  // because 1.005 is not exactly representable in binary floating point — but
  // numeric(12,2) rounds the same input to 1.01. Silently storing a different
  // figure from the one Postgres would have stored is worse than refusing an
  // input no real bill has, and money should never be quietly re-rounded.
  const decimals = text.includes('e') || text.includes('E')
    ? Number.MAX_SAFE_INTEGER // exponent notation — not something to guess at
    : (text.split('.')[1]?.length ?? 0);

  if (decimals > 2) {
    return { error: 'Amounts can have at most two decimal places.' };
  }

  return { amount };
}

// Best-effort removal of an uploaded photo whose bill never committed. Awaited
// but never allowed to throw: a failed cleanup must not turn a handled 4xx into
// an unhandled 500, and the worst case is one orphaned object, not a data error.
async function cleanupPhoto(
  supabaseAdmin: ReturnType<typeof getSupabaseAdminClient>,
  photoPath: string | null
): Promise<void> {
  if (!photoPath) return;
  await supabaseAdmin.storage.from(ICE_BILL_BUCKET).remove([photoPath]).catch(() => undefined);
}

export async function POST(request: NextRequest) {
  // The form carries a file now, so the body is multipart rather than JSON. The
  // manual "Add a bill" form in the dashboard posts the same shape, just without
  // a photo.
  let form: FormData;

  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const branchId = form.get('branch_id');
  const billDateRaw = form.get('bill_date');
  const amountRaw = form.get('amount');
  const submittedByRaw = form.get('submitted_by_name');
  const photoRaw = form.get('bill_photo');

  // The same endpoint serves the public link and the manager adding a bill that
  // only ever appeared in WhatsApp. Authorization decides which: a valid ice
  // member gets the manual path, and anyone else gets the public one — a forged
  // `source` in the body changes nothing.
  const auth = hasSessionCookie(request) ? await requireIceMember(request) : null;
  const isManual = !!auth?.ok;

  if (!isUuid(branchId)) {
    return NextResponse.json({ error: 'Please select a branch.' }, { status: 400 });
  }

  const dateError = validateBillDate(billDateRaw, isManual);
  if (dateError) {
    return NextResponse.json({ error: dateError }, { status: 400 });
  }

  const parsed = parseAmount(amountRaw);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // An empty file input still arrives as a File with size 0, which is not a
  // photo — treat it as "none". A real photo is validated here, before it
  // touches storage, so an oversized or wrong-typed file is turned away at the
  // door rather than after an upload.
  const photo = photoRaw instanceof File && photoRaw.size > 0 ? photoRaw : null;
  if (photo) {
    if (photo.size > MAX_BILL_PHOTO_SIZE) {
      return NextResponse.json({ error: 'The photo must be under 10MB.' }, { status: 400 });
    }
    if (!ACCEPTED_PHOTO_TYPES.includes(photo.type)) {
      return NextResponse.json({ error: 'The photo must be an image or a PDF.' }, { status: 400 });
    }
  }

  const billDate = billDateRaw as string;
  const submittedBy =
    typeof submittedByRaw === 'string' && submittedByRaw.trim()
      ? submittedByRaw.trim().slice(0, 80)
      : null;

  const supabaseAdmin = getSupabaseAdminClient();
  let photoPath: string | null = null;

  try {
    // Read for the response and the audit entry. Whether the branch is usable
    // is decided inside ice_submit_bill, under the same lock as the insert, so
    // this is presentation only and cannot be raced into a wrong decision.
    const { data: branch, error: branchError } = await supabaseAdmin
      .from('ice_branches')
      .select('id, name_en, city')
      .eq('id', branchId)
      .maybeSingle();

    if (branchError) throw branchError;

    // Upload the photo before the insert so its path lands on the row in the
    // same transaction. If the insert is then rejected — a hit cap, an
    // unavailable branch, any error — the object is removed on that path and in
    // the catch, so a rejected submission never leaves a stray file behind and
    // a leaked link cannot accumulate uploads by spamming a capped branch.
    if (photo) {
      const extension = EXTENSION_BY_TYPE[photo.type] || 'bin';
      photoPath = `${branch?.city ?? 'unknown'}/${randomUUID()}.${extension}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from(ICE_BILL_BUCKET)
        .upload(photoPath, photo, { contentType: photo.type, upsert: false });

      if (uploadError) throw uploadError;
    }

    // Validation, the daily cap, salesman resolution and the insert all happen
    // in one transaction. Counting here and inserting afterwards would let
    // concurrent submissions all pass the check before any of them committed,
    // which is to say the cap would not be a cap.
    //
    // A null cap skips the check: that is the signed-in manager entering a
    // backlog by hand, exactly the case the cap must not block.
    const { data: billId, error: submitError } = await supabaseAdmin.rpc('ice_submit_bill', {
      p_branch_id: branchId,
      p_bill_date: billDate,
      p_amount: parsed.amount,
      p_submitted_by: submittedBy,
      p_source: isManual ? 'manual' : 'link',
      p_daily_cap: isManual ? null : MAX_BILLS_PER_BRANCH_PER_DAY,
      p_photo_path: photoPath,
    });

    if (submitError) {
      // No bill was created, so the photo it would have pointed at is orphaned.
      await cleanupPhoto(supabaseAdmin, photoPath);
      photoPath = null;

      if (submitError.message.includes('branch_unavailable')) {
        return NextResponse.json({ error: 'That branch is not available.' }, { status: 400 });
      }

      if (submitError.message.includes('daily_cap_reached')) {
        await logAuditEvent({
          action: 'ice.bill.rate_limited',
          entityType: 'ice_bill',
          entityLabel: branch?.name_en,
          actor: { type: 'public' },
          outcome: 'denied',
          metadata: { branch: branch?.name_en, submitted_by: submittedBy },
          request,
        });

        return NextResponse.json(
          { error: 'Too many bills filed for this branch today. Please contact the office.' },
          { status: 429 }
        );
      }

      throw submitError;
    }

    await logAuditEvent({
      action: isManual ? 'ice.bill.added_manually' : 'ice.bill.submitted',
      entityType: 'ice_bill',
      entityId: billId as string,
      entityLabel: `${branch?.name_en ?? 'Unknown branch'} · ${billDate}`,
      actor: auth?.ok ? auth.actor : { type: 'public', name: submittedBy },
      afterState: {
        branch: branch?.name_en,
        city: branch?.city,
        bill_date: billDate,
        amount: parsed.amount,
      },
      request,
    });

    return NextResponse.json({
      ok: true,
      bill: {
        id: billId,
        branch_name: branch?.name_en ?? 'Branch',
        bill_date: billDate,
        amount: parsed.amount,
      },
    });
  } catch (err) {
    console.error('Ice bill submission failed:', err);

    // The upload is not transactional, so anything thrown after it has to undo
    // it by hand — otherwise a failed submission leaves a file with no row.
    await cleanupPhoto(supabaseAdmin, photoPath);

    await logAuditEvent({
      action: isManual ? 'ice.bill.added_manually' : 'ice.bill.submitted',
      entityType: 'ice_bill',
      actor: auth?.ok ? auth.actor : { type: 'public', name: submittedBy },
      outcome: 'failure',
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
      request,
    });

    return NextResponse.json(
      { error: 'Could not save the bill. Please try again.' },
      { status: 500 }
    );
  }
}

// Deleting a bill the manager has judged to be a mistake or a duplicate.
// Signed-in ice members only — the public link cannot reach this.
export async function DELETE(request: NextRequest) {
  const auth = await requireIceMember(request);

  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const supabaseAdmin = getSupabaseAdminClient();
  const { searchParams } = new URL(request.url);
  const billId = searchParams.get('id');

  if (!isUuid(billId)) {
    return NextResponse.json({ error: 'Invalid bill id.' }, { status: 400 });
  }

  try {
    // Only a pending bill can be removed. Once it is in a batch the sheet has
    // been sent to accounts, and deleting a row from under a sent sheet would
    // put the system and the accountant's copy permanently out of step.
    const { data: removed, error } = await supabaseAdmin
      .from('ice_bills')
      .delete()
      .eq('id', billId)
      .eq('status', 'pending')
      .select('id, branch_id, bill_date, amount, bill_photo_path')
      .maybeSingle();

    if (error) throw error;

    if (!removed) {
      return NextResponse.json(
        { error: 'That bill is already in a batch and cannot be removed.' },
        { status: 409 }
      );
    }

    // The row is gone, so its photo is now unreachable — remove it too rather
    // than leave an orphan in the bucket. Best-effort: the bill is already
    // deleted, and a lingering object is not worth failing the request over.
    await cleanupPhoto(supabaseAdmin, removed.bill_photo_path);

    await logAuditEvent({
      action: 'ice.bill.deleted',
      entityType: 'ice_bill',
      entityId: removed.id,
      actor: auth.actor,
      beforeState: {
        bill_date: removed.bill_date,
        amount: removed.amount,
      },
      request,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Ice bill delete failed:', err);
    return NextResponse.json({ error: 'Could not remove the bill.' }, { status: 500 });
  }
}
