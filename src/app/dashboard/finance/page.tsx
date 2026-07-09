import { createClient } from '@/lib/supabase-server';
import FinanceClient from './FinanceClient';

export default async function DashboardFinancePage() {
  const supabase = createClient();

  // Accountant queue + history. We pull:
  //   Approved   → still needs to be authorized for payment
  //   ReadyToPay → already authorized; awaiting the payer to transfer
  //   Paid       → completed (history)
  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*')
    .eq('type', 'invoice')
    .in('status', ['Approved', 'ReadyToPay', 'Paid'])
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching invoices:', error);
  }

  const { data: brandsData, error: brandsError } = await supabase
    .from('brands')
    .select('brand_name, contact_name, whatsapp_number');

  if (brandsError) {
    console.error('Error fetching brands:', brandsError);
  }

  // Read-only visibility for the accountant: return credits that are either
  // available (Approved, not yet applied) or already applied to a payment
  // (Paid). Used to show net paid amounts in the history and a Returns tab.
  const { data: returnsData, error: returnsError } = await supabase
    .from('invoices')
    .select('*')
    .eq('type', 'return')
    .in('status', ['Approved', 'Paid'])
    .order('created_at', { ascending: false });

  if (returnsError) {
    console.error('Error fetching return credits:', returnsError);
  }

  return (
    <div className="p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="border-b border-gray-200 pb-5">
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Payment Authorization</h1>
          <p className="text-gray-500 mt-1">Authorize approved invoices for the payments team to transfer.</p>
        </div>

        <FinanceClient
          initialInvoices={invoices || []}
          brands={brandsData || []}
          returns={returnsData || []}
        />
      </div>
    </div>
  );
}
