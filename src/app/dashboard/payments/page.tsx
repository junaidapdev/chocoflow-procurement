import { createClient } from '@/lib/supabase-server';
import PaymentsClient from './PaymentsClient';

export default async function DashboardPaymentsPage() {
  const supabase = createClient();

  // Payer queue + history.
  //   ReadyToPay → accountant has authorized; transfer money + upload receipt
  //   Paid       → completed
  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('type', 'invoice')
    .in('status', ['ReadyToPay', 'Paid'])
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching invoices:', error);
  }

  // Available return credits — applied at payment time to reduce net transfer.
  const { data: availableReturns, error: returnsError } = await supabase
    .from('invoices')
    .select('*')
    .eq('type', 'return')
    .eq('status', 'Approved')
    .is('applied_to_invoice_id', null)
    .order('created_at', { ascending: true });

  if (returnsError) {
    console.error('Error fetching return credits:', returnsError);
  }

  return (
    <div className="p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="border-b border-gray-200 pb-5">
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Bank Payments</h1>
          <p className="text-gray-500 mt-1">Transfer authorized invoices and upload the bank receipt.</p>
        </div>

        <PaymentsClient
          initialInvoices={invoices || []}
          initialReturns={availableReturns || []}
        />
      </div>
    </div>
  );
}
