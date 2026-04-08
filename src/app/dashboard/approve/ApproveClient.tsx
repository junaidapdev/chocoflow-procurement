'use client';

import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { CheckSquare, Square, FileText, CheckCircle2, TrendingUp, Filter, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';

type Invoice = {
  id: string;
  brand_name: string;
  branch_id: string;
  invoice_number: string;
  invoice_date: string;
  amount: number;
  invoice_url: string;
  status: string;
  vendor_name: string;
  created_at: string;
  updated_at: string;
};

export default function ApproveClient({ initialInvoices }: { initialInvoices: Invoice[] }) {
  const [invoices, setInvoices] = useState<Invoice[]>(initialInvoices);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string>('Verified'); // Stats bar filter

  const openSecureDocument = async (pathOrUrl: string, bucket: string) => {
    let path = pathOrUrl;
    if (pathOrUrl.startsWith('http')) {
      const parts = pathOrUrl.split(`/public/${bucket}/`);
      if (parts.length > 1) path = parts[1];
    }
    const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
    if (data?.signedUrl) {
      window.open(data.signedUrl, '_blank');
    } else {
      alert('Could not secure file link.');
    }
  };

  // Derived state
  const pendingCount = invoices.filter(inv => inv.status === 'Pending').length;
  const verifiedCount = invoices.filter(inv => inv.status === 'Verified').length;
  const approvedCount = invoices.filter(inv => inv.status === 'Approved').length;
  const paidCount = invoices.filter(inv => inv.status === 'Paid').length;

  const totalOutstanding = useMemo(() => {
    return invoices
      .filter(inv => inv.status === 'Verified' || inv.status === 'Approved')
      .reduce((sum, inv) => sum + Number(inv.amount), 0);
  }, [invoices]);

  const brandSummary = useMemo(() => {
    const validInvoices = invoices.filter(inv => inv.status === 'Verified' || inv.status === 'Approved');
    const summary: Record<string, { count: number, total: number }> = {};
    
    validInvoices.forEach(inv => {
      if (!summary[inv.brand_name]) summary[inv.brand_name] = { count: 0, total: 0 };
      summary[inv.brand_name].count += 1;
      summary[inv.brand_name].total += Number(inv.amount);
    });
    
    return Object.entries(summary).sort((a, b) => b[1].total - a[1].total);
  }, [invoices]);

  // Queue to display
  const queueToDisplay = invoices.filter(inv => inv.status === activeFilter);
  const isAllSelected = queueToDisplay.length > 0 && queueToDisplay.every(inv => selectedIds.has(inv.id));

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) newSelected.delete(id);
    else newSelected.add(id);
    setSelectedIds(newSelected);
  };

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(queueToDisplay.map(inv => inv.id)));
    }
  };

  const handleApprove = async (idsToApprove: string[]) => {
    if (idsToApprove.length === 0) return;
    setIsProcessing(true);

    setInvoices(current => current.map(inv => 
      idsToApprove.includes(inv.id) ? { ...inv, status: 'Approved' } : inv
    ));

    setSelectedIds(new Set());

    try {
      // Send approval requests for each invoice via API
      const results = await Promise.all(
        idsToApprove.map(async (id) => {
          const res = await fetch('/api/invoices', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, status: 'Approved' }),
          });
          return { id, ok: res.ok };
        })
      );

      const failedIds = results.filter(r => !r.ok).map(r => r.id);
      if (failedIds.length > 0) {
        // Revert failed invoices back to Verified
        setInvoices(current => current.map(inv =>
          failedIds.includes(inv.id) ? { ...inv, status: 'Verified' } : inv
        ));
        alert(`Failed to approve ${failedIds.length} invoice(s). They have been reverted. Please try again.`);
      }
    } catch (err) {
      console.error('Error approving:', err);
      // Revert all on network failure
      setInvoices(current => current.map(inv =>
        idsToApprove.includes(inv.id) ? { ...inv, status: 'Verified' } : inv
      ));
      alert('Network error. All approvals have been reverted. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Top Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Pending', count: pendingCount, color: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
          { label: 'Verified', count: verifiedCount, color: 'bg-blue-50 text-blue-700 border-blue-200' },
          { label: 'Approved', count: approvedCount, color: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
          { label: 'Paid', count: paidCount, color: 'bg-green-50 text-green-700 border-green-200' }
        ].map(stat => (
          <button
            key={stat.label}
            onClick={() => setActiveFilter(stat.label)}
            className={`flex flex-col items-start p-4 rounded-xl border transition-all ${stat.color} ${activeFilter === stat.label ? 'ring-2 ring-offset-1 ring-gray-900 shadow-sm' : 'opacity-80 hover:opacity-100 hover:shadow-sm'}`}
          >
            <span className="text-sm font-semibold opacity-80 uppercase tracking-wider">{stat.label}</span>
            <span className="text-3xl font-black mt-1">{stat.count}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Section 1: Approval Queue (Takes up 2 cols on lg) */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col">
          <div className="border-b border-gray-200 px-4 sm:px-6 py-4 sm:py-5 bg-gray-50 flex flex-col sm:flex-row gap-3 sm:justify-between sm:items-center">
            <h2 className="text-lg font-bold text-gray-900 flex items-center">
              <Filter className="w-5 h-5 mr-2 text-gray-400" />
              Showing {activeFilter} Queue
            </h2>
            {activeFilter === 'Verified' && selectedIds.size > 0 && (
              <button
                disabled={isProcessing}
                onClick={() => handleApprove(Array.from(selectedIds))}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-semibold text-sm transition-colors shadow-sm disabled:opacity-50 flex items-center justify-center w-full sm:w-auto"
              >
                {isProcessing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                Approve Selected ({selectedIds.size})
              </button>
            )}
          </div>

          {/* Desktop Table */}
          <div className="overflow-x-auto flex-1 hidden lg:block">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-white text-gray-500 font-medium border-b border-gray-100 uppercase text-xs tracking-wider">
                <tr>
                  {activeFilter === 'Verified' && (
                    <th className="px-4 py-4 w-10 text-center">
                      <button onClick={toggleSelectAll} className="text-gray-400 hover:text-indigo-600 transition-colors">
                        {isAllSelected ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                      </button>
                    </th>
                  )}
                  <th className="px-6 py-4">Vendor</th>
                  <th className="px-6 py-4">Brand/Branch</th>
                  <th className="px-6 py-4">Invoice #</th>
                  <th className="px-6 py-4">Amount (SAR)</th>
                  <th className="px-6 py-4">Status Updated</th>
                  <th className="px-6 py-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {queueToDisplay.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                      No invoices currently in the {activeFilter} state.
                    </td>
                  </tr>
                ) : (
                  queueToDisplay.map((inv) => (
                    <tr key={inv.id} className={`transition-colors ${selectedIds.has(inv.id) ? 'bg-indigo-50/50' : 'hover:bg-gray-50'}`}>
                      {activeFilter === 'Verified' && (
                        <td className="px-4 py-4 text-center">
                          <button onClick={() => toggleSelect(inv.id)} className={`${selectedIds.has(inv.id) ? 'text-indigo-600' : 'text-gray-300 hover:text-indigo-400'} transition-colors`}>
                            {selectedIds.has(inv.id) ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                          </button>
                        </td>
                      )}
                      <td className="px-6 py-4 font-medium text-gray-900">{inv.vendor_name}</td>
                      <td className="px-6 py-4">
                        <div className="font-semibold">{inv.brand_name}</div>
                        <div className="text-gray-500 text-xs">{inv.branch_id}</div>
                      </td>
                      <td className="px-6 py-4 text-gray-600">
                        <button onClick={() => openSecureDocument(inv.invoice_url, 'invoices')} className="flex items-center hover:text-indigo-600 hover:underline cursor-pointer">
                          <FileText className="w-3.5 h-3.5 mr-1" />
                          {inv.invoice_number}
                        </button>
                      </td>
                      <td className="px-6 py-4 font-bold text-gray-900">
                        {inv.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-6 py-4 text-gray-500 text-xs">
                        {format(new Date(inv.updated_at), 'MMM dd, p')}
                      </td>
                      <td className="px-6 py-4 text-center">
                        {activeFilter === 'Verified' ? (
                          <button
                            onClick={() => handleApprove([inv.id])}
                            disabled={isProcessing}
                            className="bg-gray-100 hover:bg-indigo-50 hover:text-indigo-700 text-gray-700 text-xs font-semibold px-3 py-1.5 rounded transition-colors"
                          >
                            Approve
                          </button>
                        ) : (
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-md font-medium uppercase tracking-wide">
                            {inv.status}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile Cards */}
          <div className="lg:hidden divide-y divide-gray-100">
            {queueToDisplay.length === 0 ? (
              <div className="px-4 py-12 text-center text-gray-500">
                No invoices currently in the {activeFilter} state.
              </div>
            ) : (
              queueToDisplay.map((inv) => (
                <div key={inv.id} className={`p-4 space-y-3 ${selectedIds.has(inv.id) ? 'bg-indigo-50/50' : ''}`}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      {activeFilter === 'Verified' && (
                        <button onClick={() => toggleSelect(inv.id)} className={`mt-0.5 ${selectedIds.has(inv.id) ? 'text-indigo-600' : 'text-gray-300'}`}>
                          {selectedIds.has(inv.id) ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                        </button>
                      )}
                      <div>
                        <p className="font-semibold text-gray-900">{inv.vendor_name}</p>
                        <p className="text-xs text-gray-500">{inv.brand_name} • {inv.branch_id}</p>
                      </div>
                    </div>
                    <span className="text-lg font-bold text-gray-900 whitespace-nowrap">
                      {inv.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-xs text-gray-500 font-normal">SAR</span>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                    <button onClick={() => openSecureDocument(inv.invoice_url, 'invoices')} className="flex items-center text-indigo-600">
                      <FileText className="w-3 h-3 mr-1" />{inv.invoice_number}
                    </button>
                    <span>Updated {format(new Date(inv.updated_at), 'MMM dd, p')}</span>
                  </div>
                  <div className="flex justify-end pt-1">
                    {activeFilter === 'Verified' ? (
                      <button
                        onClick={() => handleApprove([inv.id])}
                        disabled={isProcessing}
                        className="bg-indigo-600 text-white text-xs font-semibold px-4 py-1.5 rounded-md disabled:opacity-50"
                      >
                        Approve
                      </button>
                    ) : (
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-md font-medium uppercase">
                        {inv.status}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Section 2: Financial Summary (Takes up 1 col on lg) */}
        <div className="space-y-6">
          <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-xl shadow-lg p-6 text-white border border-gray-700">
            <h3 className="text-gray-400 text-sm font-semibold tracking-wider uppercase mb-2">Total Outstanding</h3>
            <div className="flex items-baseline space-x-2">
              <span className="text-4xl font-extrabold tracking-tight">
                {totalOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
              <span className="text-gray-400 font-medium">SAR</span>
            </div>
            <p className="text-xs text-gray-500 mt-2 flex items-center">
              <TrendingUp className="w-3.5 h-3.5 mr-1.5" /> Includes Verified & Approved
            </p>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="border-b border-gray-100 px-5 py-4 bg-gray-50/50">
              <h3 className="font-bold text-gray-900">Brand Breakdown</h3>
              <p className="text-xs text-gray-500">Volumetric overview</p>
            </div>
            <div className="p-0">
              <table className="w-full text-sm text-left">
                <thead className="bg-white text-gray-400 text-xs border-b border-gray-100">
                  <tr>
                    <th className="px-5 py-2.5 font-medium">Brand</th>
                    <th className="px-5 py-2.5 font-medium text-center">Inv</th>
                    <th className="px-5 py-2.5 font-medium text-right">Total (SAR)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {brandSummary.length === 0 ? (
                     <tr>
                       <td colSpan={3} className="px-5 py-8 text-center text-gray-400 text-xs font-medium">No valid data</td>
                     </tr>
                  ) : (
                    brandSummary.map(([brand, stats]) => (
                      <tr key={brand} className="hover:bg-gray-50/50">
                        <td className="px-5 py-3 font-semibold text-gray-900">{brand}</td>
                        <td className="px-5 py-3 text-center text-gray-500">{stats.count}</td>
                        <td className="px-5 py-3 text-right font-medium text-gray-700">
                           {stats.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
