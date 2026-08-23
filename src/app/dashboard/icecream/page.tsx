import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import type { IceBatch, IceBillRow, IceBranch } from '@/lib/icecream';
import IceCreamClient from './IceCreamClient';

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

  const [branchesResult, pendingResult, openBatchesResult, paidBatchesResult] = await Promise.all([
    supabase
      .from('ice_branches')
      .select('id, name_en, name_ar, city, sort_order')
      .eq('active', true)
      .order('sort_order', { ascending: true }),

    // Everything not yet in a batch, regardless of how old. A bill submitted
    // late — after its own week was already sent — stays here and is swept into
    // the next batch rather than being stranded in a week nobody reopens.
    supabase
      .from('ice_bills')
      .select(
        'id, branch_id, salesman_id, bill_date, amount, status, batch_id, source, submitted_by_name, note, created_at, ice_branches!inner(name_en, city, sort_order), ice_salesmen(name)'
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
  ]);

  const branches = (branchesResult.data || []) as IceBranch[];

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

  const loadError =
    !!branchesResult.error || !!pendingResult.error || !!openBatchesResult.error;

  return (
    <IceCreamClient
      branches={branches}
      pendingBills={pendingBills}
      openBatches={(openBatchesResult.data || []) as IceBatch[]}
      paidBatches={paidBatches}
      loadError={loadError}
    />
  );
}
