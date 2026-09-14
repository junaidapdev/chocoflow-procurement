import { createClient } from '@/lib/supabase-server';
import ApproveClient from './ApproveClient';

export default async function DashboardApprovePage() {
  const supabase = createClient();

  // Oldest invoice first, by the date on the vendor's paper rather than by
  // when it was uploaded. An invoice sent in three months late is three months
  // old: ordering by created_at would file it behind everything submitted this
  // week, which is exactly how old bills end up unpaid. created_at breaks ties
  // so the order is stable for invoices sharing a date.
  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*')
    .order('invoice_date', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching invoices:', error);
  }

  return (
    <div className="p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="border-b border-gray-200 pb-5">
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Invoice Approval</h1>
          <p className="text-gray-500 mt-1">Approve verified invoices for payment.</p>
        </div>
        
        <ApproveClient initialInvoices={invoices || []} />
      </div>
    </div>
  );
}
