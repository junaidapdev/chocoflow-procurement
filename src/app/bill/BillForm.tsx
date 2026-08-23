'use client';

import { useState, useEffect } from 'react';
import { CheckCircle2, Loader2, AlertCircle, IceCream } from 'lucide-react';
import { ICE_CITY_LABELS, formatAmount, type IceBranch, type IceCity } from '@/lib/icecream';
import { riyadhToday, formatPaymentDate } from '@/lib/dates';

// Remembered on the device so a returning manager sees a form that is already
// filled in except for the two fields that change. First visit asks four
// things; every visit after that is date and amount.
const BRANCH_KEY = 'kayan_ice_branch';
const NAME_KEY = 'kayan_ice_name';

type Props = { branches: IceBranch[]; loadError: boolean };

type Submitted = { branch_name: string; bill_date: string; amount: number };

export default function BillForm({ branches, loadError }: Props) {
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const isAr = lang === 'ar';

  const t = {
    portal: isAr ? 'فواتير الآيس كريم' : 'ICE CREAM BILLS',
    title: isAr ? 'تسجيل فاتورة' : 'Record a Bill',
    desc: isAr
      ? 'سجّل الفاتورة بعد استلام الطلب. ثلاث خانات فقط.'
      : 'Record the bill after the delivery arrives. Three fields, that is all.',
    name: isAr ? 'اسمك' : 'Your name',
    nameHint: isAr ? 'يُطلب مرة واحدة فقط' : 'Asked once, then remembered',
    namePlaceholder: isAr ? 'مثال: أحمد' : 'e.g. Ahmed',
    branch: isAr ? 'الفرع' : 'Branch',
    branchPlaceholder: isAr ? 'اختر الفرع...' : 'Select branch...',
    date: isAr ? 'تاريخ الفاتورة' : 'Bill date',
    amount: isAr ? 'مبلغ الفاتورة' : 'Bill amount',
    amountPrefix: isAr ? 'ر.س' : 'SR',
    submit: isAr ? 'إرسال' : 'Submit bill',
    sending: isAr ? 'جاري الإرسال...' : 'Sending...',
    successTitle: isAr ? 'تم تسجيل الفاتورة' : 'Bill recorded',
    another: isAr ? 'تسجيل فاتورة أخرى' : 'Record another',
    unavailable: isAr
      ? 'تعذّر تحميل الفروع. يرجى تحديث الصفحة.'
      : 'Could not load branches. Please refresh the page.',
    required: isAr ? 'يرجى تعبئة جميع الخانات.' : 'Please fill in every field.',
  };

  const [branchId, setBranchId] = useState('');
  const [name, setName] = useState('');
  const [billDate, setBillDate] = useState('');
  const [amount, setAmount] = useState('');

  // Held in state for the same reason `billDate` is: this page is
  // force-dynamic, so the component renders on the server too. Calling
  // riyadhToday() straight in the JSX would evaluate it once there and again
  // during hydration, and a date rollover between the two renders is a
  // hydration mismatch on the `max` attribute.
  const [maxDate, setMaxDate] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);

  // Restore the remembered branch and name, and default the date to today.
  // Deliberately in an effect rather than in useState: localStorage and the
  // Riyadh date are both unavailable during the server render, and reading them
  // there would produce a hydration mismatch.
  useEffect(() => {
    try {
      const savedBranch = localStorage.getItem(BRANCH_KEY);
      const savedName = localStorage.getItem(NAME_KEY);
      if (savedBranch) setBranchId(savedBranch);
      if (savedName) setName(savedName);
    } catch {
      // Private browsing or blocked storage — the form still works, it just
      // asks for the branch again next time.
    }
    const today = riyadhToday();
    setBillDate(today);
    setMaxDate(today);
  }, []);

  const grouped = (['makkah', 'jeddah'] as IceCity[])
    .map(city => ({ city, items: branches.filter(b => b.city === city) }))
    .filter(group => group.items.length > 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!branchId || !billDate || !amount) {
      setError(t.required);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/ice/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branch_id: branchId,
          bill_date: billDate,
          amount,
          submitted_by_name: name.trim() || null,
        }),
      });

      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not save the bill.');

      try {
        localStorage.setItem(BRANCH_KEY, branchId);
        if (name.trim()) localStorage.setItem(NAME_KEY, name.trim());
      } catch {
        // Not being able to remember the branch is not worth failing over —
        // the bill is already saved.
      }

      setSubmitted(result.bill);
      setAmount('');
      // Safe to read directly here: this runs from a click handler, long after
      // hydration, so there is no server render to disagree with.
      setBillDate(riyadhToday());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass =
    'w-full px-4 py-3.5 rounded-xl border border-gray-200 text-gray-900 bg-gray-50/50 focus:bg-white focus:border-yellow-400 focus:ring-2 focus:ring-yellow-100 transition-colors outline-none text-base';

  if (submitted) {
    return (
      <div
        className="flex flex-col items-center justify-center py-12 px-8 space-y-6 text-center"
        dir={isAr ? 'rtl' : 'ltr'}
      >
        <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center">
          <CheckCircle2 className="w-10 h-10 text-green-600" />
        </div>
        <div className="space-y-3">
          <h3 className="text-2xl font-bold text-gray-900">{t.successTitle}</h3>
          <div className="inline-flex flex-col gap-1 bg-gray-50 border border-gray-200 rounded-xl px-6 py-4" dir="ltr">
            <span className="text-base font-bold text-gray-900">{submitted.branch_name}</span>
            <span className="text-sm text-gray-500">{formatPaymentDate(submitted.bill_date)}</span>
            <span className="text-xl font-black text-gray-900 tabular-nums">
              SR {formatAmount(submitted.amount)}
            </span>
          </div>
        </div>
        <button
          onClick={() => setSubmitted(null)}
          className="mt-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl transition-colors active:scale-[0.98]"
        >
          {t.another}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full">
      <div
        className="w-full bg-white border-b border-gray-100 py-4 px-6 flex justify-between items-center"
        dir={isAr ? 'rtl' : 'ltr'}
      >
        <p className="text-gray-500 text-sm font-bold tracking-widest uppercase flex items-center gap-2">
          <IceCream className="w-4 h-4" />
          {t.portal}
        </p>
        <button
          type="button"
          onClick={() => setLang(isAr ? 'en' : 'ar')}
          className="text-xs font-bold bg-gray-50 hover:bg-gray-100 text-gray-700 px-3 py-1.5 rounded-lg transition-colors border border-gray-200 outline-none"
        >
          {isAr ? 'EN' : 'عربي'}
        </button>
      </div>

      <div className="p-8" dir={isAr ? 'rtl' : 'ltr'}>
        <div className="mb-8 text-center">
          <h2 className="text-2xl font-bold text-gray-900">{t.title}</h2>
          <p className="text-gray-500 text-sm mt-2 leading-relaxed">{t.desc}</p>
        </div>

        {loadError ? (
          <div className="p-4 bg-red-50 border-l-4 border-red-500 rounded-md flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{t.unavailable}</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div className="p-4 bg-red-50 border-l-4 border-red-500 rounded-md flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="bill-name" className="text-sm font-semibold text-gray-700 flex items-baseline gap-2">
                {t.name}
                <span className="text-xs font-normal text-gray-400">{t.nameHint}</span>
              </label>
              <input
                id="bill-name"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={80}
                className={inputClass}
                placeholder={t.namePlaceholder}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="bill-branch" className="text-sm font-semibold text-gray-700 block">{t.branch}</label>
              <select
                id="bill-branch"
                value={branchId}
                onChange={e => setBranchId(e.target.value)}
                required
                className={inputClass}
              >
                <option value="">{t.branchPlaceholder}</option>
                {grouped.map(group => (
                  <optgroup key={group.city} label={ICE_CITY_LABELS[group.city]}>
                    {group.items.map(branch => (
                      <option key={branch.id} value={branch.id}>
                        {isAr && branch.name_ar ? branch.name_ar : branch.name_en}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="bill-date" className="text-sm font-semibold text-gray-700 block">{t.date}</label>
              <input
                id="bill-date"
                type="date"
                value={billDate}
                max={maxDate || undefined}
                onChange={e => setBillDate(e.target.value)}
                required
                className={inputClass}
                dir="ltr"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="bill-amount" className="text-sm font-semibold text-gray-700 block">{t.amount}</label>
              <div className="relative">
                <span className="absolute start-4 top-4 text-gray-400 font-medium text-sm">
                  {t.amountPrefix}
                </span>
                <input
                  id="bill-amount"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  required
                  className={`${inputClass} ps-16`}
                  placeholder="0.00"
                  dir="ltr"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full mt-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-4 px-6 rounded-xl transition-all disabled:opacity-70 disabled:cursor-not-allowed active:scale-[0.98] flex justify-center items-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {t.sending}
                </>
              ) : (
                t.submit
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
