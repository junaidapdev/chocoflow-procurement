import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { logAuditEvent } from '@/lib/audit-log';
import { requireIceMember } from '@/lib/ice-auth';
import {
  UNASSIGNED_SALESMAN, buildSheet, isIceCity,
  type IceBillRow, type IceBranch, type IceCity,
} from '@/lib/icecream';
import { areUuids, isUuid } from '@/lib/uuid';

// JSON.parse accepts `null`, `[]` and bare scalars. Destructuring those throws
// outside the parse try/catch, surfacing as an unhandled 500 instead of a 400.
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Approving a batch is the point of no return in this module: it is what the
// manager screenshots and sends to accounts, and once sent the numbers must not
// move. Everything here runs through ice_approve_batch, which claims the bills
// and creates the batch in one transaction.

type ApproveBody = {
  city?: unknown;
  kind?: unknown;
  bill_ids?: unknown;
};

export async function POST(request: NextRequest) {
  const auth = await requireIceMember(request);

  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let parsedBody: unknown;

  try {
    parsedBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  if (!isJsonObject(parsedBody)) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const body = parsedBody as ApproveBody;
  const { city, kind } = body;

  if (!isIceCity(city)) {
    return NextResponse.json({ error: 'Unknown city.' }, { status: 400 });
  }

  // Rejected rather than defaulted. Falling back to 'weekly' for an
  // unrecognised value turns a malformed request into an approval that sweeps
  // every pending bill in the city — the largest action this endpoint can take,
  // reached by getting the input wrong.
  if (kind !== undefined && kind !== 'weekly' && kind !== 'urgent') {
    return NextResponse.json({ error: 'Unknown batch kind.' }, { status: 400 });
  }

  const batchKind = kind === 'urgent' ? 'urgent' : 'weekly';

  // An urgent batch is a batch of exactly one bill. Left unbounded it would be
  // indistinguishable from a weekly sheet that happens to be labelled urgent.
  let billIds: string[] | null = null;

  if (body.bill_ids !== undefined && body.bill_ids !== null) {
    // Same reasoning as `kind`: a malformed selection that is quietly read as
    // "no selection" approves everything pending instead of failing.
    if (!Array.isArray(body.bill_ids) || !areUuids(body.bill_ids as string[])) {
      return NextResponse.json({ error: 'Invalid bill selection.' }, { status: 400 });
    }

    billIds = body.bill_ids as string[];

    if (billIds.length === 0) {
      return NextResponse.json({ error: 'Select at least one bill.' }, { status: 400 });
    }
  }

  if (batchKind === 'urgent' && (!billIds || billIds.length !== 1)) {
    return NextResponse.json(
      { error: 'An urgent payment covers exactly one bill.' },
      { status: 400 }
    );
  }

  try {
    const supabaseAdmin = getSupabaseAdminClient();

    // Build the frozen sheet BEFORE approving, and pass it in, so the batch and
    // its snapshot commit together.
    //
    // Writing it afterwards left a window where approval succeeded, the update
    // failed, and success was still reported — a batch with snapshot = null.
    // Since the manager sends a screenshot and keeps no file, that leaves no
    // record anywhere of what accounts was asked to pay.
    //
    // Reading the bills here also pins exactly what gets batched: the ids the
    // snapshot was built from are the ids the function claims. A bill arriving
    // between the read and the approval joins the next batch instead of being
    // silently paid on a sheet nobody saw it on.
    const prepared = await prepareSnapshot(supabaseAdmin, city, billIds);

    if ('error' in prepared) {
      return NextResponse.json({ error: prepared.error }, { status: prepared.status });
    }

    const { data: batchId, error: approveError } = await supabaseAdmin.rpc('ice_approve_batch', {
      p_city: city,
      p_kind: batchKind,
      p_actor: auth.context.user.id,
      p_bill_ids: prepared.billIds,
      p_snapshot: prepared.snapshot,
    });

    if (approveError) {
      // The function raises for the cases the manager can actually act on —
      // nothing pending, or a bill someone else already batched — so its
      // message is more useful to them than a generic failure.
      return NextResponse.json({ error: approveError.message }, { status: 409 });
    }

    const { data: batch } = await supabaseAdmin
      .from('ice_batches')
      .select('id, reference, city, kind, status, total_amount, bill_count, period_start, period_end')
      .eq('id', batchId)
      .single();

    await logAuditEvent({
      action: batchKind === 'urgent' ? 'ice.batch.approved_urgent' : 'ice.batch.approved',
      entityType: 'ice_batch',
      entityId: batchId as string,
      entityLabel: batch?.reference,
      actor: auth.actor,
      afterState: {
        city,
        kind: batchKind,
        total_amount: batch?.total_amount,
        bill_count: batch?.bill_count,
      },
      request,
    });

    return NextResponse.json({ ok: true, batch });
  } catch (err) {
    console.error('Ice batch approval failed:', err);

    await logAuditEvent({
      action: 'ice.batch.approved',
      entityType: 'ice_batch',
      actor: auth.actor,
      outcome: 'failure',
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
      request,
    });

    return NextResponse.json({ error: 'Could not approve the batch.' }, { status: 500 });
  }
}

// Marking a batch as sent to accounts. Separate from approval because the two
// genuinely differ: a batch can sit approved for an hour while the manager
// finds the right WhatsApp thread, and "approved but not yet sent" is a state
// worth being able to see.
export async function PATCH(request: NextRequest) {
  const auth = await requireIceMember(request);

  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: { batch_id?: unknown };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  if (!isUuid(body.batch_id)) {
    return NextResponse.json({ error: 'Invalid batch id.' }, { status: 400 });
  }

  try {
    const supabaseAdmin = getSupabaseAdminClient();

    const { data: updated, error } = await supabaseAdmin
      .from('ice_batches')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', body.batch_id)
      .eq('status', 'approved')
      .select('id, reference')
      .maybeSingle();

    if (error) throw error;

    if (!updated) {
      return NextResponse.json(
        { error: 'That batch is not waiting to be sent.' },
        { status: 409 }
      );
    }

    await logAuditEvent({
      action: 'ice.batch.sent',
      entityType: 'ice_batch',
      entityId: updated.id,
      entityLabel: updated.reference,
      actor: auth.actor,
      request,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Ice batch send failed:', err);
    return NextResponse.json({ error: 'Could not mark the batch as sent.' }, { status: 500 });
  }
}

type Prepared =
  | { billIds: string[]; snapshot: ReturnType<typeof buildSheet> }
  | { error: string; status: number };

/**
 * Reads the bills that are about to be batched and renders them exactly as the
 * sheet displays them, so the frozen copy can be stored in the same transaction
 * that creates the batch.
 *
 * Every failure here is returned rather than swallowed. The whole point of the
 * snapshot is that it is the only record of what was sent — so if it cannot be
 * built, the right outcome is that nothing is approved, not an approval with an
 * empty record attached.
 */
async function prepareSnapshot(
  supabaseAdmin: ReturnType<typeof getSupabaseAdminClient>,
  city: IceCity,
  requestedBillIds: string[] | null
): Promise<Prepared> {
  let query = supabaseAdmin
    .from('ice_bills')
    .select(
      'id, branch_id, salesman_id, bill_date, amount, status, batch_id, source, submitted_by_name, note, created_at, ice_branches!inner(name_en, name_ar, city, sort_order), ice_salesmen(name)'
    )
    .eq('status', 'pending')
    .eq('ice_branches.city', city);

  if (requestedBillIds) {
    query = query.in('id', requestedBillIds);
  }

  const { data: bills, error: billsError } = await query;

  if (billsError) {
    console.error('Could not read bills for the snapshot:', billsError);
    return { error: 'Could not read the bills to approve. Try again.', status: 503 };
  }

  if (!bills || bills.length === 0) {
    return { error: `No pending bills to approve for ${city}.`, status: 409 };
  }

  const rows: IceBillRow[] = bills.map((bill: Record<string, any>) => ({
    ...(bill as IceBillRow),
    branch_name: bill.ice_branches?.name_en ?? '',
    branch_sort: bill.ice_branches?.sort_order ?? 0,
    city: bill.ice_branches?.city,
    salesman_name: bill.ice_salesmen?.name ?? UNASSIGNED_SALESMAN,
  }));

  // Only branches that actually contributed a bill are frozen. An empty branch
  // is meaningful in the live view ("nothing due" rather than "forgotten"), but
  // in a historical record it would be noise. buildSheet reconstructs the block
  // for each contributing branch from the rows themselves.
  const contributing = new Map<string, IceBranch>();
  for (const bill of bills as Record<string, any>[]) {
    if (contributing.has(bill.branch_id)) continue;
    contributing.set(bill.branch_id, {
      id: bill.branch_id,
      name_en: bill.ice_branches?.name_en ?? '',
      name_ar: bill.ice_branches?.name_ar ?? null,
      city,
      sort_order: bill.ice_branches?.sort_order ?? 0,
    });
  }

  return {
    billIds: rows.map(row => row.id),
    snapshot: buildSheet(city, Array.from(contributing.values()), rows),
  };
}
