'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Loader2, AlertCircle } from 'lucide-react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      const { data, error: loginError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (loginError) throw loginError;
      
      // We also check their role immediately for a quick client bounce (opt-in)
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', data.user.id)
        .single();
        
      if (profile?.role === 'amin') {
        router.push('/dashboard/verify');
      } else if (profile?.role === 'salam') {
        router.push('/dashboard/approve');
      } else if (profile?.role === 'accountant') {
        router.push('/dashboard/finance');
      } else if (profile?.role === 'payer') {
        router.push('/dashboard/payments');
      } else {
        router.push('/unauthorized');
      }
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed. Please check your credentials.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#fafafa] p-4 text-black">
      <div className="w-full max-w-md bg-white rounded-[24px] shadow-sm overflow-hidden border border-gray-200">
        <div className="bg-white border-b border-gray-100 py-10 px-6 text-center">
          <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight mb-2">Kayan Sweets</h1>
          <p className="text-gray-500 text-sm font-medium tracking-wide uppercase">Admin Sign In</p>
        </div>
        
        <form onSubmit={handleLogin} className="p-8 space-y-6">
          {error && (
            <div className="p-4 bg-red-50 border-l-4 border-red-500 text-sm text-red-700 flex items-start">
              <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0" />
              <p>{error}</p>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-semibold text-gray-700">Email Address</label>
            <input 
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-xl border border-gray-200 text-gray-900 bg-gray-50/50 focus:bg-white focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 transition-colors outline-none"
              placeholder="admin@kayansweets.com"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold text-gray-700">Password</label>
            <input 
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-xl border border-gray-200 text-gray-900 bg-gray-50/50 focus:bg-white focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 transition-colors outline-none"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full mt-4 bg-black hover:bg-gray-900 text-white font-bold py-4 px-6 rounded-xl transition-all disabled:opacity-70 disabled:cursor-not-allowed shadow-none active:scale-[0.98] flex justify-center"
          >
            {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Access Dashboard'}
          </button>
        </form>
      </div>
    </div>
  );
}
