import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { logAuditEvent } from '@/lib/audit-log';
import { requireIceMember } from '@/lib/ice-auth';
import { EARLIEST_PAYMENT_DATE, isValidDateString, riyadhToday } from '@/lib/dates';
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

function parseAmount(value: unknown): { amount: number } | { error: string } {
  const amount = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(amount)) {
    return { error: 'Please enter the bill amount.' };
  }

  if (amount <= 0) {
    return { error: 'The amount must be more than zero.' };
  }

  if (amount > MAX_BILL_AMOUNT) {
    return { error: 'That amount looks too large — please check it.' };
  }

  // numeric(12,2) would round a third decimal silently. Rounding here means the
  // number stored is the number the API validated.
  return { amount: Math.round(amount * 100) / 100 };
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const branchId = body.branch_id;
  const submittedByRaw = body.submitted_by_name;

  // The same endpoint serves the public link and the manager adding a bill that
  // only ever appeared in WhatsApp. Authorization decides which: a valid ice
  // member gets the manual path, and anyone else gets the public one — a forged
  // `source` in the body changes nothing.
  const auth = hasSessionCookie(request) ? await requireIceMember(request) : null;
  const isManual = !!auth?.ok;

  if (!isUuid(branchId)) {
    return NextResponse.json({ error: 'Please select a branch.' }, { status: 400 });
  }

  const dateError = validateBillDate(body.bill_date, isManual);
  if (dateError) {
    return NextResponse.json({ error: dateError }, { status: 400 });
  }

  const parsed = parseAmount(body.amount);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const billDate = body.bill_date as string;
  const submittedBy =
    typeof submittedByRaw === 'string' && submittedByRaw.trim()
      ? submittedByRaw.trim().slice(0, 80)
      : null;

  try {
    const supabaseAdmin = getSupabaseAdminClient();

    // Resolve the branch and its current salesman in one go. An unknown or
    // retired branch id fails here rather than creating an orphan bill.
    const { data: branch, error: branchError } = await supabaseAdmin
      .from('ice_branches')
      .select('id, name_en, city, active')
      .eq('id', branchId)
      .maybeSingle();

    if (branchError) throw branchError;

    if (!branch || !branch.active) {
      return NextResponse.json({ error: 'That branch is not available.' }, { status: 400 });
    }

    // The cap exists to bound what a leaked public link can do overnight. A
    // signed-in manager clearing a genuine backlog is exactly the case it must
    // not block, so it applies to the public path only.
    if (!isManual) {
      const { count: todayCount, error: countError } = await supabaseAdmin
        .from('ice_bills')
        .select('id', { count: 'exact', head: true })
        .eq('branch_id', branchId)
        .gte('created_at', `${riyadhToday()}T00:00:00Z`);

      if (countError) throw countError;

      if ((todayCount ?? 0) >= MAX_BILLS_PER_BRANCH_PER_DAY) {
        await logAuditEvent({
          action: 'ice.bill.rate_limited',
          entityType: 'ice_bill',
          entityLabel: branch.name_en,
          actor: { type: 'public' },
          outcome: 'denied',
          metadata: { branch: branch.name_en, submitted_by: submittedBy },
          request,
        });

        return NextResponse.json(
          { error: 'Too many bills filed for this branch today. Please contact the office.' },
          { status: 429 }
        );
      }
    }

    // The salesman covering this branch right now. Stored on the bill rather
    // than looked up when the sheet renders, so reassigning a salesman later
    // never rewrites which sheets they appeared on.
    const { data: assignment, error: assignmentError } = await supabaseAdmin
      .from('ice_branch_salesmen')
      .select('salesman_id')
      .eq('branch_id', branchId)
      .is('effective_to', null)
      .maybeSingle();

    if (assignmentError) throw assignmentError;

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('ice_bills')
      .insert({
        branch_id: branchId,
        salesman_id: assignment?.salesman_id ?? null,
        bill_date: billDate,
        amount: parsed.amount,
        status: 'pending',
        source: isManual ? 'manual' : 'link',
        submitted_by_name: submittedBy,
      })
      .select('id')
      .single();

    if (insertError) throw insertError;

    await logAuditEvent({
      action: isManual ? 'ice.bill.added_manually' : 'ice.bill.submitted',
      entityType: 'ice_bill',
      entityId: inserted.id,
      entityLabel: `${branch.name_en} · ${billDate}`,
      actor: auth?.ok ? auth.actor : { type: 'public', name: submittedBy },
      afterState: {
        branch: branch.name_en,
        city: branch.city,
        bill_date: billDate,
        amount: parsed.amount,
      },
      request,
    });

    return NextResponse.json({
      ok: true,
      bill: {
        id: inserted.id,
        branch_name: branch.name_en,
        bill_date: billDate,
        amount: parsed.amount,
      },
    });
  } catch (err) {
    console.error('Ice bill submission failed:', err);

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
      .select('id, branch_id, bill_date, amount')
      .maybeSingle();

    if (error) throw error;

    if (!removed) {
      return NextResponse.json(
        { error: 'That bill is already in a batch and cannot be removed.' },
        { status: 409 }
      );
    }

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
