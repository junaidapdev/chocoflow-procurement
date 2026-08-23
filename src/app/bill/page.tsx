import Image from 'next/image';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import type { IceBranch } from '@/lib/icecream';
import BillForm from './BillForm';

// The public bill submission link, pinned in the Makkah and Jeddah WhatsApp
// groups. No login: ten store managers with ten passwords they would forget
// every third week is what kills adoption of a tool like this.
//
// Branches are fetched here, on the server, rather than by the browser client.
// That keeps ice_branches free of any anon-readable RLS policy — the page hands
// the list down as props and the public role never touches the table.
export const dynamic = 'force-dynamic';

export default async function BillPage() {
  let branches: IceBranch[] = [];
  let loadError = false;

  try {
    const supabaseAdmin = getSupabaseAdminClient();
    const { data, error } = await supabaseAdmin
      .from('ice_branches')
      .select('id, name_en, name_ar, city, sort_order')
      .eq('active', true)
      .order('city', { ascending: true })
      .order('sort_order', { ascending: true });

    if (error) throw error;
    branches = (data || []) as IceBranch[];
  } catch (err) {
    console.error('Could not load ice cream branches:', err);
    loadError = true;
  }

  return (
    <main className="min-h-screen bg-[#fafafa] flex items-center justify-center p-4 selection:bg-yellow-200 selection:text-black">
      <div className="w-full max-w-lg bg-white rounded-[24px] shadow-sm overflow-hidden mt-8 mb-8 border border-gray-200">
        <div className="w-full">
          <Image
            src="/logo.png"
            alt="Kayan Sweets"
            width={1200}
            height={600}
            className="w-full h-auto object-contain"
            priority
          />
        </div>
        <BillForm branches={branches} loadError={loadError} />
      </div>
    </main>
  );
}
