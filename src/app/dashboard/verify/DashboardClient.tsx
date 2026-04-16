'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { Check, X, FileText, Loader2, MessageSquareX } from 'lucide-react';
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
  rejection_comment: string | null;
  created_at: string;
  type?: 'invoice' | 'return';
};

const TypeCell = ({ type }: { type?: string }) => {
  if (type === 'return') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-md bg-rose-100 text-rose-800 border border-rose-300 whitespace-nowrap">
        ↩ Return
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-md bg-gray-100 text-gray-500 whitespace-nowrap">
      Invoice
    </span>
  );
};

export default function DashboardClient({ initialInvoices }: { initialInvoices: Invoice[] }) {
  const [invoices, setInvoices] = useState<Invoice[]>(initialInvoices);
  const [activeTab, setActiveTab] = useState<'Pending' | 'Rejected'>('Pending');
  
  // Modal State
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [invoiceToReject, setInvoiceToReject] = useState<Invoice | null>(null);
  const [rejectionComment, setRejectionComment] = useState('');
  const [isProcessing, setIsProcessing] = useState<string | null>(null); // holds invoice ID

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

  const filteredInvoices = invoices.filter(inv => inv.status === activeTab);
  const pendingCount = invoices.filter(inv => inv.status === 'Pending').length;

  const handleVerify = async (id: string) => {
    setIsProcessing(id);
    
    // Optimistic UI Update
    setInvoices(current => 
      current.map(inv => inv.id === id ? { ...inv, status: 'Verified' } : inv)
    );

    try {
      const res = await fetch('/api/invoices', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'Verified' }),
      });

      if (!res.ok) {
        throw new Error('Server rejected the request');
      }
    } catch (err) {
      console.error('Error verifying:', err);
      // Revert optimistic update
      setInvoices(current =>
        current.map(inv => inv.id === id ? { ...inv, status: 'Pending' } : inv)
      );
      alert('Failed to verify invoice. Please try again.');
    } finally {
      setIsProcessing(null);
    }
  };

  const openRejectModal = (invoice: Invoice) => {
    setInvoiceToReject(invoice);
    setRejectionComment('');
    setRejectModalOpen(true);
  };

  const handleRejectConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invoiceToReject || !rejectionComment.trim()) return;

    const id = invoiceToReject.id;
    setIsProcessing(id);
    setRejectModalOpen(false);

    // Optimistic update
    setInvoices(current => 
      current.map(inv => 
        inv.id === id 
          ? { ...inv, status: 'Rejected', rejection_comment: rejectionComment } 
          : inv
      )
    );

    try {
      const res = await fetch('/api/invoices', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'Rejected', rejection_comment: rejectionComment }),
      });

      if (!res.ok) {
        throw new Error('Server rejected the request');
      }
    } catch (err) {
      console.error('Error rejecting:', err);
      // Revert optimistic update
      setInvoices(current =>
        current.map(inv =>
          inv.id === id
            ? { ...inv, status: 'Pending', rejection_comment: null }
            : inv
        )
      );
      alert('Failed to reject invoice. Please try again.');
    } finally {
      setIsProcessing(null);
      setInvoiceToReject(null);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Tabs Layout */}
      <div className="flex border-b border-gray-200 px-4 bg-gray-50/50">
        <button
          onClick={() => setActiveTab('Pending')}
          className={`px-6 py-4 text-sm font-semibold flex items-center border-b-2 transition-colors ${activeTab === 'Pending' ? 'border-amber-500 text-amber-700 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}
        >
          Requires Review
          {pendingCount > 0 && (
            <span className="ml-2 bg-amber-100 text-amber-800 py-0.5 px-2.5 rounded-full text-xs">
              {pendingCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('Rejected')}
          className={`px-6 py-4 text-sm font-semibold flex items-center border-b-2 transition-colors ${activeTab === 'Rejected' ? 'border-red-500 text-red-700 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}
        >
          Rejected
        </button>
      </div>

      {/* Desktop Table */}
      <div className="overflow-x-auto hidden lg:block">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-gray-50 text-gray-500 font-medium border-b border-gray-200 uppercase text-xs tracking-wider">
            <tr>
              <th className="px-3 py-4">TYPE</th>
              <th className="px-4 py-4">VENDOR</th>
              <th className="px-4 py-4">BRAND / BRANCH</th>
              <th className="px-4 py-4">REF NO.</th>
              <th className="px-4 py-4">DATE</th>
              <th className="px-4 py-4 text-right">AMOUNT (SAR)</th>
              <th className="px-4 py-4">SUBMITTED AT</th>
              <th className="px-4 py-4">DOCUMENT</th>
              <th className="px-4 py-4 text-center">ACTION</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredInvoices.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-6 py-12 text-center text-gray-500">
                  <div className="flex flex-col items-center justify-center">
                    <Check className="w-8 h-8 text-gray-300 mb-2" />
                    <p>No {activeTab.toLowerCase()} invoices found.</p>
                  </div>
                </td>
              </tr>
            ) : (
              filteredInvoices.map((inv) => {
                const isReturn = inv.type === 'return';
                return (
                <tr key={inv.id} className={`transition-colors ${isReturn ? 'bg-rose-50/50 hover:bg-rose-50' : 'hover:bg-gray-50/50'}`}>
                  <td className="px-3 py-4">
                    <TypeCell type={inv.type} />
                  </td>
                  <td className="px-4 py-4">
                    <div className="font-medium text-gray-900">{inv.vendor_name}</div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="font-medium text-gray-900">{inv.brand_name}</div>
                    <div className="text-gray-500 text-xs">{inv.branch_id}</div>
                  </td>
                  <td className={`px-4 py-4 font-mono text-xs ${isReturn ? 'text-rose-700' : 'text-gray-600'}`}>
                    {inv.invoice_number}
                  </td>
                  <td className="px-4 py-4 text-gray-600">
                    {format(new Date(inv.invoice_date), 'MMM dd, yyyy')}
                  </td>
                  <td className="px-4 py-4 text-right">
                    <div className={`font-semibold ${isReturn ? 'text-rose-700' : 'text-gray-900'}`}>
                      {isReturn && <span className="mr-0.5 opacity-70">−</span>}
                      {inv.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </div>
                  </td>
                  <td className="px-4 py-4 text-gray-500 text-xs">
                    {format(new Date(inv.created_at), 'MMM dd, p')}
                  </td>
                  <td className="px-4 py-4">
                    {inv.invoice_url ? (
                      <button
                        onClick={() => openSecureDocument(inv.invoice_url, 'invoices')}
                        className={`inline-flex items-center transition-colors font-medium text-xs px-3 py-1.5 rounded-full ${isReturn ? 'text-rose-700 hover:text-rose-900 bg-rose-50' : 'text-amber-600 hover:text-amber-800 bg-amber-50'}`}
                      >
                        <FileText className="w-3.5 h-3.5 mr-1.5" />
                        View PDF
                      </button>
                    ) : (
                      <span className="text-gray-400 text-xs italic">N/A</span>
                    )}
                  </td>
                  <td className="px-4 py-4 text-center">
                    {activeTab === 'Pending' ? (
                      <div className="flex flex-col items-center gap-1.5">
                        <button
                          onClick={() => handleVerify(inv.id)}
                          disabled={isProcessing === inv.id}
                          className="flex items-center justify-center text-xs font-semibold w-24 py-1.5 bg-emerald-600 text-white hover:bg-emerald-700 rounded-md transition-colors disabled:opacity-50 shadow-sm"
                        >
                          {isProcessing === inv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Check className="w-3.5 h-3.5 mr-1" />}
                          Verify
                        </button>
                        <button
                          onClick={() => openRejectModal(inv)}
                          disabled={isProcessing === inv.id}
                          className="flex items-center justify-center text-xs font-semibold w-24 py-1.5 bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 rounded-md transition-colors disabled:opacity-50"
                        >
                          <X className="w-3.5 h-3.5 mr-1" />
                          Reject
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col text-left max-w-[200px] group relative">
                         <span className="text-red-700 text-xs font-semibold flex items-center mb-0.5">
                           <MessageSquareX className="w-3 h-3 mr-1" /> Rejected
                         </span>
                         <span className="text-xs text-gray-500 truncate" title={inv.rejection_comment || ''}>
                           {inv.rejection_comment}
                         </span>
                      </div>
                    )}
                  </td>
                </tr>
              );})
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile Cards */}
      <div className="lg:hidden divide-y divide-gray-100">
        {filteredInvoices.length === 0 ? (
          <div className="px-4 py-12 text-center text-gray-500">
            <Check className="w-8 h-8 text-gray-300 mb-2 mx-auto" />
            <p>No {activeTab.toLowerCase()} invoices found.</p>
          </div>
        ) : (
          filteredInvoices.map((inv) => {
            const isReturn = inv.type === 'return';
            return (
            <div key={inv.id} className={`space-y-3 ${isReturn ? 'bg-rose-50/40' : ''}`}>
              {isReturn && (
                <div className="bg-rose-100 border-b border-rose-200 px-4 py-1.5 flex items-center gap-1.5">
                  <span className="text-xs font-bold text-rose-800 uppercase tracking-wider">↩ Return Bill</span>
                </div>
              )}
              <div className="px-4 pt-2 pb-4 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-semibold text-gray-900">{inv.vendor_name}</p>
                  <p className="text-xs text-gray-500">{inv.brand_name} • {inv.branch_id}</p>
                </div>
                <span className={`text-lg font-bold whitespace-nowrap ${isReturn ? 'text-rose-700' : 'text-gray-900'}`}>
                  {isReturn && <span className="text-sm mr-0.5">−</span>}
                  {inv.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-xs text-gray-500 font-normal">SAR</span>
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                <span>Ref: <span className={`font-mono ${isReturn ? 'text-rose-700' : 'text-gray-700'}`}>{inv.invoice_number}</span></span>
                <span>{format(new Date(inv.invoice_date), 'MMM dd, yyyy')}</span>
                <span>Submitted {format(new Date(inv.created_at), 'MMM dd, p')}</span>
              </div>
              <div className="flex items-center gap-2 pt-1">
                {inv.invoice_url && (
                  <button 
                    onClick={() => openSecureDocument(inv.invoice_url, 'invoices')}
                    className="inline-flex items-center text-amber-600 font-medium text-xs bg-amber-50 px-3 py-1.5 rounded-full"
                  >
                    <FileText className="w-3.5 h-3.5 mr-1" />
                    View PDF
                  </button>
                )}
                {activeTab === 'Pending' ? (
                  <>
                    <button
                      onClick={() => handleVerify(inv.id)}
                      disabled={isProcessing === inv.id}
                      className="flex items-center text-xs font-semibold px-4 py-1.5 bg-emerald-600 text-white rounded-md disabled:opacity-50 ml-auto"
                    >
                      {isProcessing === inv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Check className="w-3.5 h-3.5 mr-1" />}
                      Verify
                    </button>
                    <button
                      onClick={() => openRejectModal(inv)}
                      disabled={isProcessing === inv.id}
                      className="flex items-center text-xs font-semibold px-3 py-1.5 bg-red-50 text-red-700 border border-red-200 rounded-md disabled:opacity-50"
                    >
                      <X className="w-3.5 h-3.5 mr-1" />
                      Reject
                    </button>
                  </>
                ) : (
                  <div className="ml-auto">
                    <span className="text-red-700 text-xs font-semibold flex items-center">
                      <MessageSquareX className="w-3 h-3 mr-1" /> {inv.rejection_comment}
                    </span>
                  </div>
                )}
              </div>
              </div>
            </div>
          );})
        )}
      </div>

      {/* Reject Modal */}
      {rejectModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="border-b border-gray-100 px-6 py-4 flex justify-between items-center">
              <h3 className="font-bold text-gray-900">Reject Invoice</h3>
              <button onClick={() => setRejectModalOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleRejectConfirm} className="p-6">
              <div className="mb-4 text-sm text-gray-600 bg-red-50 p-3 rounded-md border border-red-100">
                <span className="font-semibold text-gray-800">Target:</span> {invoiceToReject?.vendor_name} ({invoiceToReject?.invoice_number})
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold text-gray-700">Rejection Reason <span className="text-red-500">*</span></label>
                <textarea
                  required
                  autoFocus
                  className="w-full px-4 py-3 rounded-lg border border-gray-200 bg-gray-50 focus:bg-white focus:border-red-400 focus:ring-2 focus:ring-red-100 transition-colors outline-none min-h-[100px] resize-none"
                  placeholder="Specify why this invoice is being rejected..."
                  value={rejectionComment}
                  onChange={(e) => setRejectionComment(e.target.value)}
                />
              </div>
              <div className="mt-6 flex space-x-3 justify-end">
                <button
                  type="button"
                  onClick={() => setRejectModalOpen(false)}
                  className="px-4 py-2 border border-gray-200 text-gray-700 bg-white hover:bg-gray-50 font-medium rounded-lg text-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg text-sm shadow-sm transition-colors"
                >
                  Confirm Rejection
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
