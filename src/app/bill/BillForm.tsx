'use client';

import { useState, useEffect, useRef } from 'react';
import { CheckCircle2, Loader2, AlertCircle, IceCream, Camera, X } from 'lucide-react';
import { ICE_CITY_LABELS, formatAmount, type IceBranch, type IceCity } from '@/lib/icecream';
import { riyadhToday, formatPaymentDate } from '@/lib/dates';

// Remembered on the device so a returning manager sees a form that is already
// filled in except for the two fields that change. First visit asks four
// things; every visit after that is date and amount.
const BRANCH_KEY = 'kayan_ice_branch';
const NAME_KEY = 'kayan_ice_name';

type Props = { branches: IceBranch[]; loadError: boolean };

type Submitted = { branch_name: string; bill_date: string; amount: number };

// English-only. The Arabic side of this form (and its language toggle) was
// removed on request; the internal dashboard and the chocolate side are
// unaffected.
const t = {
  portal: 'ICE CREAM BILLS',
  title: 'Record a Bill',
  desc: 'Record the bill after the delivery arrives. Three fields, that is all.',
  name: 'Your name',
  nameHint: 'Asked once, then remembered',
  namePlaceholder: 'e.g. Ahmed',
  branch: 'Branch',
  branchPlaceholder: 'Select branch...',
  date: 'Bill date',
  amount: 'Bill amount',
  amountPrefix: 'SR',
  photo: 'Bill photo',
  photoHint: 'Optional',
  photoCapture: 'Take a photo of the bill',
  photoChange: 'Retake or choose another',
  photoTooLarge: 'That photo is over 10MB. Please take a smaller one.',
  photoWrongType: 'That file must be a photo.',
  submit: 'Submit bill',
  sending: 'Sending...',
  successTitle: 'Bill recorded',
  another: 'Record another',
  unavailable: 'Could not load branches. Please refresh the page.',
  required: 'Please fill in every field.',
};

// Mirrors what the API accepts, so an oversized or wrong-typed file is caught on
// the phone before a slow upload rather than after it. This public form is for
// photographing a paper bill, so it is images only — the office's dashboard form
// is where a PDF the API also accepts would come from.
const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
const ACCEPTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

export default function BillForm({ branches, loadError }: Props) {
  const [branchId, setBranchId] = useState('');
  const [name, setName] = useState('');
  const [billDate, setBillDate] = useState('');
  const [amount, setAmount] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  // An object URL for the chosen photo, so the manager can confirm they caught
  // the whole bill before sending. Revoked whenever it is replaced or cleared.
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Free the preview's object URL when it is replaced or the form unmounts.
  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  const clearPhoto = () => {
    setPhoto(null);
    setPhotoPreview(null); // the effect above revokes the previous URL
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;

    if (file.size > MAX_PHOTO_SIZE) {
      setError(t.photoTooLarge);
      clearPhoto();
      return;
    }

    // Must be a named, supported image type. An empty type is rejected here too
    // — the server rejects it, so accepting it on the phone would only surface
    // as a failed submission after a slow upload rather than an instant, clear
    // message while the camera is still open.
    if (!ACCEPTED_PHOTO_TYPES.includes(file.type)) {
      setError(t.photoWrongType);
      clearPhoto();
      return;
    }

    setError(null);
    setPhoto(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

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
      // Multipart rather than JSON so the optional photo rides along. The photo
      // is only appended when there is one — a bill with no photo is a normal
      // case, not a missing field.
      const form = new FormData();
      form.append('branch_id', branchId);
      form.append('bill_date', billDate);
      form.append('amount', amount);
      if (name.trim()) form.append('submitted_by_name', name.trim());
      if (photo) form.append('bill_photo', photo);

      const res = await fetch('/api/ice/bills', { method: 'POST', body: form });

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
      clearPhoto();
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
      <div className="flex flex-col items-center justify-center py-12 px-8 space-y-6 text-center">
        <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center">
          <CheckCircle2 className="w-10 h-10 text-green-600" />
        </div>
        <div className="space-y-3">
          <h3 className="text-2xl font-bold text-gray-900">{t.successTitle}</h3>
          <div className="inline-flex flex-col gap-1 bg-gray-50 border border-gray-200 rounded-xl px-6 py-4">
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
      <div className="w-full bg-white border-b border-gray-100 py-4 px-6 flex justify-between items-center">
        <p className="text-gray-500 text-sm font-bold tracking-widest uppercase flex items-center gap-2">
          <IceCream className="w-4 h-4" />
          {t.portal}
        </p>
      </div>

      <div className="p-8">
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
                        {branch.name_en}
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

            <div className="space-y-2">
              <label htmlFor="bill-photo" className="text-sm font-semibold text-gray-700 flex items-baseline gap-2">
                {t.photo}
                <span className="text-xs font-normal text-gray-400">{t.photoHint}</span>
              </label>

              {/* accept="image/*" with capture opens the camera straight away on
                  a phone, which is what a store manager standing over the paper
                  bill wants; the menu still lets them pick an existing photo. */}
              <input
                ref={fileInputRef}
                id="bill-photo"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePhoto}
                className="sr-only"
              />

              {photo ? (
                <div className="flex items-center gap-3 p-3 rounded-xl border border-gray-200 bg-gray-50/50">
                  {photoPreview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={photoPreview} alt="" className="w-14 h-14 rounded-lg object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-gray-200 flex items-center justify-center flex-shrink-0">
                      <Camera className="w-6 h-6 text-gray-400" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">{photo.name || 'Bill photo'}</p>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="text-xs font-semibold text-emerald-700 hover:text-emerald-800"
                    >
                      {t.photoChange}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={clearPhoto}
                    aria-label="Remove photo"
                    className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-200 flex-shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl border-2 border-dashed border-gray-300 text-gray-600 hover:border-emerald-500 hover:text-emerald-700 hover:bg-emerald-50/30 transition-colors font-semibold text-sm"
                >
                  <Camera className="w-5 h-5" />
                  {t.photoCapture}
                </button>
              )}
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
