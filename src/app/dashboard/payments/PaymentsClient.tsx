'use client';

import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { supabase } from '@/lib/supabase';
import {
  Check, X, FileText, UploadCloud, CreditCard, Loader2,
  ArrowUpRight, Download, Building2, ChevronDown, ChevronRight,
} from 'lucide-react';

type Invoice = {
  id: string;
  brand_name: string;
  branch_id: string;
  invoice_number: string;
  invoice_date: string;
  amount: number;
  invoice_url: string;
  receipt_url: string | null;
  status: string;
  vendor_name: string;
  vendor_email: string;
  created_at: string;
  updated_at?: string;
  type?: 'invoice' | 'return';
};

type VendorGroup = {
  key: string;           // `${vendor_name}||${brand_name}`
  vendorName: string;
  brandName: string;
  invoices: Invoice[];
  total: number;
};

export default function PaymentsClient({
  initialInvoices,
  initialReturns,
}: {
  initialInvoices: Invoice[];
  initialReturns: Invoice[];
}) {
  const [invoices, setInvoices] = useState<Invoice[]>(initialInvoices);
  const [availableReturns, setAvailableReturns] = useState<Invoice[]>(initialReturns);
  const [activeTab, setActiveTab] = useState<'To Pay' | 'Credits' | 'History'>('To Pay');

  // Selection across all vendor groups
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Payment Modal
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedReturnIds, setSelectedReturnIds] = useState<Set<string>>(new Set());

  // Derived: pending vs paid
  const toPayInvoices = useMemo(() => invoices.filter(i => i.status === 'ReadyToPay'), [invoices]);
  const paidInvoices = useMemo(() => invoices.filter(i => i.status === 'Paid'), [invoices]);

  // Group the To Pay list by vendor + brand.
  // One vendor can theoretically ship under multiple brands; we key by both
  // so credits (brand-scoped) apply cleanly.
  const vendorGroups: VendorGroup[] = useMemo(() => {
    const map = new Map<string, VendorGroup>();
    for (const inv of toPayInvoices) {
      const key = `${inv.vendor_name || 'Unknown'}||${inv.brand_name || 'Unknown'}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          vendorName: inv.vendor_name || 'Unknown',
          brandName: inv.brand_name || 'Unknown',
          invoices: [],
          total: 0,
        });
      }
      const g = map.get(key)!;
      g.invoices.push(inv);
      g.total += Number(inv.amount);
    }
    return Array.from(map.values()).sort((a, b) => a.vendorName.localeCompare(b.vendorName));
  }, [toPayInvoices]);

  // Selected invoices as concrete objects
  const selectedInvoices = useMemo(
    () => toPayInvoices.filter(i => selectedIds.has(i.id)),
    [toPayInvoices, selectedIds]
  );

  const selectedTotal = useMemo(
    () => selectedInvoices.reduce((sum, i) => sum + Number(i.amount), 0),
    [selectedInvoices]
  );

  // Single shared brand across the selection? Only then do credits apply.
  const selectionBrand: string | null = useMemo(() => {
    if (selectedInvoices.length === 0) return null;
    const first = selectedInvoices[0].brand_name;
    return selectedInvoices.every(i => i.brand_name === first) ? first : null;
  }, [selectedInvoices]);

  const applicableReturns = useMemo(() => {
    if (!selectionBrand) return [] as Invoice[];
    return availableReturns.filter(r => r.brand_name === selectionBrand);
  }, [selectionBrand, availableReturns]);

  const totalReturnCredit = useMemo(() => {
    return applicableReturns
      .filter(r => selectedReturnIds.has(r.id))
      .reduce((sum, r) => sum + Number(r.amount), 0);
  }, [applicableReturns, selectedReturnIds]);

  const netPayable = Math.max(0, selectedTotal - totalReturnCredit);
  const creditExceedsTotal = totalReturnCredit > selectedTotal;

  // Banner totals
  const totalInvoicesOutstanding = useMemo(
    () => toPayInvoices.reduce((sum, inv) => sum + Number(inv.amount), 0),
    [toPayInvoices]
  );
  const totalReturnCredits = useMemo(
    () => availableReturns.reduce((sum, r) => sum + Number(r.amount), 0),
    [availableReturns]
  );

  // ── Selection helpers ─────────────────────────────────────────
  const toggleOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (group: VendorGroup) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const allSelected = group.invoices.every(i => next.has(i.id));
      if (allSelected) {
        group.invoices.forEach(i => next.delete(i.id));
      } else {
        group.invoices.forEach(i => next.add(i.id));
      }
      return next;
    });
  };

  const toggleReturnSelection = (id: string) => {
    setSelectedReturnIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCollapsed = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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

  const exportToCsv = () => {
    if (paidInvoices.length === 0) {
      alert('No paid invoices to export.');
      return;
    }
    const headers = ['Invoice Number', 'Vendor Name', 'Brand Name', 'Branch', 'Amount (SAR)', 'Invoice Date', 'Paid Date', 'Receipt URL'];
    const rows = paidInvoices.map(inv => [
      inv.invoice_number,
      inv.vendor_name,
      inv.brand_name,
      inv.branch_id,
      inv.amount.toFixed(2),
      format(new Date(inv.invoice_date), 'yyyy-MM-dd'),
      inv.updated_at ? format(new Date(inv.updated_at), 'yyyy-MM-dd HH:mm') : '',
      inv.receipt_url || '',
    ]);
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `paid-invoices-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const openPayModal = () => {
    if (selectedIds.size === 0) return;
    setReceiptFile(null);
    setFileError('');
    setSelectedReturnIds(new Set());
    setPayModalOpen(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setFileError('File exceeds 5MB size limit.');
      setReceiptFile(null);
      return;
    }
    setFileError('');
    setReceiptFile(file);
  };

  const confirmPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedInvoices.length === 0 || !receiptFile) return;

    setIsProcessing(true);
    setFileError('');

    try {
      const fileExt = receiptFile.name.split('.').pop();
      // Batch receipts get their own folder keyed by the first invoice + timestamp.
      const filePath = `batch-${Date.now()}-${selectedInvoices[0].id}/receipt.${fileExt}`;
      const invoiceIds = selectedInvoices.map(i => i.id);
      const appliedIds = Array.from(selectedReturnIds);

      const formData = new FormData();
      formData.append('file', receiptFile);
      formData.append('filePath', filePath);
      formData.append('invoiceIds', JSON.stringify(invoiceIds));
      if (appliedIds.length > 0) {
        formData.append('appliedReturnIds', JSON.stringify(appliedIds));
      }

      const res = await fetch('/api/receipts', {
        method: 'POST',
        body: formData,
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Failed to process payment');

      // Update UI state — all batched invoices now Paid with the same receipt URL
      const paidIdSet = new Set(invoiceIds);
      setInvoices(current => current.map(inv =>
        paidIdSet.has(inv.id)
          ? { ...inv, status: 'Paid', receipt_url: result.publicUrl }
          : inv
      ));

      if (appliedIds.length > 0) {
        const consumed = new Set(appliedIds);
        setAvailableReturns(current => current.filter(r => !consumed.has(r.id)));
      }

      setSelectedIds(new Set());
      setSelectedReturnIds(new Set());
      setPayModalOpen(false);
    } catch (err) {
      console.error(err);
      setFileError(err instanceof Error ? err.message : 'Error processing payment. Invoices remain in ReadyToPay state — please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="space-y-6 pb-24">

      {/* Top Banner */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center">
          <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center mr-4 shrink-0">
            <CreditCard className="w-6 h-6 text-emerald-600" />
          </div>
          <div>
            <h2 className="text-gray-500 font-medium text-xs tracking-wide uppercase">Authorized to Pay</h2>
            <div className="flex items-baseline space-x-1.5 mt-0.5">
              <span className="text-3xl font-extrabold text-gray-900 tracking-tight">
                {totalInvoicesOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
              <span className="text-gray-500 font-semibold text-sm">SAR</span>
            </div>
            <span className="text-xs text-gray-400">
              {toPayInvoices.length} invoice{toPayInvoices.length !== 1 ? 's' : ''} across {vendorGroups.length} vendor{vendorGroups.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        <div className="hidden md:block w-px h-14 bg-gray-200" />

        <div className="flex items-center">
          <div className="w-12 h-12 bg-rose-100 rounded-full flex items-center justify-center mr-4 shrink-0">
            <ArrowUpRight className="w-6 h-6 text-rose-500 rotate-180" />
          </div>
          <div>
            <h2 className="text-gray-500 font-medium text-xs tracking-wide uppercase">Return Credits Available</h2>
            <div className="flex items-baseline space-x-1.5 mt-0.5">
              <span className="text-3xl font-extrabold text-rose-600 tracking-tight">
                {totalReturnCredits.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
              <span className="text-rose-400 font-semibold text-sm">SAR</span>
            </div>
            <span className="text-xs text-gray-400">{availableReturns.length} pending credit{availableReturns.length !== 1 ? 's' : ''}</span>
          </div>
        </div>

        <div className="md:ml-auto">
          <button
            onClick={exportToCsv}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm whitespace-nowrap"
            title="Export all paid invoices as CSV"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Main container */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-4 bg-gray-50/80 overflow-x-auto">
          <button
            onClick={() => setActiveTab('To Pay')}
            className={`px-6 py-4 text-sm font-semibold flex items-center border-b-2 transition-colors whitespace-nowrap ${activeTab === 'To Pay' ? 'border-emerald-500 text-emerald-700 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}
          >
            Authorized (To Pay)
            {toPayInvoices.length > 0 && (
              <span className="ml-2 bg-emerald-100 text-emerald-800 py-0.5 px-2.5 rounded-full text-xs">
                {toPayInvoices.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('Credits')}
            className={`px-6 py-4 text-sm font-semibold flex items-center border-b-2 transition-colors whitespace-nowrap ${activeTab === 'Credits' ? 'border-rose-500 text-rose-700 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}
          >
            Return Credits
            {availableReturns.length > 0 && (
              <span className="ml-2 bg-rose-100 text-rose-700 py-0.5 px-2.5 rounded-full text-xs">
                {availableReturns.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('History')}
            className={`px-6 py-4 text-sm font-semibold flex items-center border-b-2 transition-colors whitespace-nowrap ${activeTab === 'History' ? 'border-gray-900 text-gray-900 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}
          >
            Paid History
          </button>
        </div>

        {/* ── To Pay Tab: vendor-grouped with checkboxes ── */}
        {activeTab === 'To Pay' && (
          <div className="divide-y divide-gray-100">
            {vendorGroups.length === 0 ? (
              <div className="px-6 py-16 text-center text-gray-400">
                <CreditCard className="w-8 h-8 text-gray-300 mb-2 mx-auto" />
                <p>No invoices awaiting payment.</p>
              </div>
            ) : (
              vendorGroups.map((group) => {
                const allSelected = group.invoices.every(i => selectedIds.has(i.id));
                const someSelected = !allSelected && group.invoices.some(i => selectedIds.has(i.id));
                const collapsed = collapsedGroups.has(group.key);
                const selectedInGroupCount = group.invoices.filter(i => selectedIds.has(i.id)).length;

                return (
                  <div key={group.key}>
                    {/* Group header */}
                    <div className="flex items-center gap-3 px-4 lg:px-6 py-3 bg-gray-50 hover:bg-gray-100/70 transition-colors">
                      <button
                        onClick={() => toggleCollapsed(group.key)}
                        className="p-1 rounded hover:bg-white/70 text-gray-500"
                        title={collapsed ? 'Expand' : 'Collapse'}
                      >
                        {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={el => { if (el) el.indeterminate = someSelected; }}
                        onChange={() => toggleGroup(group)}
                        className="accent-emerald-600 w-4 h-4 cursor-pointer"
                        title={allSelected ? 'Deselect all in this vendor' : 'Select all in this vendor'}
                      />
                      <Building2 className="w-4 h-4 text-gray-400" />
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-gray-900 truncate">{group.vendorName}</div>
                        <div className="text-xs text-gray-500 truncate">{group.brandName} · {group.invoices.length} invoice{group.invoices.length !== 1 ? 's' : ''}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-bold text-gray-900">
                          Σ {group.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          <span className="text-xs text-gray-500 font-normal ml-1">SAR</span>
                        </div>
                        {selectedInGroupCount > 0 && (
                          <div className="text-[11px] text-emerald-700 font-semibold">{selectedInGroupCount} selected</div>
                        )}
                      </div>
                    </div>

                    {/* Group rows */}
                    {!collapsed && (
                      <div className="divide-y divide-gray-100">
                        {group.invoices.map((inv) => {
                          const checked = selectedIds.has(inv.id);
                          return (
                            <label
                              key={inv.id}
                              className={`flex items-center gap-3 px-4 lg:px-6 py-3 cursor-pointer transition-colors ${checked ? 'bg-emerald-50/60 hover:bg-emerald-50' : 'hover:bg-gray-50'}`}
                            >
                              <div className="w-6" />
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleOne(inv.id)}
                                className="accent-emerald-600 w-4 h-4"
                              />
                              <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-4 gap-2 md:gap-4 items-center">
                                <div className="min-w-0">
                                  <div className="font-mono text-xs text-gray-900 truncate">#{inv.invoice_number}</div>
                                  <div className="text-[11px] text-gray-500 truncate">{format(new Date(inv.invoice_date), 'MMM dd, yyyy')}</div>
                                </div>
                                <div className="text-xs text-gray-700 truncate">
                                  <span className="text-gray-400">Branch:</span> {inv.branch_id}
                                </div>
                                <div className="text-right md:text-left">
                                  <span className="text-sm font-bold text-gray-900">
                                    {Number(inv.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                  </span>
                                  <span className="text-[11px] text-gray-500 ml-1">SAR</span>
                                </div>
                                <div className="text-right">
                                  {inv.invoice_url && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.preventDefault(); openSecureDocument(inv.invoice_url, 'invoices'); }}
                                      className="text-xs text-emerald-600 hover:text-emerald-800 font-medium inline-flex items-center"
                                    >
                                      <FileText className="w-3 h-3 mr-1" /> Inv PDF
                                    </button>
                                  )}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ── Credits Tab ── */}
        {activeTab === 'Credits' && (
          <>
            <div className="px-6 py-3 bg-rose-50/60 border-b border-rose-100 text-xs text-rose-700">
              <span className="font-semibold">How credits work:</span>{' '}
              When you select invoices for payment, any approved return credits for the same brand will appear in the payment modal for you to apply.
            </div>
            <div className="overflow-x-auto hidden lg:block">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-white text-gray-500 font-medium border-b border-gray-100 uppercase text-xs tracking-wider">
                  <tr>
                    <th className="px-6 py-4">Vendor</th>
                    <th className="px-6 py-4">Brand / Branch</th>
                    <th className="px-6 py-4">Return Ref No.</th>
                    <th className="px-6 py-4">Date</th>
                    <th className="px-6 py-4 text-right">Credit (SAR)</th>
                    <th className="px-6 py-4 text-center">Return Bill</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {availableReturns.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-16 text-center text-gray-400">No return credits available.</td>
                    </tr>
                  ) : (
                    availableReturns.map((r) => (
                      <tr key={r.id} className="bg-rose-50/30 hover:bg-rose-50/60">
                        <td className="px-6 py-4 font-semibold text-gray-900">{r.vendor_name}</td>
                        <td className="px-6 py-4 text-gray-800">
                          <span className="font-medium mr-2">{r.brand_name}</span>
                          <span className="text-xs text-gray-400">({r.branch_id})</span>
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-rose-700">{r.invoice_number}</td>
                        <td className="px-6 py-4 text-gray-600">{format(new Date(r.invoice_date), 'MMM dd, yyyy')}</td>
                        <td className="px-6 py-4 text-right font-bold text-rose-700">
                          −{Number(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-6 py-4 text-center">
                          {r.invoice_url && (
                            <button
                              onClick={() => openSecureDocument(r.invoice_url, 'invoices')}
                              className="inline-flex items-center text-rose-600 font-medium text-xs bg-rose-50 px-3 py-1.5 rounded-full"
                            >
                              <FileText className="w-3.5 h-3.5 mr-1.5" /> View PDF
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ── History Tab ── */}
        {activeTab === 'History' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-white text-gray-500 font-medium border-b border-gray-100 uppercase text-xs tracking-wider">
                <tr>
                  <th className="px-6 py-4">Vendor Info</th>
                  <th className="px-6 py-4">Brand/Branch</th>
                  <th className="px-6 py-4">Invoice Info</th>
                  <th className="px-6 py-4 text-right">Amount (SAR)</th>
                  <th className="px-6 py-4 text-center">Documentation</th>
                  <th className="px-6 py-4 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {paidInvoices.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-16 text-center text-gray-400">
                      No paid invoices yet.
                    </td>
                  </tr>
                ) : (
                  paidInvoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4">
                        <div className="font-semibold text-gray-900">{inv.vendor_name}</div>
                        <div className="text-gray-500 text-xs mt-0.5">{inv.vendor_email}</div>
                      </td>
                      <td className="px-6 py-4 text-gray-800">
                        <span className="font-medium mr-2">{inv.brand_name}</span>
                        <span className="text-xs text-gray-400">({inv.branch_id})</span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="font-mono text-gray-900 text-xs">#{inv.invoice_number}</div>
                        <div className="text-gray-500 text-xs mt-0.5">{format(new Date(inv.invoice_date), 'MMM dd, yyyy')}</div>
                      </td>
                      <td className="px-6 py-4 text-right font-bold text-gray-900">
                        {inv.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex justify-center space-x-3">
                          {inv.invoice_url && (
                            <button onClick={() => openSecureDocument(inv.invoice_url, 'invoices')} className="text-xs text-emerald-600 font-medium inline-flex items-center">
                              <FileText className="w-3.5 h-3.5 mr-1" /> Inv PDF
                            </button>
                          )}
                          {inv.receipt_url && (
                            <button onClick={() => openSecureDocument(inv.receipt_url!, 'receipts')} className="text-xs text-emerald-600 font-medium inline-flex items-center">
                              <Check className="w-3.5 h-3.5 mr-1" /> Isal
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-md border border-emerald-100">
                          PAID
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Sticky selection bar — only on To Pay when something is selected */}
      {activeTab === 'To Pay' && selectedIds.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 lg:left-[240px] z-40 bg-neutral-900 text-white shadow-2xl border-t border-neutral-800">
          <div className="max-w-7xl mx-auto px-4 lg:px-8 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-4 min-w-0">
              <span className="text-sm font-semibold">
                {selectedIds.size} invoice{selectedIds.size !== 1 ? 's' : ''} selected
              </span>
              <span className="hidden sm:inline text-gray-400">·</span>
              <span className="text-lg font-black tracking-tight">
                {selectedTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                <span className="text-xs text-gray-400 font-normal ml-1">SAR</span>
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-sm text-gray-300 hover:text-white px-3 py-2"
              >
                Clear
              </button>
              <button
                onClick={openPayModal}
                className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-gray-900 font-bold text-sm px-5 py-2.5 rounded-lg shadow-lg transition-colors"
              >
                <UploadCloud className="w-4 h-4" /> Pay Selected
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {payModalOpen && selectedInvoices.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="border-b border-gray-100 px-6 py-5 flex justify-between items-center bg-gray-50/50 shrink-0">
              <h3 className="font-bold text-gray-900 text-lg">Process Batch Payment</h3>
              <button
                onClick={() => !isProcessing && setPayModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 bg-white rounded-full p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={confirmPayment} className="flex-1 overflow-y-auto">
              <div className="p-6 space-y-5">

                {/* Selected invoices summary */}
                <div className="bg-emerald-50 rounded-lg p-4 border border-emerald-100 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-emerald-800 text-xs uppercase font-bold tracking-wider">
                      Paying {selectedInvoices.length} invoice{selectedInvoices.length !== 1 ? 's' : ''}
                    </p>
                    <span className="text-[10px] font-semibold text-emerald-700 bg-white border border-emerald-200 rounded-full px-2 py-0.5">
                      {selectedInvoices[0].vendor_name}
                    </span>
                  </div>
                  <div className="max-h-40 overflow-y-auto space-y-1.5">
                    {selectedInvoices.map(inv => (
                      <div key={inv.id} className="flex justify-between items-center text-xs bg-white rounded px-3 py-2 border border-emerald-100">
                        <div className="min-w-0">
                          <span className="font-mono text-gray-900">#{inv.invoice_number}</span>
                          <span className="text-gray-500 ml-2">· {inv.branch_id}</span>
                        </div>
                        <span className="font-bold text-gray-900 shrink-0">
                          {Number(inv.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between items-baseline pt-2 border-t border-emerald-200">
                    <span className="text-emerald-800 text-xs uppercase font-bold tracking-wider">Gross Total</span>
                    <span className="text-emerald-900 font-black text-xl">
                      {selectedTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      <span className="text-xs text-emerald-700 font-semibold ml-1">SAR</span>
                    </span>
                  </div>
                </div>

                {/* Return credits — only shown when all selected share a single brand */}
                {selectionBrand && applicableReturns.length > 0 && (
                  <div className="bg-rose-50/70 rounded-lg p-4 border border-rose-100 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-rose-800 text-xs uppercase font-bold tracking-wider">Apply Return Credits</p>
                      <span className="text-[10px] font-semibold text-rose-600 bg-white border border-rose-200 rounded-full px-2 py-0.5">
                        {applicableReturns.length} available for {selectionBrand}
                      </span>
                    </div>
                    <div className="space-y-2 max-h-40 overflow-y-auto">
                      {applicableReturns.map(r => {
                        const checked = selectedReturnIds.has(r.id);
                        return (
                          <label
                            key={r.id}
                            className={`flex items-center justify-between gap-3 px-3 py-2 rounded-md cursor-pointer border transition-colors ${checked ? 'bg-white border-rose-300 shadow-sm' : 'bg-white/50 border-rose-100 hover:bg-white'}`}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleReturnSelection(r.id)}
                                className="accent-rose-600 w-4 h-4"
                              />
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-gray-900 truncate">#{r.invoice_number}</div>
                                <div className="text-[11px] text-gray-500">
                                  {format(new Date(r.invoice_date), 'MMM dd, yyyy')} · {r.vendor_name}
                                </div>
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <span className="text-sm font-bold text-rose-700">
                                −{Number(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                              </span>
                            </div>
                          </label>
                        );
                      })}
                    </div>

                    {selectedReturnIds.size > 0 && (
                      <div className="pt-3 border-t border-rose-200 space-y-1">
                        <div className="flex justify-between text-xs text-gray-600">
                          <span>Gross total</span>
                          <span className="font-mono">{selectedTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between text-xs text-rose-700">
                          <span>Returns applied</span>
                          <span className="font-mono">−{totalReturnCredit.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between items-baseline pt-1 border-t border-rose-200">
                          <span className="text-xs font-bold uppercase tracking-wider text-gray-800">Net Payable</span>
                          <span className="text-lg font-black text-gray-900">
                            {netPayable.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            <span className="text-xs text-gray-500 font-normal ml-1">SAR</span>
                          </span>
                        </div>
                        {creditExceedsTotal && (
                          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mt-2">
                            Selected credits exceed the total. Deselect some returns — remaining credit will stay available.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Show notice if selection spans multiple brands (no credits allowed) */}
                {!selectionBrand && (
                  <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
                    Selection spans multiple brands — return credits can only be applied when all selected invoices share one brand.
                  </div>
                )}

                {/* Receipt file */}
                <div className="space-y-3 pt-2">
                  <label className="text-sm font-semibold text-gray-800">
                    Bank Transfer Receipt (Isal) <span className="text-red-500">*</span>
                    <span className="block text-[11px] text-gray-500 font-normal mt-1">
                      Upload the single PDF or image for this bank transfer — it will attach to all {selectedInvoices.length} invoice{selectedInvoices.length !== 1 ? 's' : ''}.
                    </span>
                  </label>

                  <div className={`relative border-2 border-dashed rounded-xl p-6 transition-colors ${fileError ? 'border-red-300 bg-red-50' : receiptFile ? 'border-emerald-300 bg-emerald-50/50' : 'border-gray-300 hover:border-emerald-500 bg-gray-50 hover:bg-emerald-50/10'}`}>
                    <input
                      type="file"
                      required
                      accept="image/*,application/pdf"
                      onChange={handleFileChange}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                    <div className="flex flex-col items-center justify-center text-center pointer-events-none">
                      {receiptFile ? (
                        <>
                          <div className="p-2 bg-emerald-100 rounded-full mb-2 text-emerald-600">
                            <Check className="w-5 h-5" />
                          </div>
                          <p className="text-sm font-semibold text-emerald-800">{receiptFile.name}</p>
                          <p className="text-xs text-emerald-600 mt-1">{(receiptFile.size / 1024 / 1024).toFixed(2)} MB · Ready to upload</p>
                        </>
                      ) : (
                        <>
                          <UploadCloud className="w-8 h-8 text-gray-400 mb-2" />
                          <p className="text-sm font-medium text-gray-700">Select receipt PDF or image</p>
                          <p className="text-xs text-gray-500 mt-1">Max 5MB file size</p>
                        </>
                      )}
                    </div>
                  </div>

                  {fileError && <p className="text-sm text-red-500 font-medium">{fileError}</p>}
                </div>

                <div className="bg-yellow-50 text-yellow-800 p-3 rounded-lg text-xs leading-relaxed border border-yellow-200">
                  <strong>Heads up:</strong> Confirming marks all {selectedInvoices.length} invoice{selectedInvoices.length !== 1 ? 's' : ''} as Paid and attaches the same receipt to each. The accountant will notify the vendor and Salam from their dashboard.
                </div>
              </div>

              <div className="border-t border-gray-100 p-5 bg-gray-50/50 flex space-x-3 justify-end shrink-0">
                <button
                  type="button"
                  onClick={() => setPayModalOpen(false)}
                  disabled={isProcessing}
                  className="px-5 py-2.5 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 font-medium rounded-lg text-sm disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isProcessing || !receiptFile || creditExceedsTotal}
                  className="flex items-center px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg text-sm shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isProcessing ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading & Confirming…</>
                  ) : (
                    <>Confirm Payment <ArrowUpRight className="w-4 h-4 ml-1.5 opacity-80" /></>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
