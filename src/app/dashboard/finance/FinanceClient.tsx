'use client';

import { useState, useMemo, useEffect } from 'react';
import { format } from 'date-fns';
import { supabase } from '@/lib/supabase';
import { notifyVendor } from '@/lib/notify';
import { Check, X, FileText, UploadCloud, CreditCard, Loader2, ArrowUpRight, Download } from 'lucide-react';

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
};

type BrandRecord = {
  brand_name: string;
  contact_name: string | null;
  whatsapp_number: string | null;
};

export default function FinanceClient({ initialInvoices, brands }: { initialInvoices: Invoice[], brands: BrandRecord[] }) {
  const [invoices, setInvoices] = useState<Invoice[]>(initialInvoices);
  const [activeTab, setActiveTab] = useState<'To Pay' | 'History'>('To Pay');
  
  const [vendorSentIds, setVendorSentIds] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('vendorSentIds');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    }
    return new Set();
  });
  const [salamNotifiedIds, setSalamNotifiedIds] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('salamNotifiedIds');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    }
    return new Set();
  });

  useEffect(() => {
    localStorage.setItem('vendorSentIds', JSON.stringify(Array.from(vendorSentIds)));
  }, [vendorSentIds]);

  useEffect(() => {
    localStorage.setItem('salamNotifiedIds', JSON.stringify(Array.from(salamNotifiedIds)));
  }, [salamNotifiedIds]);
  
  // Payment Modal
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [invoiceToPay, setInvoiceToPay] = useState<Invoice | null>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

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
  const toPayInvoices = invoices.filter(inv => inv.status === 'Approved');
  const paidInvoices = invoices.filter(inv => inv.status === 'Paid');
  const toPayCount = toPayInvoices.length;

  const totalOutstanding = useMemo(() => {
    return toPayInvoices.reduce((sum, inv) => sum + Number(inv.amount), 0);
  }, [toPayInvoices]);

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
      ...rows.map(row =>
        row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
      ),
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

  const openPayModal = (invoice: Invoice) => {
    setInvoiceToPay(invoice);
    setReceiptFile(null);
    setFileError('');
    setPayModalOpen(true);
  };

  const handleNotifyVendor = async (inv: Invoice) => {
    const brand = brands.find(b => b.brand_name === inv.brand_name);
    if (!brand || !brand.whatsapp_number) return;
    
    // Use public URL since the receipts bucket is public
    let receiptLink = '';
    if (inv.receipt_url) {
      if (inv.receipt_url.startsWith('http')) {
        // Already a full URL — use it directly
        receiptLink = inv.receipt_url;
      } else {
        // It's a path — build the public URL
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
    setVendorSentIds(prev => new Set(prev).add(inv.id));
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

Uploaded by the Accounts Team.
Kayan Sweets Team`;

    window.open(`https://wa.me/${salamNumber.replace(/\\+/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
    setSalamNotifiedIds(prev => new Set(prev).add(inv.id));
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
    if (!invoiceToPay || !receiptFile) return;

    setIsProcessing(true);
    setFileError('');

    try {
      const fileExt = receiptFile.name.split('.').pop();
      const filePath = `${invoiceToPay.id}/receipt.${fileExt}`;

      const formData = new FormData();
      formData.append('file', receiptFile);
      formData.append('filePath', filePath);
      formData.append('invoiceId', invoiceToPay.id);

      const res = await fetch('/api/receipts', {
        method: 'POST',
        body: formData,
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || 'Failed to process payment');
      }

      // Only update UI after confirmed server success
      // Trigger notification
      await notifyVendor(invoiceToPay.id);

      // UI Update — invoice is now confirmed Paid on the server
      setInvoices(current => current.map(inv => 
        inv.id === invoiceToPay.id 
          ? { ...inv, status: 'Paid', receipt_url: result.publicUrl }
          : inv
      ));

      setPayModalOpen(false);
    } catch (err) {
      console.error(err);
      setFileError(err instanceof Error ? err.message : 'Error processing payment. The invoice remains in Approved state — please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Top Banner */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex flex-col md:flex-row md:items-center justify-between">
        <div className="flex items-center text-emerald-800">
          <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center mr-4">
            <CreditCard className="w-7 h-7 text-emerald-600" />
          </div>
          <div>
            <h2 className="text-gray-500 font-medium text-sm tracking-wide uppercase">Total Approved Outstanding</h2>
            <div className="flex items-baseline space-x-2 mt-1">
              <span className="text-4xl font-extrabold text-gray-900 tracking-tight">
                {totalOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
              <span className="text-gray-500 font-semibold">SAR</span>
            </div>
          </div>
        </div>

        <div className="mt-4 md:mt-0 flex items-center gap-4">
          <div className="flex flex-col md:text-right">
            <span className="text-sm font-semibold text-gray-800">{toPayCount} Invoices in Queue</span>
            <span className="text-xs text-gray-500">Oldest outstanding prioritized (FIFO)</span>
          </div>
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
        <div className="flex border-b border-gray-200 px-4 bg-gray-50/80">
          <button
            onClick={() => setActiveTab('To Pay')}
            className={`px-6 py-4 text-sm font-semibold flex items-center border-b-2 transition-colors ${activeTab === 'To Pay' ? 'border-emerald-500 text-emerald-700 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}
          >
            Approved Invoices (To Pay)
            {toPayCount > 0 && (
              <span className="ml-2 bg-emerald-100 text-emerald-800 py-0.5 px-2.5 rounded-full text-xs">
                {toPayCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('History')}
            className={`px-6 py-4 text-sm font-semibold flex items-center border-b-2 transition-colors ${activeTab === 'History' ? 'border-gray-900 text-gray-900 bg-white' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}
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
              {(activeTab === 'To Pay' ? toPayInvoices : paidInvoices).length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-16 text-center text-gray-400">
                    <div className="flex flex-col items-center">
                      <CreditCard className="w-8 h-8 text-gray-300 mb-2" />
                      <p>No invoices available in {activeTab}.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                (activeTab === 'To Pay' ? toPayInvoices : paidInvoices).map((inv) => (
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
                      {activeTab === 'To Pay' ? (
                        <button
                          onClick={() => openPayModal(inv)}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs px-3.5 py-2 rounded shadow-sm transition-colors flex items-center justify-center m-auto"
                        >
                          <UploadCloud className="w-3.5 h-3.5 mr-1.5" />
                          Pay & Receipt
                        </button>
                      ) : (
                        <div className="flex flex-col items-center justify-center space-y-3">
                          <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-md">
                            COMPLETED
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
                              
                              const isSent = vendorSentIds.has(inv.id);
                              return (
                                <button
                                  onClick={() => handleNotifyVendor(inv)}
                                  disabled={isSent}
                                  className={`text-xs px-3 py-1.5 rounded font-medium flex items-center shadow-sm transition-colors whitespace-nowrap ${isSent ? 'bg-emerald-100 text-emerald-700 cursor-not-allowed' : 'bg-white border border-emerald-500 text-emerald-600 hover:bg-emerald-50'}`}
                                >
                                  {isSent ? 'Sent ✓' : 'Send to Vendor'}
                                </button>
                              );
                            })()}
                            
                            {(() => {
                              const isNotified = salamNotifiedIds.has(inv.id);
                              return (
                                <button
                                  onClick={() => handleNotifySalam(inv)}
                                  disabled={isNotified}
                                  className={`text-xs px-3 py-1.5 rounded font-medium flex items-center shadow-sm transition-colors whitespace-nowrap ${isNotified ? 'bg-emerald-100 text-emerald-700 cursor-not-allowed' : 'bg-emerald-600 text-white hover:bg-emerald-700'}`}
                                >
                                  {isNotified ? 'Notified ✓' : 'Notify Salam'}
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
          {(activeTab === 'To Pay' ? toPayInvoices : paidInvoices).length === 0 ? (
            <div className="px-4 py-16 text-center text-gray-400">
              <CreditCard className="w-8 h-8 text-gray-300 mb-2 mx-auto" />
              <p>No invoices available in {activeTab}.</p>
            </div>
          ) : (
            (activeTab === 'To Pay' ? toPayInvoices : paidInvoices).map((inv) => (
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
                  {activeTab === 'To Pay' ? (
                    <button
                      onClick={() => openPayModal(inv)}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm py-2.5 rounded-lg shadow-sm transition-colors flex items-center justify-center"
                    >
                      <UploadCloud className="w-4 h-4 mr-2" />
                      Pay & Upload Receipt
                    </button>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center">
                         <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-md border border-emerald-100">
                           COMPLETED
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
                          
                          const isSent = vendorSentIds.has(inv.id);
                          return (
                            <button
                              onClick={() => handleNotifyVendor(inv)}
                              disabled={isSent}
                              className={`w-full text-sm py-2.5 rounded-lg font-semibold flex items-center justify-center shadow-sm transition-colors ${isSent ? 'bg-emerald-100 text-emerald-800 cursor-not-allowed' : 'bg-white border border-emerald-500 text-emerald-700 hover:bg-emerald-50'}`}
                            >
                              {isSent ? 'Sent to Vendor ✓' : 'Send to Vendor'}
                            </button>
                          );
                        })()}
                        
                        {(() => {
                          const isNotified = salamNotifiedIds.has(inv.id);
                          return (
                            <button
                              onClick={() => handleNotifySalam(inv)}
                              disabled={isNotified}
                              className={`w-full text-sm py-2.5 rounded-lg font-semibold flex items-center justify-center shadow-sm transition-colors ${isNotified ? 'bg-emerald-100 text-emerald-800 cursor-not-allowed' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}
                            >
                              {isNotified ? 'Salam Notified ✓' : 'Notify Salam'}
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

      {/* Payment Modal */}
      {payModalOpen && invoiceToPay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="border-b border-gray-100 px-6 py-5 flex justify-between items-center bg-gray-50/50">
              <h3 className="font-bold text-gray-900 text-lg">Process Payment</h3>
              <button 
                onClick={() => !isProcessing && setPayModalOpen(false)} 
                className="text-gray-400 hover:text-gray-600 bg-white rounded-full p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <form onSubmit={confirmPayment}>
              <div className="p-6 space-y-5">
                
                <div className="bg-emerald-50 rounded-lg p-4 border border-emerald-100 flex justify-between items-center">
                  <div>
                    <p className="text-emerald-800 text-xs uppercase font-bold tracking-wider mb-1">Target</p>
                    <p className="text-emerald-900 font-semibold">{invoiceToPay.vendor_name}</p>
                    <p className="text-emerald-700 text-sm font-mono mt-0.5">#{invoiceToPay.invoice_number}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-emerald-800 text-xs uppercase font-bold tracking-wider mb-1">Settle Amount</p>
                    <p className="text-emerald-900 font-black text-xl">
                      {invoiceToPay.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                </div>

                <div className="space-y-3 pt-2">
                  <label className="text-sm font-semibold text-gray-800">Bank Transfer Receipt (Isal) <span className="text-red-500">*</span></label>
                  
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
                          <p className="text-xs text-emerald-600 mt-1">{(receiptFile.size / 1024 / 1024).toFixed(2)} MB • Ready to upload</p>
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
                  <strong>Warning:</strong> Confirming this payment will permanently upload the receipt, notify the vendor, and close this invoice loop.
                </div>
                
              </div>
              
              <div className="border-t border-gray-100 p-5 bg-gray-50/50 flex space-x-3 justify-end">
                <button
                  type="button"
                  onClick={() => setPayModalOpen(false)}
                  disabled={isProcessing}
                  className="px-5 py-2.5 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 font-medium rounded-lg text-sm transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isProcessing || !receiptFile}
                  className="flex items-center px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-lg text-sm shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading & Confirming...
                    </>
                  ) : (
                    <>
                       Confirm Payment <ArrowUpRight className="w-4 h-4 ml-1.5 opacity-80" />
                    </>
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
