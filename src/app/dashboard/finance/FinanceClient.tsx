'use client';

import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { supabase } from '@/lib/supabase';
import { Check, FileText, CreditCard, Loader2, Download, ShieldCheck, Clock } from 'lucide-react';

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
  vendor_notified_at?: string | null;
  salam_notified_at?: string | null;
};

type BrandRecord = {
  brand_name: string;
  contact_name: string | null;
  whatsapp_number: string | null;
};

export default function FinanceClient({
  initialInvoices,
  brands,
}: {
  initialInvoices: Invoice[];
  brands: BrandRecord[];
}) {
  const [invoices, setInvoices] = useState<Invoice[]>(initialInvoices);
  const [activeTab, setActiveTab] = useState<'To Authorize' | 'Awaiting Payment' | 'History'>('To Authorize');
  const [authorizingId, setAuthorizingId] = useState<string | null>(null);
  const [notifyingId, setNotifyingId] = useState<string | null>(null);

  // Notification state lives on each invoice row (vendor_notified_at /
  // salam_notified_at). It's authoritative across all browsers and users —
  // no localStorage, no per-browser drift, no stale pollution.
  const markNotified = async (inv: Invoice, target: 'vendor' | 'salam') => {
    setNotifyingId(`${inv.id}:${target}`);
    try {
      const res = await fetch('/api/invoices/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: inv.id, target }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Failed to mark notification');

      const column = target === 'vendor' ? 'vendor_notified_at' : 'salam_notified_at';
      setInvoices(curr =>
        curr.map(i => (i.id === inv.id ? { ...i, [column]: result.notified_at } : i))
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to record notification.');
    } finally {
      setNotifyingId(null);
    }
  };

  const handleNotifyVendor = (inv: Invoice) => {
    const brand = brands.find(b => b.brand_name === inv.brand_name);
    if (!brand || !brand.whatsapp_number) return;

    let receiptLink = '';
    if (inv.receipt_url) {
      if (inv.receipt_url.startsWith('http')) {
        receiptLink = inv.receipt_url;
      } else {
        const { data } = supabase.storage.from('receipts').getPublicUrl(inv.receipt_url);
        receiptLink = data.publicUrl;
      }
    }

    const message = `Dear ${brand.contact_name || 'Vendor'},

We're pleased to inform you that your invoice payment
has been successfully processed.

📋 Payment Details:
- Invoice Number: ${inv.invoice_number}
- Branch: ${inv.branch_id}
- Amount: SAR ${inv.amount}

🧾 Transfer Receipt:
${receiptLink}

Thank you for doing business with us.
Kayan Sweets Team`;

    window.open(`https://wa.me/${brand.whatsapp_number.replace(/\\+/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
    markNotified(inv, 'vendor');
  };

  const handleNotifySalam = (inv: Invoice) => {
    const salamNumber = process.env.NEXT_PUBLIC_SALAM_WHATSAPP;
    if (!salamNumber) return alert('Salam WhatsApp number is not configured in .env.local (NEXT_PUBLIC_SALAM_WHATSAPP)');

    const paidDate = format(new Date(inv.updated_at || inv.created_at), 'yyyy-MM-dd HH:mm');

    const message = `✅ Payment Recorded

📋 Details:
- Invoice: ${inv.invoice_number}
- Brand: ${inv.brand_name}
- Branch: ${inv.branch_id}
- Amount: SAR ${inv.amount}
- Date: ${paidDate}

Uploaded by the Payments Team.
Kayan Sweets Team`;

    window.open(`https://wa.me/${salamNumber.replace(/\\+/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
    markNotified(inv, 'salam');
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

  const toAuthorize = invoices.filter(inv => inv.status === 'Approved');
  const awaitingPayment = invoices.filter(inv => inv.status === 'ReadyToPay');
  const paidInvoices = invoices.filter(inv => inv.status === 'Paid');

  const totalToAuthorize = useMemo(
    () => toAuthorize.reduce((sum, inv) => sum + Number(inv.amount), 0),
    [toAuthorize]
  );

  const totalAwaiting = useMemo(
    () => awaitingPayment.reduce((sum, inv) => sum + Number(inv.amount), 0),
    [awaitingPayment]
  );

  const handleAuthorize = async (inv: Invoice) => {
    if (!confirm(`Authorize SAR ${Number(inv.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })} payment to ${inv.vendor_name} (#${inv.invoice_number})?\n\nThis will release the invoice to the payments team.`)) {
      return;
    }
    setAuthorizingId(inv.id);
    try {
      const res = await fetch('/api/invoices', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: inv.id, status: 'ReadyToPay' }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Failed to authorize');
      setInvoices(current =>
        current.map(i => (i.id === inv.id ? { ...i, status: 'ReadyToPay' } : i))
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to authorize payment.');
    } finally {
      setAuthorizingId(null);
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

  const visibleRows =
    activeTab === 'To Authorize' ? toAuthorize :
    activeTab === 'Awaiting Payment' ? awaitingPayment :
    paidInvoices;

  return (
    <div className="space-y-6">

      {/* Top Banner */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center">
          <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center mr-4 shrink-0">
            <ShieldCheck className="w-6 h-6 text-emerald-600" />
          </div>
          <div>
            <h2 className="text-gray-500 font-medium text-xs tracking-wide uppercase">Awaiting Your Authorization</h2>
            <div className="flex items-baseline space-x-1.5 mt-0.5">
              <span className="text-3xl font-extrabold text-gray-900 tracking-tight">
                {totalToAuthorize.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
              <span className="text-gray-500 font-semibold text-sm">SAR</span>
            </div>
            <span className="text-xs text-gray-400">{toAuthorize.length} invoice{toAuthorize.length !== 1 ? 's' : ''} from manager</span>
          </div>
        </div>

        <div className="hidden md:block w-px h-14 bg-gray-200" />

        <div className="flex items-center">
          <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center mr-4 shrink-0">
            <Clock className="w-6 h-6 text-indigo-600" />
          </div>
          <div>
            <h2 className="text-gray-500 font-medium text-xs tracking-wide uppercase">With Payments Team</h2>
            <div className="flex items-baseline space-x-1.5 mt-0.5">
              <span className="text-3xl font-extrabold text-indigo-700 tracking-tight">
                {totalAwaiting.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
              <span className="text-indigo-400 font-semibold text-sm">SAR</span>
            </div>
            <span className="text-xs text-gray-400">{awaitingPayment.length} authorized, awaiting transfer</span>
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

      {/* Main Container */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-4 bg-gray-50/80 overflow-x-auto">
          <button
            onClick={() => setActiveTab('To Authorize')}
            className={`px-6 py-4 text-sm font-semibold flex items-center border-b-2 transition-colors whitespace-nowrap ${activeTab === 'To Authorize' ? 'border-emerald-500 text-emerald-700 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}
          >
            To Authorize
            {toAuthorize.length > 0 && (
              <span className="ml-2 bg-emerald-100 text-emerald-800 py-0.5 px-2.5 rounded-full text-xs">
                {toAuthorize.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('Awaiting Payment')}
            className={`px-6 py-4 text-sm font-semibold flex items-center border-b-2 transition-colors whitespace-nowrap ${activeTab === 'Awaiting Payment' ? 'border-indigo-500 text-indigo-700 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}
          >
            Awaiting Payment
            {awaitingPayment.length > 0 && (
              <span className="ml-2 bg-indigo-100 text-indigo-700 py-0.5 px-2.5 rounded-full text-xs">
                {awaitingPayment.length}
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

        {/* Desktop Table */}
        <div className="overflow-x-auto hidden lg:block">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-white text-gray-500 font-medium border-b border-gray-100 uppercase text-xs tracking-wider">
              <tr>
                <th className="px-6 py-4">Vendor Info</th>
                <th className="px-6 py-4">Brand/Branch</th>
                <th className="px-6 py-4">Invoice Info</th>
                <th className="px-6 py-4 text-right">Amount (SAR)</th>
                <th className="px-6 py-4 text-center">Documentation</th>
                <th className="px-6 py-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-16 text-center text-gray-400">
                    <div className="flex flex-col items-center">
                      <CreditCard className="w-8 h-8 text-gray-300 mb-2" />
                      <p>No invoices in {activeTab}.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                visibleRows.map((inv) => (
                  <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
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
                    <td className="px-6 py-4 text-right">
                      <div className="font-bold text-gray-900 border-b border-gray-100 pb-0.5 inline-block">
                        {inv.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <div className="flex justify-center space-x-3">
                        {inv.invoice_url && (
                          <button onClick={() => openSecureDocument(inv.invoice_url, 'invoices')} className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline flex items-center font-medium cursor-pointer">
                            <FileText className="w-3.5 h-3.5 mr-1" /> Inv PDF
                          </button>
                        )}
                        {inv.receipt_url && (
                          <button onClick={() => openSecureDocument(inv.receipt_url!, 'receipts')} className="text-xs text-emerald-600 hover:text-emerald-800 hover:underline flex items-center font-medium cursor-pointer">
                            <Check className="w-3.5 h-3.5 mr-1" /> Isal
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center align-middle">
                      {activeTab === 'To Authorize' ? (
                        <button
                          onClick={() => handleAuthorize(inv)}
                          disabled={authorizingId === inv.id}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs px-3.5 py-2 rounded shadow-sm transition-colors flex items-center justify-center m-auto disabled:opacity-50"
                        >
                          {authorizingId === inv.id ? (
                            <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Authorizing…</>
                          ) : (
                            <><ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> Authorize</>
                          )}
                        </button>
                      ) : activeTab === 'Awaiting Payment' ? (
                        <span className="text-xs font-semibold text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-md border border-indigo-100">
                          WITH PAYER
                        </span>
                      ) : (
                        <div className="flex flex-col items-center justify-center space-y-3">
                          <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-md">
                            PAID
                          </span>
                          <div className="flex items-center space-x-2">
                            {(() => {
                              const brand = brands.find(b => b.brand_name === inv.brand_name);
                              if (!brand?.whatsapp_number) {
                                return (
                                  <div className="text-[10px] text-amber-700 bg-amber-50 px-2 py-1 rounded max-w-[140px] text-left border border-amber-200">
                                    No WhatsApp number for this brand. Go to <a href="/dashboard/brands" className="underline font-bold text-amber-900 border-amber-300 border-b">/dashboard/brands</a> to add it.
                                  </div>
                                );
                              }
                              const isSent = !!inv.vendor_notified_at;
                              const isBusy = notifyingId === `${inv.id}:vendor`;
                              return (
                                <button
                                  onClick={() => handleNotifyVendor(inv)}
                                  disabled={isSent || isBusy}
                                  className={`text-xs px-3 py-1.5 rounded font-medium flex items-center shadow-sm transition-colors whitespace-nowrap ${isSent ? 'bg-emerald-100 text-emerald-700 cursor-not-allowed' : 'bg-white border border-emerald-500 text-emerald-600 hover:bg-emerald-50'}`}
                                >
                                  {isSent ? 'Sent ✓' : isBusy ? 'Saving…' : 'Send to Vendor'}
                                </button>
                              );
                            })()}
                            {(() => {
                              const isNotified = !!inv.salam_notified_at;
                              const isBusy = notifyingId === `${inv.id}:salam`;
                              return (
                                <button
                                  onClick={() => handleNotifySalam(inv)}
                                  disabled={isNotified || isBusy}
                                  className={`text-xs px-3 py-1.5 rounded font-medium flex items-center shadow-sm transition-colors whitespace-nowrap ${isNotified ? 'bg-emerald-100 text-emerald-700 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
                                >
                                  {isNotified ? 'Notified ✓' : isBusy ? 'Saving…' : 'Notify Salam'}
                                </button>
                              );
                            })()}
                          </div>
                        </div>
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
          {visibleRows.length === 0 ? (
            <div className="px-4 py-16 text-center text-gray-400">
              <CreditCard className="w-8 h-8 text-gray-300 mb-2 mx-auto" />
              <p>No invoices in {activeTab}.</p>
            </div>
          ) : (
            visibleRows.map((inv) => (
              <div key={inv.id} className="p-4 space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-bold text-gray-900">{inv.vendor_name}</h3>
                    <p className="text-xs text-gray-500 mt-0.5">{inv.brand_name} • {inv.branch_id}</p>
                    <p className="text-xs text-gray-500 mt-0.5 font-mono">Invoice: {inv.invoice_number}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-lg font-bold text-gray-900 whitespace-nowrap">
                      {inv.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>
                    <span className="text-xs text-gray-500 font-normal ml-1">SAR</span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {inv.invoice_url && (
                    <button onClick={() => openSecureDocument(inv.invoice_url, 'invoices')} className="text-xs text-indigo-600 font-medium bg-indigo-50 px-3 py-1.5 rounded-full flex items-center">
                      <FileText className="w-3 h-3 mr-1" /> Inv PDF
                    </button>
                  )}
                  {inv.receipt_url && (
                    <button onClick={() => openSecureDocument(inv.receipt_url!, 'receipts')} className="text-xs text-emerald-600 font-medium bg-emerald-50 px-3 py-1.5 rounded-full flex items-center">
                      <Check className="w-3 h-3 mr-1" /> Isal
                    </button>
                  )}
                </div>

                <div className="pt-2">
                  {activeTab === 'To Authorize' ? (
                    <button
                      onClick={() => handleAuthorize(inv)}
                      disabled={authorizingId === inv.id}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm py-2.5 rounded-lg shadow-sm transition-colors flex items-center justify-center disabled:opacity-50"
                    >
                      {authorizingId === inv.id ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Authorizing…</>
                      ) : (
                        <><ShieldCheck className="w-4 h-4 mr-2" /> Authorize Payment</>
                      )}
                    </button>
                  ) : activeTab === 'Awaiting Payment' ? (
                    <span className="text-xs font-semibold text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-md border border-indigo-100">
                      WITH PAYMENTS TEAM
                    </span>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center">
                        <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-md border border-emerald-100">
                          PAID
                        </span>
                      </div>
                      <div className="flex flex-col gap-2">
                        {(() => {
                          const brand = brands.find(b => b.brand_name === inv.brand_name);
                          if (!brand?.whatsapp_number) {
                            return (
                              <div className="text-xs text-amber-800 bg-amber-50 px-3 py-2 rounded-lg border border-amber-200">
                                Add WhatsApp number in <a href="/dashboard/brands" className="underline font-bold">Brands</a> to notify vendor.
                              </div>
                            );
                          }
                          const isSent = !!inv.vendor_notified_at;
                          const isBusy = notifyingId === `${inv.id}:vendor`;
                          return (
                            <button
                              onClick={() => handleNotifyVendor(inv)}
                              disabled={isSent || isBusy}
                              className={`w-full text-sm py-2.5 rounded-lg font-semibold flex items-center justify-center shadow-sm transition-colors ${isSent ? 'bg-emerald-100 text-emerald-800 cursor-not-allowed' : 'bg-white border border-emerald-500 text-emerald-700 hover:bg-emerald-50'}`}
                            >
                              {isSent ? 'Sent to Vendor ✓' : isBusy ? 'Saving…' : 'Send to Vendor'}
                            </button>
                          );
                        })()}
                        {(() => {
                          const isNotified = !!inv.salam_notified_at;
                          const isBusy = notifyingId === `${inv.id}:salam`;
                          return (
                            <button
                              onClick={() => handleNotifySalam(inv)}
                              disabled={isNotified || isBusy}
                              className={`w-full text-sm py-2.5 rounded-lg font-semibold flex items-center justify-center shadow-sm transition-colors ${isNotified ? 'bg-emerald-100 text-emerald-800 cursor-not-allowed' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}
                            >
                              {isNotified ? 'Salam Notified ✓' : isBusy ? 'Saving…' : 'Notify Salam'}
                            </button>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
