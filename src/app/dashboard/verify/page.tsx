import { createClient } from '@/lib/supabase-server';
import DashboardClient from './DashboardClient';

export default async function DashboardVerifyPage() {
  const supabase = createClient();

  const { data: invoices, error } = await supabase
    .from('invoices')
    .select('*')
    .in('status', ['Pending', 'Rejected'])
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching invoices:', error);
  }

  return (
    <div className="p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="border-b border-gray-200 pb-5">
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Invoice Verification</h1>
          <p className="text-gray-500 mt-1">Review vendor submissions for Kayan Sweets</p>
        </div>
        
        <DashboardClient initialInvoices={invoices || []} />
      </div>
    </div>
  );
}
