import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase-server';
import { USER_PROFILE_HEADER } from '@/lib/constants';
import Sidebar from './Sidebar';

type DashboardProfile = {
  role: string;
  full_name?: string | null;
  email?: string | null;
};

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Fast path: the middleware already verified the session and handed us the
  // profile via a request header, so we avoid a second round-trip to the DB.
  let profile: DashboardProfile | null = null;
  const headerProfile = headers().get(USER_PROFILE_HEADER);

  if (headerProfile) {
    try {
      profile = JSON.parse(headerProfile) as DashboardProfile;
    } catch {
      profile = null;
    }
  }

  // Fallback: if the header is somehow missing (e.g. middleware didn't run),
  // verify the session ourselves. This keeps the page safe on its own.
  if (!profile) {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      redirect('/login');
    }

    const { data } = await supabase
      .from('profiles')
      .select('role, full_name, email')
      .eq('id', user.id)
      .single();

    if (!data) {
      redirect('/unauthorized');
    }

    profile = data as DashboardProfile;
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar profile={profile} />
      <div className="flex-1 lg:ml-[240px] pt-14 lg:pt-0">
        {children}
      </div>
    </div>
  );
}
