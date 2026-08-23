'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle, AlertTriangle, Camera, Check, CheckCircle2, Loader2, Plus,
  Receipt, Send, Trash2, X, Zap,
} from 'lucide-react';
import { BANK_ACCOUNTS, getBankAccountLabel } from '@/lib/constants';
import { formatPaymentDate, riyadhToday } from '@/lib/dates';
import { openSecureDocument } from '@/lib/storage';
import {
  ICE_CITIES, ICE_CITY_LABELS, ICE_RECEIPT_BUCKET, buildSheet, findDuplicateBillIds,
  formatAmount, type IceBatch, type IceBillRow, type IceBranch, type IceCity,
} from '@/lib/icecream';

type PaidBatch = IceBatch & {
  payment_date: string | null;
  bank_account: string | null;
  receipt_path: string | null;
};

type Props = {
  branches: IceBranch[];
  pendingBills: IceBillRow[];
  openBatches: IceBatch[];
  paidBatches: PaidBatch[];
  loadError: boolean;
};

export default function IceCreamClient({
  branches, pendingBills, openBatches, paidBatches, loadError,
}: Props) {
  const router = useRouter();

  const [city, setCity] = useState<IceCity>('makkah');
  const [hideEmpty, setHideEmpty] = useState(false);
  const [screenshotMode, setScreenshotMode] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [payingBatch, setPayingBatch] = useState<IceBatch | null>(null);

  const cityBills = useMemo(
    () => pendingBills.filter(bill => bill.city === city),
    [pendingBills, city]
  );

  const sheet = useMemo(
    () => buildSheet(city, branches, cityBills),
    [city, branches, cityBills]
  );

  const duplicateIds = useMemo(() => findDuplicateBillIds(cityBills), [cityBills]);

  const visibleBlocks = hideEmpty ? sheet.blocks.filter(b => b.bills.length > 0) : sheet.blocks;

  const cityOpenBatches = openBatches.filter(b => b.city === city);
  const cityPaidBatches = paidBatches.filter(b => b.city === city);

  const call = async (key: string, run: () => Promise<Response>) => {
    setBusy(key);
    setError(null);

    try {
      const res = await run();
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.error || 'Something went wrong.');
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const approveWeek = () =>
    call('approve', () =>
      fetch('/api/ice/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, kind: 'weekly' }),
      })
    );

  const payNow = (billId: string) =>
    call(`urgent:${billId}`, () =>
      fetch('/api/ice/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, kind: 'urgent', bill_ids: [billId] }),
      })
    );

  const markSent = (batchId: string) =>
    call(`sent:${batchId}`, () =>
      fetch('/api/ice/batches', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: batchId }),
      })
    );

  const deleteBill = (billId: string) => {
    if (!confirm('Remove this bill? It will not appear on any sheet.')) return;
    return call(`delete:${billId}`, () =>
      fetch(`/api/ice/bills?id=${billId}`, { method: 'DELETE' })
    );
  };

  // ── Screenshot mode ──────────────────────────────────────────────────────
  // Strips the sidebar, buttons and row actions so a phone screenshot captures
  // the sheet and nothing else. The manager sends this straight into the
  // accounts WhatsApp thread.
  if (screenshotMode) {
    return (
      <div className="fixed inset-0 z-50 bg-white overflow-auto">
        <button
          onClick={() => setScreenshotMode(false)}
          className="fixed top-3 right-3 z-10 p-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 print:hidden"
          aria-label="Close screenshot view"
        >
          <X className="w-5 h-5" />
        </button>
        <div className="p-6 max-w-3xl mx-auto">
          <SheetTable sheet={{ ...sheet, blocks: visibleBlocks }} compact />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-3xl font-black text-gray-900 tracking-tight">Ice Cream</h1>
        <p className="text-sm text-gray-500 mt-1">
          Bills submitted from the branch link, waiting to be sent to accounts.
        </p>
      </header>

      {loadError && (
        <Banner tone="error">
          Some data could not be loaded. Refresh the page before approving anything.
        </Banner>
      )}

      {error && <Banner tone="error">{error}</Banner>}

      {/* City tabs — the two WhatsApp groups, kept apart because they are sent
          to accounts as two separate sheets. */}
      <div className="flex items-center gap-2 mb-6">
        {ICE_CITIES.map(option => {
          const count = pendingBills.filter(b => b.city === option).length;
          return (
            <button
              key={option}
              onClick={() => setCity(option)}
              className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all ${
                city === option
                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                  : 'bg-white text-gray-500 hover:text-gray-900 ring-1 ring-gray-200'
              }`}
            >
              {ICE_CITY_LABELS[option]}
              {count > 0 && (
                <span className="ms-2 text-xs font-black tabular-nums">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Batches already approved and waiting on accounts. Shown above the live
          sheet because they are the ones with an outstanding action. */}
      {cityOpenBatches.length > 0 && (
        <section className="mb-6 space-y-3">
          {cityOpenBatches.map(batch => (
            <div
              key={batch.id}
              className="bg-white rounded-2xl border border-amber-200 p-5 flex flex-wrap items-center gap-4"
            >
              <div className="flex-1 min-w-[200px]">
                <div className="flex items-center gap-2">
                  <span className="font-black text-gray-900">{batch.reference}</span>
                  {batch.kind === 'urgent' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider bg-rose-50 text-rose-700 px-2 py-0.5 rounded-full">
                      <Zap className="w-3 h-3" /> Urgent
                    </span>
                  )}
                  <span className="text-[10px] font-black uppercase tracking-wider bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">
                    {batch.status === 'sent' ? 'Awaiting receipt' : 'Not sent yet'}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-1 tabular-nums">
                  {batch.bill_count} bill{batch.bill_count === 1 ? '' : 's'} · SR{' '}
                  {formatAmount(batch.total_amount)}
                </p>
              </div>

              {batch.status === 'approved' && (
                <button
                  onClick={() => markSent(batch.id)}
                  disabled={busy === `sent:${batch.id}`}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-900 hover:bg-gray-800 text-white text-sm font-bold disabled:opacity-60"
                >
                  {busy === `sent:${batch.id}` ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  Mark as sent
                </button>
              )}

              <button
                onClick={() => setPayingBatch(batch)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold"
              >
                <Receipt className="w-4 h-4" />
                Record payment
              </button>
            </div>
          ))}
        </section>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <button
          onClick={() => setScreenshotMode(true)}
          disabled={sheet.grandTotal === 0}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white ring-1 ring-gray-200 hover:ring-gray-300 text-gray-900 text-sm font-bold disabled:opacity-50"
        >
          <Camera className="w-4 h-4" />
          Screenshot view
        </button>

        <button
          onClick={() => setShowAddForm(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white ring-1 ring-gray-200 hover:ring-gray-300 text-gray-900 text-sm font-bold"
        >
          <Plus className="w-4 h-4" />
          Add a bill
        </button>

        <label className="inline-flex items-center gap-2 text-sm text-gray-500 font-medium cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={e => setHideEmpty(e.target.checked)}
            className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
          />
          Hide empty branches
        </label>

        <div className="flex-1" />

        <button
          onClick={approveWeek}
          disabled={cityBills.length === 0 || busy === 'approve'}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold disabled:opacity-50"
        >
          {busy === 'approve' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Check className="w-4 h-4" />
          )}
          Approve {ICE_CITY_LABELS[city]} sheet
        </button>
      </div>

      {duplicateIds.size > 0 && (
        <Banner tone="warning">
          {duplicateIds.size} bills share a branch, date and amount with another. Check
          them before approving — sometimes that is two real deliveries.
        </Banner>
      )}

      {showAddForm && (
        <AddBillForm
          branches={branches.filter(b => b.city === city)}
          onClose={() => setShowAddForm(false)}
          onSaved={() => {
            setShowAddForm(false);
            router.refresh();
          }}
        />
      )}

      <div className="bg-white rounded-2xl border border-gray-200 p-5 sm:p-7">
        {cityBills.length === 0 ? (
          <p className="text-center text-gray-400 py-12 text-sm font-medium">
            No bills waiting for {ICE_CITY_LABELS[city]}.
          </p>
        ) : (
          <SheetTable
            sheet={{ ...sheet, blocks: visibleBlocks }}
            duplicateIds={duplicateIds}
            onDelete={deleteBill}
            onPayNow={payNow}
            busy={busy}
          />
        )}
      </div>

      {/* Settled batches. Included so an urgent mid-week payment reads as
          "handled" rather than as a bill that went missing from the sheet. */}
      {cityPaidBatches.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs font-black uppercase tracking-widest text-gray-400 mb-3">
            Already paid
          </h2>
          <div className="bg-white rounded-2xl border border-gray-200 divide-y divide-gray-100">
            {cityPaidBatches.map(batch => (
              <div key={batch.id} className="px-5 py-3.5 flex flex-wrap items-center gap-3 text-sm">
                <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                <span className="font-bold text-gray-900">{batch.reference}</span>
                {batch.kind === 'urgent' && (
                  <span className="text-[10px] font-black uppercase tracking-wider bg-rose-50 text-rose-700 px-2 py-0.5 rounded-full">
                    Urgent
                  </span>
                )}
                <span className="text-gray-500 tabular-nums">
                  SR {formatAmount(batch.total_amount)}
                </span>
                <div className="flex-1" />
                <span className="text-gray-400 text-xs">
                  Paid {formatPaymentDate(batch.payment_date)} ·{' '}
                  {getBankAccountLabel(batch.bank_account)}
                </span>
                {batch.receipt_path && (
                  <button
                    onClick={() => openSecureDocument(batch.receipt_path!, ICE_RECEIPT_BUCKET)}
                    className="text-xs font-bold text-emerald-700 hover:text-emerald-800 hover:underline"
                  >
                    Receipt
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {payingBatch && (
        <RecordPaymentModal
          batch={payingBatch}
          onClose={() => setPayingBatch(null)}
          onSaved={() => {
            setPayingBatch(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

// ── The sheet ──────────────────────────────────────────────────────────────
// Deliberately mirrors the Excel this replaces: a block per branch, then the
// salesman summary. Accounts has been reading that layout for years, and
// changing it is a separate conversation from changing how it gets filled in.

function SheetTable({
  sheet, duplicateIds, onDelete, onPayNow, busy, compact,
}: {
  sheet: ReturnType<typeof buildSheet>;
  duplicateIds?: Set<string>;
  onDelete?: (id: string) => void;
  onPayNow?: (id: string) => void;
  busy?: string | null;
  compact?: boolean;
}) {
  const interactive = !compact;

  return (
    <div>
      <div className="text-center mb-6 pb-4 border-b-2 border-gray-900">
        <h2 className="text-xl font-black text-gray-900 uppercase tracking-wide">
          Kayan Co. — Binzagar Ice Cream {ICE_CITY_LABELS[sheet.city]}
        </h2>
        {sheet.periodStart && (
          <p className="text-sm text-gray-500 mt-1 tabular-nums">
            {formatPaymentDate(sheet.periodStart)} — {formatPaymentDate(sheet.periodEnd)}
          </p>
        )}
      </div>

      <div className={compact ? 'grid gap-6 sm:grid-cols-[1fr_auto]' : 'space-y-5'}>
        <div className="space-y-5">
          {sheet.blocks.map(block => (
            <div key={block.branchId} className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="bg-gray-900 text-white px-4 py-2.5 flex flex-wrap items-baseline gap-x-3">
                <span className="font-black uppercase tracking-wide text-sm">
                  {block.branchName}
                </span>
                {block.branchNameAr && (
                  <span className="text-gray-300 text-sm">{block.branchNameAr}</span>
                )}
                <div className="flex-1" />
                <span className="text-xs text-gray-300 uppercase tracking-wider">
                  {block.salesmanName}
                </span>
              </div>

              {block.bills.length === 0 ? (
                <div className="px-4 py-3 text-sm text-gray-400 italic">Nothing due</div>
              ) : (
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-100">
                    {block.bills.map(bill => {
                      const isDupe = duplicateIds?.has(bill.id);
                      return (
                        <tr key={bill.id} className={isDupe ? 'bg-amber-50' : ''}>
                          <td className="px-4 py-2.5 tabular-nums text-gray-700 whitespace-nowrap">
                            {formatPaymentDate(bill.bill_date, 'dd/MM/yyyy')}
                            {isDupe && (
                              <span
                                className="ms-2 inline-flex items-center"
                                title="Same branch, date and amount as another bill"
                              >
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums font-bold text-gray-900">
                            {formatAmount(bill.amount)}
                          </td>
                          {interactive && (
                            <td className="px-3 py-2.5 w-px whitespace-nowrap">
                              <div className="flex items-center gap-1 justify-end">
                                <button
                                  onClick={() => onPayNow?.(bill.id)}
                                  disabled={busy === `urgent:${bill.id}`}
                                  title="Pay this bill on its own, now"
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                                >
                                  {busy === `urgent:${bill.id}` ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Zap className="w-4 h-4" />
                                  )}
                                </button>
                                <button
                                  onClick={() => onDelete?.(bill.id)}
                                  disabled={busy === `delete:${bill.id}`}
                                  title="Remove this bill"
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-50 border-t-2 border-gray-300">
                      <td className="px-4 py-2.5 font-black uppercase text-xs tracking-wider text-gray-600">
                        Total
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-black text-gray-900">
                        {formatAmount(block.total)}
                      </td>
                      {interactive && <td />}
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          ))}
        </div>

        {/* Salesman summary. One row per branch assignment, not per salesman —
            a salesman covering two branches appears twice, exactly as in the
            sheet accounts already receives. */}
        <div className={compact ? 'sm:w-64' : 'pt-2'}>
          <table className="w-full text-sm border border-gray-300 rounded-xl overflow-hidden">
            <thead>
              <tr className="bg-yellow-200">
                <th className="px-3 py-2 text-left text-xs font-black uppercase tracking-wider">
                  Salesman
                </th>
                <th className="px-3 py-2 text-right text-xs font-black uppercase tracking-wider">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sheet.summary.map((row, i) => (
                <tr key={`${row.branchName}-${i}`}>
                  <td className="px-3 py-2">
                    <div className="font-semibold text-gray-900">{row.salesmanName}</div>
                    <div className="text-[11px] text-gray-400 uppercase tracking-wide">
                      {row.branchName}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-bold text-gray-900">
                    {row.total > 0 ? formatAmount(row.total) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-orange-200 border-t-2 border-gray-400">
                <td className="px-3 py-2.5 font-black uppercase text-xs tracking-wider">Total</td>
                <td className="px-3 py-2.5 text-right tabular-nums font-black text-base">
                  {formatAmount(sheet.grandTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Adding a bill the manager found only in WhatsApp ────────────────────────

function AddBillForm({
  branches, onClose, onSaved,
}: {
  branches: IceBranch[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [branchId, setBranchId] = useState('');
  const [billDate, setBillDate] = useState(riyadhToday());
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const res = await fetch('/api/ice/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch_id: branchId, bill_date: billDate, amount }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not add the bill.');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the bill.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={save}
      className="bg-white rounded-2xl border border-gray-200 p-5 mb-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
    >
      {error && (
        <div className="sm:col-span-4">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-xs font-bold text-gray-600 uppercase tracking-wider">Branch</label>
        <select
          value={branchId}
          onChange={e => setBranchId(e.target.value)}
          required
          className="w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50/50 text-sm outline-none focus:border-yellow-400"
        >
          <option value="">Select...</option>
          {branches.map(b => (
            <option key={b.id} value={b.id}>{b.name_en}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-bold text-gray-600 uppercase tracking-wider">Date</label>
        <input
          type="date"
          value={billDate}
          max={riyadhToday()}
          onChange={e => setBillDate(e.target.value)}
          required
          className="w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50/50 text-sm outline-none focus:border-yellow-400"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-bold text-gray-600 uppercase tracking-wider">Amount</label>
        <input
          type="number"
          step="0.01"
          min="0.01"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          required
          placeholder="0.00"
          className="w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50/50 text-sm outline-none focus:border-yellow-400"
        />
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2.5 rounded-xl bg-gray-900 hover:bg-gray-800 text-white text-sm font-bold disabled:opacity-60"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2.5 rounded-xl text-gray-400 hover:text-gray-600 hover:bg-gray-100"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </form>
  );
}

// ── Recording what accounts paid ────────────────────────────────────────────

function RecordPaymentModal({
  batch, onClose, onSaved,
}: {
  batch: IceBatch;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [paymentDate, setPaymentDate] = useState(riyadhToday());
  const [bankAccount, setBankAccount] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!receipt) {
      setError('Attach the receipt accounts sent back.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const form = new FormData();
      form.append('batch_id', batch.id);
      form.append('payment_date', paymentDate);
      form.append('bank_account', bankAccount);
      form.append('receipt', receipt);

      const res = await fetch('/api/ice/payments', { method: 'POST', body: form });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not record the payment.');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the payment.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <form onSubmit={save} className="w-full max-w-md bg-white rounded-2xl p-6 space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-black text-gray-900">Record payment</h3>
            <p className="text-sm text-gray-500 mt-0.5 tabular-nums">
              {batch.reference} · SR {formatAmount(batch.total_amount)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && <Banner tone="error">{error}</Banner>}

        <div className="space-y-1.5">
          <label className="text-xs font-bold text-gray-600 uppercase tracking-wider">
            Date accounts paid
          </label>
          <input
            type="date"
            value={paymentDate}
            max={riyadhToday()}
            onChange={e => setPaymentDate(e.target.value)}
            required
            className="w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50/50 text-sm outline-none focus:border-yellow-400"
          />
          <p className="text-xs text-gray-400">
            The date on the receipt, not today — accounts often pay a day or two later.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-bold text-gray-600 uppercase tracking-wider">
            Paid from
          </label>
          <select
            value={bankAccount}
            onChange={e => setBankAccount(e.target.value)}
            required
            className="w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50/50 text-sm outline-none focus:border-yellow-400"
          >
            <option value="">Select account...</option>
            {BANK_ACCOUNTS.map(account => (
              <option key={account.code} value={account.code}>{account.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-bold text-gray-600 uppercase tracking-wider">
            Receipt
          </label>
          <input
            type="file"
            accept="image/*,application/pdf"
            onChange={e => setReceipt(e.target.files?.[0] ?? null)}
            required
            className="w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-bold file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
          />
        </div>

        <button
          type="submit"
          disabled={saving}
          className="w-full py-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Record payment'}
        </button>
      </form>
    </div>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'warning'; children: React.ReactNode }) {
  const styles =
    tone === 'error'
      ? 'bg-red-50 border-red-500 text-red-700'
      : 'bg-amber-50 border-amber-500 text-amber-800';
  const Icon = tone === 'error' ? AlertCircle : AlertTriangle;

  return (
    <div className={`p-4 mb-4 border-l-4 rounded-md flex items-start gap-3 ${styles}`}>
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
      <p className="text-sm">{children}</p>
    </div>
  );
}
