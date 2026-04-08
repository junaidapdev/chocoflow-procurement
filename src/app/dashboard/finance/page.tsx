import { createClient } from '@/lib/supabase-server';
import FinanceClient from './FinanceClient';

export default async function DashboardFinancePage() {
  const supabase = createClient();

  // The accountant needs all Approved invoices initially (for queue) and Paid (for history).
  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*')
    .in('status', ['Approved', 'Paid'])
    .order('created_at', { ascending: true }); // old enough to pay first

  if (error) {
    console.error('Error fetching invoices:', error);
  }

  const { data: brandsData, error: brandsError } = await supabase
    .from('brands')
    .select('brand_name, contact_name, whatsapp_number');

  if (brandsError) {
    console.error('Error fetching brands:', brandsError);
  }

  return (
    <div className="p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="border-b border-gray-200 pb-5">
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Financial Disbursements</h1>
          <p className="text-gray-500 mt-1">Settle approved invoices and upload transfer receipts.</p>
        </div>
        
        <FinanceClient 
          initialInvoices={invoices || []} 
          brands={brandsData || []} 
        />
      </div>
    </div>
  );
}
