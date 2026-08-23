import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { logAuditEvent } from '@/lib/audit-log';
import { requireIceMember } from '@/lib/ice-auth';
import { isIceCity, buildSheet, type IceBillRow, type IceBranch } from '@/lib/icecream';
import { areUuids, isUuid } from '@/lib/uuid';

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

  let body: ApproveBody;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const { city, kind } = body;

  if (!isIceCity(city)) {
    return NextResponse.json({ error: 'Unknown city.' }, { status: 400 });
  }

  const batchKind = kind === 'urgent' ? 'urgent' : 'weekly';

  // An urgent batch is a batch of exactly one bill. Left unbounded it would be
  // indistinguishable from a weekly sheet that happens to be labelled urgent.
  let billIds: string[] | null = null;

  if (Array.isArray(body.bill_ids)) {
    if (!areUuids(body.bill_ids as string[])) {
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

    const { data: batchId, error: approveError } = await supabaseAdmin.rpc('ice_approve_batch', {
      p_city: city,
      p_kind: batchKind,
      p_actor: auth.context.user.id,
      p_bill_ids: billIds,
    });

    if (approveError) {
      // The function raises for the cases the manager can actually act on —
      // nothing pending, or a bill someone else already batched — so its
      // message is more useful to them than a generic failure.
      return NextResponse.json({ error: approveError.message }, { status: 409 });
    }

    // Freeze what was approved. The manager sends a screenshot over WhatsApp and
    // keeps no file, so without this there would be no record of what accounts
    // was actually asked to pay — only of what the rows look like today.
    const snapshot = await buildSnapshot(supabaseAdmin, batchId as string);

    if (snapshot) {
      await supabaseAdmin
        .from('ice_batches')
        .update({ snapshot })
        .eq('id', batchId);
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

// Renders the batch exactly as the sheet displays it, so a stored snapshot can
// be reopened later and read the same way it was sent.
async function buildSnapshot(
  supabaseAdmin: ReturnType<typeof getSupabaseAdminClient>,
  batchId: string
) {
  const { data: batch } = await supabaseAdmin
    .from('ice_batches')
    .select('city')
    .eq('id', batchId)
    .single();

  if (!batch) return null;

  const [{ data: branches }, { data: bills }] = await Promise.all([
    supabaseAdmin
      .from('ice_branches')
      .select('id, name_en, name_ar, city, sort_order')
      .eq('city', batch.city),
    supabaseAdmin
      .from('ice_bills')
      .select(
        'id, branch_id, salesman_id, bill_date, amount, status, batch_id, source, submitted_by_name, note, created_at, ice_branches(name_en, city, sort_order), ice_salesmen(name)'
      )
      .eq('batch_id', batchId),
  ]);

  if (!branches || !bills) return null;

  const rows: IceBillRow[] = bills.map((bill: Record<string, any>) => ({
    ...(bill as IceBillRow),
    branch_name: bill.ice_branches?.name_en ?? '',
    branch_sort: bill.ice_branches?.sort_order ?? 0,
    city: bill.ice_branches?.city,
    salesman_name: bill.ice_salesmen?.name ?? 'Unassigned',
  }));

  // Only branches that actually contributed a bill are frozen. An empty branch
  // is meaningful in the live view ("nothing due" rather than "forgotten"), but
  // in a historical record it would be noise.
  const contributing = new Set(rows.map(r => r.branch_id));

  return buildSheet(
    batch.city,
    (branches as IceBranch[]).filter(b => contributing.has(b.id)),
    rows
  );
}
