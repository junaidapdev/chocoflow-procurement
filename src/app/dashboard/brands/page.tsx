import { createClient } from '@/lib/supabase-server';
import BrandsClient from './BrandsClient';

export default async function DashboardBrandsPage() {
  const supabase = createClient();

  const { data: brands, error } = await supabase
    .from('brands')
    .select('*')
    .order('brand_name', { ascending: true });

  if (error) {
    console.error('Error fetching brands:', error);
  }

  return (
    <div className="p-8 text-black">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="border-b border-gray-200 pb-5">
          <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">Brands Configuration</h1>
          <p className="text-gray-500 mt-1">Manage vendor contact names and assigned WhatsApp numbers securely.</p>
        </div>
        
        <BrandsClient initialBrands={brands || []} />
      </div>
    </div>
  );
}
