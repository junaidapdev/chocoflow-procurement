'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { FileText, CheckSquare, CreditCard, Building2, LogOut, Menu, X } from 'lucide-react';

export default function Sidebar({ profile }: { profile: any }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  };

  const navItems = [
    { name: 'Verify Invoices', href: '/dashboard/verify', roles: ['amin'], icon: FileText },
    { name: 'Approve Invoices', href: '/dashboard/approve', roles: ['salam'], icon: CheckSquare },
    { name: 'Finance Hub', href: '/dashboard/finance', roles: ['accountant', 'salam'], icon: CreditCard },
    { name: 'Brand Directory', href: '/dashboard/brands', roles: ['amin', 'salam'], icon: Building2 },
  ];

  const sidebarContent = (
    <>
      <div className="p-6">
        <h1 className="text-2xl font-black text-gray-900 tracking-tight">Kayan Sweets</h1>
        <p className="text-xs text-gray-400 font-medium tracking-widest uppercase mt-1">Dashboard</p>
      </div>

      <nav className="flex-1 px-4 space-y-2 mt-4">
        {navItems.map((item) => {
          if (!item.roles.includes(profile.role)) return null;
          
          const isActive = pathname.startsWith(item.href);
          const Icon = item.icon;

          return (
            <Link 
              key={item.href} 
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center px-4 py-3 rounded-xl text-sm font-bold transition-all ${isActive ? 'bg-emerald-50 text-emerald-700' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'}`}
            >
              <Icon className={`w-5 h-5 mr-3 ${isActive ? 'text-emerald-500' : 'text-gray-400'}`} />
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-gray-100">
        <div className="bg-gray-50 rounded-xl p-4 flex flex-col">
          <span className="text-sm font-bold text-gray-900 truncate">{profile.full_name || profile.email}</span>
          <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold mt-0.5">{profile.role}</span>
          
          <button 
            onClick={handleLogout}
            className="mt-4 flex items-center text-red-600 hover:text-red-700 transition-colors text-sm font-medium"
          >
            <LogOut className="w-4 h-4 mr-2" /> Logout
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="lg:hidden fixed top-0 left-0 right-0 h-14 bg-white border-b border-gray-200 flex items-center px-4 z-30">
        <button 
          onClick={() => setMobileOpen(true)}
          className="p-2 -ml-1 rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
        <h1 className="ml-3 text-lg font-black text-gray-900 tracking-tight">Kayan Sweets</h1>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div 
          className="lg:hidden fixed inset-0 bg-black/40 z-40 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <div className={`lg:hidden fixed inset-y-0 left-0 w-[280px] bg-white z-50 flex flex-col shadow-2xl transition-transform duration-300 ease-in-out ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="absolute top-3 right-3">
          <button 
            onClick={() => setMobileOpen(false)}
            className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {sidebarContent}
      </div>

      {/* Desktop sidebar */}
      <div className="hidden lg:flex w-[240px] fixed inset-y-0 left-0 bg-white border-r border-gray-200 flex-col z-10">
        {sidebarContent}
      </div>
    </>
  );
}
