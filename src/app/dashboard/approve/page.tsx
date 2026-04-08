import { createClient } from '@/lib/supabase-server';
import ApproveClient from './ApproveClient';

export default async function DashboardApprovePage() {
  const supabase = createClient();

  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*')
    .order('created_at', { ascending: false });

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
