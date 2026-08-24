import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import type { IceBatch, IceBillRow, IceBranch } from '@/lib/icecream';
import IceCreamClient, { type SettledBill } from './IceCreamClient';

// Reads with the signed-in user's session rather than the service role, so the
// "Ice members can read" RLS policies are doing real work here — a signed-in
// chocolate user who somehow reached this page would get empty arrays, not
// somebody else's numbers.
export const dynamic = 'force-dynamic';

export default async function IceCreamPage() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const [
    branchesResult,
    pendingResult,
    openBatchesResult,
    paidBatchesResult,
    settledResult,
  ] = await Promise.all([
    // Current salesman comes along so a branch with no bills can still be
    // labelled with whoever covers it, rather than "Unassigned".
    supabase
      .from('ice_branches')
      .select('id, name_en, name_ar, city, sort_order, ice_branch_salesmen(effective_to, ice_salesmen(name))')
      .eq('active', true)
      .is('ice_branch_salesmen.effective_to', null)
      .order('sort_order', { ascending: true }),

    // Everything not yet in a batch, regardless of how old. A bill submitted
    // late — after its own week was already sent — stays here and is swept into
    // the next batch rather than being stranded in a week nobody reopens.
    supabase
      .from('ice_bills')
      .select(
        'id, branch_id, salesman_id, bill_date, amount, status, batch_id, source, submitted_by_name, note, bill_photo_path, created_at, ice_branches!inner(name_en, city, sort_order), ice_salesmen(name)'
      )
      .eq('status', 'pending')
      .order('bill_date', { ascending: true }),

    supabase
      .from('ice_batches')
      .select('id, city, kind, status, reference, period_start, period_end, total_amount, bill_count, approved_at, sent_at')
      .in('status', ['approved', 'sent'])
      .order('approved_at', { ascending: false }),

    // Recently settled batches, so an urgent payment made mid-week shows up
    // beneath the sheet as "already paid" instead of silently vanishing from
    // the manager's view and looking like a lost bill.
    supabase
      .from('ice_batches')
      .select('id, city, kind, status, reference, period_start, period_end, total_amount, bill_count, approved_at, sent_at, ice_payments(payment_date, bank_account, receipt_path)')
      .eq('status', 'paid')
      .order('approved_at', { ascending: false })
      .limit(12),

    // Bills that are already batched or paid, for duplicate detection. Checking
    // a new bill only against other *pending* ones misses the case that
    // actually costs money: a branch re-filing a bill that was already settled
    // — often an urgent mid-week payment the branch never saw — where the
    // earlier copy is no longer on screen for anyone to notice.
    supabase
      .from('ice_bills')
      .select('branch_id, bill_date, amount')
      .in('status', ['batched', 'paid'])
      .gte('bill_date', historyCutoff()),
  ]);

  const branches: IceBranch[] = (branchesResult.data || []).map((branch: Record<string, any>) => {
    const assignments = Array.isArray(branch.ice_branch_salesmen)
      ? branch.ice_branch_salesmen
      : [branch.ice_branch_salesmen];

    return {
      id: branch.id,
      name_en: branch.name_en,
      name_ar: branch.name_ar,
      city: branch.city,
      sort_order: branch.sort_order,
      current_salesman_name: assignments[0]?.ice_salesmen?.name ?? null,
    };
  });

  const pendingBills: IceBillRow[] = (pendingResult.data || []).map((bill: Record<string, any>) => ({
    ...(bill as IceBillRow),
    branch_name: bill.ice_branches?.name_en ?? '',
    branch_sort: bill.ice_branches?.sort_order ?? 0,
    city: bill.ice_branches?.city,
    salesman_name: bill.ice_salesmen?.name ?? 'Unassigned',
  }));

  const paidBatches = (paidBatchesResult.data || []).map((batch: Record<string, any>) => {
    // ice_payments.batch_id is unique, so this is a to-one embed — but PostgREST
    // shapes it as an array in some versions. Normalise rather than guess.
    const payment = Array.isArray(batch.ice_payments)
      ? batch.ice_payments[0]
      : batch.ice_payments;

    return {
      ...(batch as IceBatch),
      payment_date: payment?.payment_date ?? null,
      bank_account: payment?.bank_account ?? null,
      receipt_path: payment?.receipt_path ?? null,
    };
  });

  // Every query counts. A failed branch read leaves the sheet showing bills
  // under no branch; a failed paid-batch read hides settled work; a failed
  // history read silently disables duplicate detection. Any of those makes the
  // total on screen untrustworthy, and the manager approves against that total.
  const loadError =
    !!branchesResult.error ||
    !!pendingResult.error ||
    !!openBatchesResult.error ||
    !!paidBatchesResult.error ||
    !!settledResult.error;

  return (
    <IceCreamClient
      branches={branches}
      pendingBills={pendingBills}
      settledBills={(settledResult.data || []) as SettledBill[]}
      openBatches={(openBatchesResult.data || []) as IceBatch[]}
      paidBatches={paidBatches}
      loadError={loadError}
    />
  );
}

// How far back to look for an already-settled copy of a bill. Long enough to
// cover a branch re-filing something from a previous cycle, short enough that
// two unrelated deliveries of the same amount a year apart don't get flagged.
function historyCutoff(): string {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 120);
  return cutoff.toISOString().slice(0, 10);
}
