'use client';

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CheckCircle2, UploadCloud, Loader2, AlertCircle, FileText } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { BRANCHES } from '@/lib/constants';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ACCEPTED_FILE_TYPES = ['application/pdf'];
const FORM_STORAGE_KEY = 'chocoflow_vendor_form_draft';

const schema = z.object({
  vendorName: z.string().min(2, 'Vendor name is required'),
  vendorEmail: z.string().email('Valid email is required'),
  brandName: z.string().min(1, 'Brand is required'),
  branch: z.string().min(1, 'Branch is required'),
  invoiceNumber: z.string().min(1, 'Invoice number is required'),
  invoiceDate: z.string().min(1, 'Invoice date is required'),
  amount: z.string()
    .min(1, 'Amount is required')
    .refine((val) => !isNaN(Number(val)), 'Amount must be a valid number')
    .refine((val) => Number(val) > 0, 'Amount must be greater than zero'),
  invoicePdf: z
    .custom<FileList>()
    .refine((files) => files?.length === 1, 'PDF is required')
    .refine((files) => files?.[0]?.size <= MAX_FILE_SIZE, 'Max file size is 5MB')
    .refine(
      (files) => ACCEPTED_FILE_TYPES.includes(files?.[0]?.type),
      'Only PDF files are accepted'
    ),
});

type FormData = z.infer<typeof schema>;

// Fields we persist to localStorage (everything except file)
const PERSISTABLE_FIELDS = ['vendorName', 'vendorEmail', 'brandName', 'branch', 'invoiceNumber', 'invoiceDate', 'amount'] as const;
type PersistableField = typeof PERSISTABLE_FIELDS[number];

export default function ClientForm() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  
  const [brands, setBrands] = useState<{ id: string, brand_name: string }[]>([]);
  const [isLoadingBrands, setIsLoadingBrands] = useState(true);

  // Load saved draft from localStorage
  const getSavedDraft = (): Partial<Record<PersistableField, string>> => {
    if (typeof window === 'undefined') return {};
    try {
      const saved = localStorage.getItem(FORM_STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  };

  useEffect(() => {
    async function fetchBrands() {
      try {
        const { data, error } = await supabase
          .from('brands')
          .select('id, brand_name')
          .order('brand_name', { ascending: true });
          
        if (!error && data) {
          setBrands(data);
        }
      } catch (err) {
        console.error('Failed to load brands:', err);
      } finally {
        setIsLoadingBrands(false);
      }
    }
    fetchBrands();
  }, []);
  
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: getSavedDraft(),
  });

  // Persist form data to localStorage on every change
  const watchedFields = watch(PERSISTABLE_FIELDS as unknown as PersistableField[]);
  
  const saveToLocalStorage = useCallback(() => {
    try {
      const draft: Record<string, string> = {};
      PERSISTABLE_FIELDS.forEach((field, i) => {
        const value = watchedFields[i];
        if (value) draft[field] = value;
      });
      if (Object.keys(draft).length > 0) {
        localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(draft));
      }
    } catch {
      // localStorage may be unavailable
    }
  }, [watchedFields]);

  useEffect(() => {
    saveToLocalStorage();
  }, [saveToLocalStorage]);

  const clearDraft = () => {
    try { localStorage.removeItem(FORM_STORAGE_KEY); } catch { /* ignore */ }
  };

  const invoicePdf = watch('invoicePdf');
  const selectedFile = invoicePdf && invoicePdf.length > 0 ? invoicePdf[0] : null;

  const onSubmit = async (data: FormData) => {
    setIsSubmitting(true);
    setSubmitError(null);
    
    try {
      const file = data.invoicePdf[0];
      const fileExt = file.name.split('.').pop();
      const filePath = `${data.brandName}/${data.invoiceNumber}.${fileExt}`;
      
      const formData = new FormData();
      formData.append('file', file);
      formData.append('filePath', filePath);
      formData.append('brand_name', data.brandName);
      formData.append('branch_id', data.branch);
      formData.append('invoice_number', data.invoiceNumber);
      formData.append('invoice_date', data.invoiceDate);
      formData.append('amount', data.amount);
      formData.append('vendor_name', data.vendorName);
      formData.append('vendor_email', data.vendorEmail);

      const res = await fetch('/api/invoices', {
        method: 'POST',
        body: formData,
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || 'Upload failed');
      }
      
      clearDraft();
      setIsSuccess(true);
    } catch (error) {
      console.error('Submission error:', error);
      setSubmitError(error instanceof Error ? error.message : 'An unexpected error occurred. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="flex flex-col items-center justify-center py-10 space-y-6 text-center animate-in fade-in zoom-in duration-500">
        <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center">
          <CheckCircle2 className="w-10 h-10 text-green-600" />
        </div>
        <div className="space-y-2">
          <h3 className="text-2xl font-bold text-gray-900" dir="rtl">تم استلام فاتورتك</h3>
          <p className="text-lg text-gray-600">Your invoice has been received.</p>
        </div>
        <button 
          onClick={() => {
            setIsSuccess(false);
            window.location.reload();
          }}
          className="mt-6 px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-xl transition-colors"
        >
          Submit Another / تقديم أخرى
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {submitError && (
        <div className="p-4 bg-red-50 border-l-4 border-red-500 rounded-md flex items-start space-x-3">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{submitError}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Vendor Name */}
        <div className="space-y-2">
          <label className="text-sm font-semibold text-gray-700">Vendor Name</label>
          <input 
            {...register('vendorName')}
            className={`w-full px-4 py-3 rounded-xl border text-gray-900 bg-gray-50/50 focus:bg-white transition-colors focus:outline-none focus:ring-2 ${errors.vendorName ? 'border-red-500 focus:ring-red-200' : 'border-gray-200 focus:border-yellow-400 focus:ring-yellow-100'}`}
            placeholder="e.g. Acme Corp"
          />
          {errors.vendorName && <p className="text-xs text-red-500 mt-1">{errors.vendorName.message}</p>}
        </div>

        {/* Vendor Email */}
        <div className="space-y-2">
          <label className="text-sm font-semibold text-gray-700">Vendor Email</label>
          <input 
            type="email"
            {...register('vendorEmail')}
            className={`w-full px-4 py-3 rounded-xl border text-gray-900 bg-gray-50/50 focus:bg-white transition-colors focus:outline-none focus:ring-2 ${errors.vendorEmail ? 'border-red-500 focus:ring-red-200' : 'border-gray-200 focus:border-yellow-400 focus:ring-yellow-100'}`}
            placeholder="vendor@company.com"
          />
          {errors.vendorEmail && <p className="text-xs text-red-500 mt-1">{errors.vendorEmail.message}</p>}
        </div>

        {/* Brand */}
        <div className="space-y-2">
          <label className="text-sm font-semibold text-gray-700">Brand Name</label>
          <select 
            {...register('brandName')}
            className={`w-full px-4 py-3 rounded-xl border text-gray-900 bg-gray-50/50 focus:bg-white transition-colors focus:outline-none focus:ring-2 ${errors.brandName ? 'border-red-500 focus:ring-red-200' : 'border-gray-200 focus:border-yellow-400 focus:ring-yellow-100'}`}
          >
            <option value="">{isLoadingBrands ? 'Loading brands...' : 'Select a brand...'}</option>
            {brands.map(brand => (
              <option key={brand.id} value={brand.brand_name}>{brand.brand_name}</option>
            ))}
          </select>
          {errors.brandName && <p className="text-xs text-red-500 mt-1">{errors.brandName.message}</p>}
        </div>

        {/* Branch */}
        <div className="space-y-2">
          <label className="text-sm font-semibold text-gray-700">Branch</label>
          <select 
            {...register('branch')}
            className={`w-full px-4 py-3 rounded-xl border text-gray-900 bg-gray-50/50 focus:bg-white transition-colors focus:outline-none focus:ring-2 ${errors.branch ? 'border-red-500 focus:ring-red-200' : 'border-gray-200 focus:border-yellow-400 focus:ring-yellow-100'}`}
          >
            <option value="">Select a branch...</option>
            {BRANCHES.map(branch => (
              <option key={branch} value={branch}>{branch}</option>
            ))}
          </select>
          {errors.branch && <p className="text-xs text-red-500 mt-1">{errors.branch.message}</p>}
        </div>

        {/* Invoice Number */}
        <div className="space-y-2">
          <label className="text-sm font-semibold text-gray-700">Invoice Number</label>
          <input 
            {...register('invoiceNumber')}
            className={`w-full px-4 py-3 rounded-xl border text-gray-900 bg-gray-50/50 focus:bg-white transition-colors focus:outline-none focus:ring-2 ${errors.invoiceNumber ? 'border-red-500 focus:ring-red-200' : 'border-gray-200 focus:border-yellow-400 focus:ring-yellow-100'}`}
            placeholder="INV-2024-001"
          />
          {errors.invoiceNumber && <p className="text-xs text-red-500 mt-1">{errors.invoiceNumber.message}</p>}
        </div>

        {/* Invoice Date */}
        <div className="space-y-2">
          <label className="text-sm font-semibold text-gray-700">Invoice Date</label>
          <input 
            type="date"
            {...register('invoiceDate')}
            className={`w-full px-4 py-3 rounded-xl border text-gray-900 bg-gray-50/50 focus:bg-white transition-colors focus:outline-none focus:ring-2 ${errors.invoiceDate ? 'border-red-500 focus:ring-red-200' : 'border-gray-200 focus:border-yellow-400 focus:ring-yellow-100'}`}
          />
          {errors.invoiceDate && <p className="text-xs text-red-500 mt-1">{errors.invoiceDate.message}</p>}
        </div>

        {/* Amount */}
        <div className="space-y-2">
          <label className="text-sm font-semibold text-gray-700">Invoice Amount (SAR)</label>
          <div className="relative">
            <span className="absolute left-4 top-3.5 text-gray-400 font-medium text-sm">SR</span>
            <input 
              type="number"
              step="0.01"
              min="0.01"
              {...register('amount')}
              className={`w-full pl-12 pr-4 py-3 rounded-xl border text-gray-900 bg-gray-50/50 focus:bg-white transition-colors focus:outline-none focus:ring-2 ${errors.amount ? 'border-red-500 focus:ring-red-200' : 'border-gray-200 focus:border-yellow-400 focus:ring-yellow-100'}`}
              placeholder="0.00"
            />
          </div>
          {errors.amount && <p className="text-xs text-red-500 mt-1">{errors.amount.message}</p>}
        </div>
      </div>

      {/* PDF Upload */}
      <div className="space-y-2 pt-2">
        <label className="text-sm font-semibold text-gray-700">Invoice PDF</label>
        <div className={`relative border-2 border-dashed rounded-2xl p-8 transition-colors ${errors.invoicePdf ? 'border-red-300 bg-red-50' : selectedFile ? 'border-yellow-400 bg-yellow-50/30' : 'border-gray-200 hover:border-yellow-400 bg-gray-50/50 hover:bg-yellow-50/30'}`}>
          <input 
            type="file"
            accept="application/pdf"
            {...register('invoicePdf')}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />
          <div className="flex flex-col items-center justify-center text-center space-y-3 pointer-events-none">
            {selectedFile ? (
              <>
                <div className="p-3 rounded-full bg-white border border-yellow-200 text-yellow-600 shadow-sm">
                  <FileText className="w-6 h-6" />
                </div>
                <div className="px-4">
                  <p className="text-sm font-semibold text-gray-900 truncate max-w-[200px] sm:max-w-xs mx-auto">{selectedFile.name}</p>
                  <p className="text-xs text-yellow-600 mt-1 font-medium select-none">Ready to submit • {Math.round(selectedFile.size / 1024)} KB</p>
                </div>
              </>
            ) : (
              <>
                <div className={`p-3 rounded-full ${errors.invoicePdf ? 'bg-red-100 text-red-500' : 'bg-white border border-gray-100 shadow-sm text-gray-500'}`}>
                  <UploadCloud className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">Click to upload or drag and drop</p>
                  <p className="text-xs text-gray-500 mt-1">PDF file only (max 5MB)</p>
                </div>
              </>
            )}
          </div>
        </div>
        {errors.invoicePdf && (
          <p className="text-xs text-red-500 mt-1 flex items-center">
            {errors.invoicePdf.message as string}
          </p>
        )}
      </div>

      <div className="pt-6">
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full relative overflow-hidden bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-4 px-6 rounded-xl transition-all disabled:opacity-70 disabled:cursor-not-allowed shadow-none active:scale-[0.98]"
        >
          {isSubmitting ? (
            <span className="flex items-center justify-center">
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />
              Uploading...
            </span>
          ) : (
            'Submit Invoice'
          )}
        </button>
      </div>
    </form>
  );
}
