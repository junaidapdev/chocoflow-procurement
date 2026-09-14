'use client';

import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { CheckSquare, Square, FileText, CheckCircle2, TrendingUp, Filter, Loader2, MessageSquareX, RotateCcw, Search } from 'lucide-react';
import { openSecureDocument } from '@/lib/storage';
import { getBankAccountLabel, getBrandEnglishName } from '@/lib/constants';
import { formatPaymentDate } from '@/lib/dates';

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
  payment_date?: string | null;
  bank_account?: string | null;
  type?: 'invoice' | 'return';
  rejection_comment?: string | null;
};

const TypeCell = ({ type }: { type?: string }) => {
  if (type === 'return') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-md bg-rose-100 text-rose-800 border border-rose-300 whitespace-nowrap">
        ↩ Return Bill
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-md bg-gray-100 text-gray-500 whitespace-nowrap">
      Invoice
    </span>
  );
};

const signedAmount = (inv: { type?: string; amount: number }) =>
  (inv.type === 'return' ? -1 : 1) * Number(inv.amount);

// Brand totals are sums of floats, so a brand whose returns exactly cancel its
// invoices can land on 1e-13 rather than 0 - which would render as "0.00" but
// fail an `=== 0` check and get styled as a live amount. Round to halalas once
// and use that value for both the display and the zero/negative styling.
const toHalalas = (n: number) => Math.round(n * 100) / 100;

// Negatives are shown with a real minus sign (U+2212), matching how return
// bills are rendered in the invoice list.
const formatSigned = (n: number) => {
  const v = toHalalas(n);
  const body = Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return v < 0 ? `−${body}` : body;
};

export default function ApproveClient({ initialInvoices }: { initialInvoices: Invoice[] }) {
  const [invoices, setInvoices] = useState<Invoice[]>(initialInvoices);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [reopeningId, setReopeningId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>('Verified'); // Stats bar filter
  const [brandQuery, setBrandQuery] = useState('');


  // Derived state
  const pendingCount = invoices.filter(inv => inv.status === 'Pending').length;
  const verifiedCount = invoices.filter(inv => inv.status === 'Verified').length;
  const approvedCount = invoices.filter(inv => inv.status === 'Approved').length;
  const readyToPayCount = invoices.filter(inv => inv.status === 'ReadyToPay').length;
  const paidCount = invoices.filter(inv => inv.status === 'Paid').length;
  const rejectedCount = invoices.filter(inv => inv.status === 'Rejected').length;

  // Net-aware totals broken down by status. Returns subtract within their
  // bucket — so an Approved return reduces the Approved total, not Verified.
  // Outstanding = everything that hasn't been physically paid yet, which
  // includes ReadyToPay (accountant has authorized, payer hasn't transferred).
  //
  // Pending is reported alongside but deliberately NOT folded into
  // `outstanding`: nobody has checked those invoices yet, so the amount can
  // still change or be rejected outright. Counting unverified vendor
  // submissions as money the company owes would overstate the figure the
  // manager plans against.
  const totalsByStatus = useMemo(() => {
    const sumStatus = (status: string) =>
      invoices
        .filter(inv => inv.status === status)
        .reduce((sum, inv) => sum + signedAmount(inv), 0);

    const pending = sumStatus('Pending');
    const verified = sumStatus('Verified');
    const approved = sumStatus('Approved');
    const readyToPay = sumStatus('ReadyToPay');
    const paid = sumStatus('Paid');
    return {
      pending,
      verified,
      approved,
      readyToPay,
      paid,
      outstanding: verified + approved + readyToPay, // money committed but not yet sent
    };
  }, [invoices]);

  const totalOutstanding = totalsByStatus.outstanding;

  // Per-brand breakdown across all four stages, mirroring the Total
  // Outstanding card above but split by brand.
  //
  // `outstanding` deliberately excludes Paid: that money has already left the
  // bank, so folding it in would make every settled brand look like a debt.
  // Paid is carried alongside as all-time history instead.
  //
  // Pending is carried per brand too, and stays out of `outstanding` for the
  // same reason it stays out of the company total above.
  //
  // `count` counts every open invoice, Pending included - those are real work
  // still in the pipeline even though their amounts aren't committed yet. A
  // brand with nothing open but a payment history still gets a card: every
  // stage reads 0.00 and it sorts to the bottom.
  const brandSummary = useMemo(() => {
    type BrandStats = {
      count: number;
      outstanding: number;
      pending: number;
      verified: number;
      approved: number;
      readyToPay: number;
      paid: number;
    };
    const summary: Record<string, BrandStats> = {};

    invoices
      .filter(inv => ['Pending', 'Verified', 'Approved', 'ReadyToPay', 'Paid'].includes(inv.status))
      .forEach(inv => {
        if (!summary[inv.brand_name]) {
          summary[inv.brand_name] = {
            count: 0, outstanding: 0, pending: 0, verified: 0, approved: 0, readyToPay: 0, paid: 0,
          };
        }
        const amt = signedAmount(inv);
        const s = summary[inv.brand_name];

        if (inv.status === 'Paid') {
          s.paid += amt;
          return;
        }

        s.count += 1;

        if (inv.status === 'Pending') {
          s.pending += amt;
          return;
        }

        s.outstanding += amt;
        if (inv.status === 'Verified') s.verified += amt;
        else if (inv.status === 'Approved') s.approved += amt;
        else if (inv.status === 'ReadyToPay') s.readyToPay += amt;
      });

    // Most owed first. Fully settled brands all tie on 0 outstanding, so they
    // fall back to largest payment history rather than an arbitrary order.
    return Object.entries(summary).sort(
      (a, b) => b[1].outstanding - a[1].outstanding || b[1].paid - a[1].paid,
    );
  }, [invoices]);

  // Every brand with any invoice history, shown the same way - no split
  // between brands that owe money and brands that don't. The manager sees
  // what is actually there and decides for themselves what matters; a brand
  // sitting at zero is information too. The search box narrows the list when
  // they want one brand rather than all of them.
  const visibleBrands = useMemo(() => {
    const q = brandQuery.trim().toLowerCase();
    if (!q) return brandSummary;

    return brandSummary.filter(([brand]) =>
      brand.toLowerCase().includes(q) ||
      (getBrandEnglishName(brand) || '').toLowerCase().includes(q));
  }, [brandSummary, brandQuery]);

  // Queue to display
  const queueToDisplay = invoices.filter(inv => inv.status === activeFilter);
  // Friendly label for headings (DB uses "ReadyToPay", users read "Ready to Pay")
  const filterLabel = activeFilter === 'ReadyToPay' ? 'Ready to Pay' : activeFilter;
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

  // Re-open a rejected invoice — flips it back to Pending so the admin can
  // re-review. The original rejection_comment is preserved on the row so the
  // admin sees context on the second pass ("previously rejected for: ...").
  const handleReopen = async (inv: Invoice) => {
    if (!confirm(`Re-open invoice #${inv.invoice_number} for review?\n\nThe admin will see it again in the Pending queue.`)) {
      return;
    }
    setReopeningId(inv.id);

    // Optimistic update
    setInvoices(curr => curr.map(i => (i.id === inv.id ? { ...i, status: 'Pending' } : i)));

    try {
      const res = await fetch('/api/invoices', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: inv.id, status: 'Pending' }),
      });
      if (!res.ok) {
        const result = await res.json().catch(() => null);
        throw new Error(result?.error || 'Server rejected the request');
      }
    } catch (err) {
      console.error('Failed to re-open invoice:', err);
      // Revert on failure
      setInvoices(curr => curr.map(i => (i.id === inv.id ? { ...i, status: 'Rejected' } : i)));
      alert(err instanceof Error ? err.message : 'Failed to re-open invoice. Please try again.');
    } finally {
      setReopeningId(null);
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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { value: 'Pending',    label: 'Pending',     count: pendingCount,    color: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
          { value: 'Verified',   label: 'Verified',    count: verifiedCount,   color: 'bg-blue-50 text-blue-700 border-blue-200' },
          { value: 'Approved',   label: 'Approved',    count: approvedCount,   color: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
          { value: 'ReadyToPay', label: 'Ready to Pay',count: readyToPayCount, color: 'bg-amber-50 text-amber-700 border-amber-200' },
          { value: 'Paid',       label: 'Paid',        count: paidCount,       color: 'bg-green-50 text-green-700 border-green-200' },
          { value: 'Rejected',   label: 'Rejected',    count: rejectedCount,   color: 'bg-red-50 text-red-700 border-red-200' },
        ].map(stat => (
          <button
            key={stat.value}
            onClick={() => setActiveFilter(stat.value)}
            className={`flex flex-col items-start p-4 rounded-xl border transition-all ${stat.color} ${activeFilter === stat.value ? 'ring-2 ring-offset-1 ring-gray-900 shadow-sm' : 'opacity-80 hover:opacity-100 hover:shadow-sm'}`}
          >
            <span className="text-sm font-semibold opacity-80 uppercase tracking-wider">{stat.label}</span>
            <span className="text-3xl font-black mt-1">{stat.count}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        
        {/* Section 1: Approval Queue (Takes up 2 cols on lg) */}
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col">
          <div className="border-b border-gray-200 px-4 sm:px-6 py-4 sm:py-5 bg-gray-50 flex flex-col sm:flex-row gap-3 sm:justify-between sm:items-center">
            <h2 className="text-lg font-bold text-gray-900 flex items-center">
              <Filter className="w-5 h-5 mr-2 text-gray-400" />
              Showing {filterLabel} Queue
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
                  <th className="px-6 py-4">Type</th>
                  <th className="px-6 py-4">Vendor</th>
                  <th className="px-6 py-4">Brand/Branch</th>
                  <th className="px-6 py-4">Ref #</th>
                  <th className="px-6 py-4">Amount (SAR)</th>
                  <th className="px-6 py-4">{activeFilter === 'Paid' ? 'Paid' : 'Status Updated'}</th>
                  <th className="px-6 py-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {queueToDisplay.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                      No invoices currently in the {filterLabel} state.
                    </td>
                  </tr>
                ) : (
                  queueToDisplay.map((inv) => {
                    const isReturn = inv.type === 'return';
                    const isSelected = selectedIds.has(inv.id);
                    return (
                    <tr key={inv.id} className={`transition-colors ${isSelected ? 'bg-indigo-50/50' : isReturn ? 'bg-rose-50/40 hover:bg-rose-50' : 'hover:bg-gray-50'}`}>
                      {activeFilter === 'Verified' && (
                        <td className="px-4 py-4 text-center">
                          <button onClick={() => toggleSelect(inv.id)} className={`${isSelected ? 'text-indigo-600' : 'text-gray-300 hover:text-indigo-400'} transition-colors`}>
                            {isSelected ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                          </button>
                        </td>
                      )}
                      <td className="px-6 py-4">
                        <TypeCell type={inv.type} />
                      </td>
                      <td className="px-6 py-4 font-medium text-gray-900">{inv.vendor_name}</td>
                      <td className="px-6 py-4">
                        <div className="font-semibold text-gray-900">{inv.brand_name}</div>
                        <div className="text-gray-500 text-xs">{inv.branch_id}</div>
                      </td>
                      <td className="px-6 py-4">
                        <button onClick={() => openSecureDocument(inv.invoice_url, 'invoices')} className={`flex items-center hover:underline cursor-pointer font-mono text-xs ${isReturn ? 'text-rose-600 hover:text-rose-800' : 'text-gray-600 hover:text-indigo-600'}`}>
                          <FileText className="w-3.5 h-3.5 mr-1" />
                          {inv.invoice_number}
                        </button>
                      </td>
                      <td className={`px-6 py-4 font-bold ${isReturn ? 'text-rose-700' : 'text-gray-900'}`}>
                        {isReturn && <span className="mr-0.5 opacity-70">−</span>}
                        {inv.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-6 py-4 text-gray-500 text-xs">
                        {activeFilter === 'Paid' ? (
                          <>
                            <div className={inv.payment_date ? 'text-gray-900 font-medium' : 'text-gray-400'}>
                              {formatPaymentDate(inv.payment_date)}
                            </div>
                            <div className="text-gray-500 mt-0.5">{getBankAccountLabel(inv.bank_account)}</div>
                          </>
                        ) : (
                          format(new Date(inv.updated_at), 'MMM dd, p')
                        )}
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
                        ) : activeFilter === 'Rejected' ? (
                          <div className="flex flex-col items-stretch gap-1.5 max-w-[240px] mx-auto">
                            <div className="flex flex-col text-left">
                              <span className="text-red-700 text-xs font-semibold flex items-center mb-0.5">
                                <MessageSquareX className="w-3 h-3 mr-1" /> Rejected
                              </span>
                              <span className="text-xs text-gray-500 truncate" title={inv.rejection_comment || ''}>
                                {inv.rejection_comment || <em className="text-gray-400">No reason provided</em>}
                              </span>
                            </div>
                            <button
                              onClick={() => handleReopen(inv)}
                              disabled={reopeningId === inv.id}
                              className="flex items-center justify-center gap-1 text-xs font-semibold px-3 py-1.5 bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 rounded-md transition-colors disabled:opacity-50"
                            >
                              {reopeningId === inv.id ? (
                                <><Loader2 className="w-3 h-3 animate-spin" /> Re-opening…</>
                              ) : (
                                <><RotateCcw className="w-3 h-3" /> Re-open for Review</>
                              )}
                            </button>
                          </div>
                        ) : inv.status === 'ReadyToPay' ? (
                          <span className="text-xs font-semibold text-amber-800 bg-amber-50 px-2.5 py-1 rounded-md border border-amber-200 whitespace-nowrap">
                            WITH PAYER
                          </span>
                        ) : (
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-md font-medium uppercase tracking-wide">
                            {inv.status}
                          </span>
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
            {queueToDisplay.length === 0 ? (
              <div className="px-4 py-12 text-center text-gray-500">
                No invoices currently in the {filterLabel} state.
              </div>
            ) : (
              queueToDisplay.map((inv) => {
                const isReturn = inv.type === 'return';
                const isSelected = selectedIds.has(inv.id);
                return (
                <div key={inv.id} className={`space-y-3 ${isSelected ? 'bg-indigo-50/50' : isReturn ? 'bg-rose-50/40' : ''}`}>
                  {isReturn && (
                    <div className="bg-rose-100 border-b border-rose-200 px-4 py-1.5">
                      <span className="text-xs font-bold text-rose-800 uppercase tracking-wider">↩ Return Bill</span>
                    </div>
                  )}
                  <div className="px-4 pt-2 pb-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      {activeFilter === 'Verified' && (
                        <button onClick={() => toggleSelect(inv.id)} className={`mt-0.5 ${isSelected ? 'text-indigo-600' : 'text-gray-300'}`}>
                          {isSelected ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                        </button>
                      )}
                      <div>
                        <p className="font-semibold text-gray-900">{inv.vendor_name}</p>
                        <p className="text-xs text-gray-900 font-medium">{inv.brand_name}</p>
                        <p className="text-xs text-gray-500">{inv.branch_id}</p>
                      </div>
                    </div>
                    <span className={`text-lg font-bold whitespace-nowrap ${isReturn ? 'text-rose-700' : 'text-gray-900'}`}>
                      {isReturn && <span className="text-sm mr-0.5">−</span>}
                      {inv.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} <span className="text-xs text-gray-500 font-normal">SAR</span>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                    <button onClick={() => openSecureDocument(inv.invoice_url, 'invoices')} className={`flex items-center ${isReturn ? 'text-rose-600' : 'text-indigo-600'}`}>
                      <FileText className="w-3 h-3 mr-1" />{inv.invoice_number}
                    </button>
                    {activeFilter === 'Paid' ? (
                      <span>
                        Paid {formatPaymentDate(inv.payment_date)} · {getBankAccountLabel(inv.bank_account)}
                      </span>
                    ) : (
                      <span>Updated {format(new Date(inv.updated_at), 'MMM dd, p')}</span>
                    )}
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
                    ) : activeFilter === 'Rejected' ? (
                      <div className="flex flex-col items-end gap-2 max-w-full w-full">
                        <div className="flex flex-col items-end">
                          <span className="text-red-700 text-xs font-semibold flex items-center mb-0.5">
                            <MessageSquareX className="w-3 h-3 mr-1" /> Rejected
                          </span>
                          <span className="text-xs text-gray-600 text-right">
                            {inv.rejection_comment || <em className="text-gray-400">No reason provided</em>}
                          </span>
                        </div>
                        <button
                          onClick={() => handleReopen(inv)}
                          disabled={reopeningId === inv.id}
                          className="flex items-center justify-center gap-1 text-xs font-semibold px-3 py-1.5 bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 rounded-md transition-colors disabled:opacity-50"
                        >
                          {reopeningId === inv.id ? (
                            <><Loader2 className="w-3 h-3 animate-spin" /> Re-opening…</>
                          ) : (
                            <><RotateCcw className="w-3 h-3" /> Re-open for Review</>
                          )}
                        </button>
                      </div>
                    ) : inv.status === 'ReadyToPay' ? (
                      <span className="text-xs font-semibold text-amber-800 bg-amber-50 px-2.5 py-1 rounded-md border border-amber-200">
                        WITH PAYER
                      </span>
                    ) : (
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-md font-medium uppercase">
                        {inv.status}
                      </span>
                    )}
                  </div>
                  </div>
                </div>
              );})
            )}
          </div>
        </div>

        {/* Section 2: Financial Summary (Takes up 1 col on lg) */}
        <div className="space-y-6 lg:sticky lg:top-8">
          <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-xl shadow-lg p-6 text-white border border-gray-700">
            <h3 className="text-gray-400 text-sm font-semibold tracking-wider uppercase mb-2">Total Outstanding</h3>
            <div className="flex items-baseline space-x-2">
              <span className="text-4xl font-extrabold tracking-tight">
                {totalOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
              <span className="text-gray-400 font-medium">SAR</span>
            </div>
            <p className="text-xs text-gray-500 mt-2 flex items-center">
              <TrendingUp className="w-3.5 h-3.5 mr-1.5" /> Verified + Approved + Ready to Pay (not yet sent)
            </p>

            {/* Breakdown by status */}
            <div className="mt-5 pt-5 border-t border-gray-700/70 space-y-2.5">
              <div className="flex items-center justify-between text-sm pb-2 mb-1 border-b border-gray-700/40">
                <span className="flex items-center text-yellow-300">
                  <span className="w-2 h-2 rounded-full bg-yellow-400 mr-2" />
                  Pending
                  <span className="text-gray-500 text-[10px] ml-1.5 normal-case">(not verified)</span>
                </span>
                <span className="font-semibold tabular-nums text-yellow-200">
                  {totalsByStatus.pending.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  <span className="text-gray-500 text-xs ml-1">SAR</span>
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center text-blue-300">
                  <span className="w-2 h-2 rounded-full bg-blue-400 mr-2" />
                  Verified
                </span>
                <span className="font-semibold tabular-nums">
                  {totalsByStatus.verified.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  <span className="text-gray-500 text-xs ml-1">SAR</span>
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center text-indigo-300">
                  <span className="w-2 h-2 rounded-full bg-indigo-400 mr-2" />
                  Approved
                </span>
                <span className="font-semibold tabular-nums">
                  {totalsByStatus.approved.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  <span className="text-gray-500 text-xs ml-1">SAR</span>
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center text-amber-300">
                  <span className="w-2 h-2 rounded-full bg-amber-400 mr-2" />
                  Ready to Pay
                  <span className="text-gray-500 text-[10px] ml-1.5 normal-case">(with payer)</span>
                </span>
                <span className="font-semibold tabular-nums">
                  {totalsByStatus.readyToPay.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  <span className="text-gray-500 text-xs ml-1">SAR</span>
                </span>
              </div>
              <div className="flex items-center justify-between text-sm pt-2 mt-1 border-t border-gray-700/40">
                <span className="flex items-center text-emerald-300">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 mr-2" />
                  Paid
                  <span className="text-gray-500 text-[10px] ml-1.5 normal-case">(settled)</span>
                </span>
                <span className="font-semibold tabular-nums text-emerald-200">
                  {totalsByStatus.paid.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  <span className="text-gray-500 text-xs ml-1">SAR</span>
                </span>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="border-b border-gray-100 px-5 py-4 bg-gray-50/50">
              <h3 className="font-bold text-gray-900">Brand Breakdown</h3>
              <p className="text-xs text-gray-500">
                {visibleBrands.length} brand{visibleBrands.length !== 1 ? 's' : ''}
                <span className="text-gray-400"> · most owed first</span>
              </p>

              <div className="relative mt-3">
                <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  value={brandQuery}
                  onChange={e => setBrandQuery(e.target.value)}
                  placeholder="Search brand…"
                  aria-label="Search brands"
                  className="w-full bg-white border border-gray-200 rounded-lg pl-8 pr-3 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
                />
              </div>
            </div>
            <div className="divide-y divide-gray-100 lg:max-h-[calc(100vh-27rem)] lg:min-h-[14rem] lg:overflow-y-auto">
              {visibleBrands.length === 0 && (
                <div className="px-5 py-10 text-center text-gray-400 text-sm">
                  {brandQuery.trim() ? 'No brand matches that search' : 'No invoices yet'}
                </div>
              )}

              {visibleBrands.map(([brand, stats]) => {
                  const englishName = getBrandEnglishName(brand);

                  // All four stages, always rendered - including the zero and
                  // negative ones. A negative means the brand's return credits
                  // outweigh its invoices at that stage, which is exactly what
                  // the manager needs to see rather than have omitted.
                  const rows = [
                    { label: 'Pending',      note: 'not verified', amount: toHalalas(stats.pending),  color: 'text-yellow-700' },
                    { label: 'Verified',     note: null,         amount: toHalalas(stats.verified),   color: 'text-blue-700' },
                    { label: 'Approved',     note: null,         amount: toHalalas(stats.approved),   color: 'text-indigo-700' },
                    { label: 'Ready to Pay', note: 'with payer', amount: toHalalas(stats.readyToPay), color: 'text-amber-700' },
                    { label: 'Paid',         note: 'settled',    amount: toHalalas(stats.paid),       color: 'text-emerald-700' },
                  ];

                  return (
                    <div key={brand} className="px-5 py-4 hover:bg-gray-50/50 transition-colors">
                      {/* Brand name, with the English transliteration where we have one */}
                      <div className="flex items-baseline justify-between gap-3">
                        <h4 className="font-semibold text-gray-900 text-sm truncate" title={brand}>
                          {brand}
                        </h4>
                        {englishName && (
                          <span className="shrink-0 text-[11px] text-gray-400 font-medium truncate">
                            {englishName}
                          </span>
                        )}
                      </div>

                      <p className="text-[11px] text-gray-500 mt-0.5">
                        {stats.count} open invoice{stats.count !== 1 ? 's' : ''}
                      </p>

                      <div className="mt-2 space-y-1">
                        {rows.map(row => {
                          const isZero = row.amount === 0;
                          return (
                            <div key={row.label} className="flex items-baseline justify-between text-xs gap-2">
                              <span className={isZero ? 'text-gray-400' : `${row.color} font-medium`}>
                                {row.label}
                                {row.note && (
                                  <span className="text-gray-400 font-normal ml-1">({row.note})</span>
                                )}
                              </span>
                              <span
                                className={`tabular-nums shrink-0 ${
                                  isZero
                                    ? 'text-gray-400'
                                    : row.amount < 0
                                      ? 'text-rose-700 font-medium'
                                      : 'text-gray-700'
                                }`}
                              >
                                {formatSigned(row.amount)}
                              </span>
                            </div>
                          );
                        })}
                      </div>

                      {/* Paid is excluded from this total on purpose - that money has already left. */}
                      <div className="flex items-baseline justify-between gap-2 mt-2 pt-2 border-t border-gray-100">
                        <span className="text-xs font-semibold text-gray-900">Still owed</span>
                        <span className="shrink-0 font-bold text-gray-900 text-sm tabular-nums">
                          {formatSigned(stats.outstanding)}
                          <span className="text-gray-400 text-[11px] font-medium ml-1">SAR</span>
                        </span>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
