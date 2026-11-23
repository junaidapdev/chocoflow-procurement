// Filtering and sorting for the payer's Payments page.
//
// One set of filters drives every tab (Pending Authorization, Authorized,
// Return Credits, Paid History), so the rules live here as pure functions
// rather than being repeated per tab inside the component.

import { riyadhDateOf } from '@/lib/dates';

// The fields the filters and sorts read. Every row on the Payments page —
// invoice or return credit — carries these.
export type FilterableInvoice = {
  vendor_name: string;
  brand_name: string;
  branch_id: string;
  invoice_number: string;
  invoice_date: string;          // DATE, 'YYYY-MM-DD'
  created_at: string;            // TIMESTAMPTZ — when it was entered
  payment_date?: string | null;  // DATE, set once paid
  amount: number;
  status: string;
};

export type DateField = 'created_at' | 'invoice_date' | 'payment_date';

export const DATE_FIELD_LABELS: Record<DateField, string> = {
  created_at: 'Entry Date',
  invoice_date: 'Invoice Date',
  payment_date: 'Paid Date',
};

export type SortField =
  | 'created_at'
  | 'invoice_date'
  | 'payment_date'
  | 'invoice_number'
  | 'amount'
  | 'status';

export const SORT_FIELD_LABELS: Record<SortField, string> = {
  created_at: 'Entry Date',
  invoice_date: 'Invoice Date',
  payment_date: 'Paid Date',
  invoice_number: 'Invoice Number',
  amount: 'Amount',
  status: 'Payment Status',
};

export type SortDirection = 'asc' | 'desc';

export type InvoiceFilters = {
  vendor: string;      // '' = any
  brand: string;
  branch: string;
  dateField: DateField;
  dateFrom: string;    // 'YYYY-MM-DD' or ''
  dateTo: string;
  sortField: SortField;
  sortDirection: SortDirection;
};

// Oldest invoice first, by the date on the vendor's paper — the order the
// server has always returned, so the page opens looking the way it did.
export const DEFAULT_FILTERS: InvoiceFilters = {
  vendor: '',
  brand: '',
  branch: '',
  dateField: 'invoice_date',
  dateFrom: '',
  dateTo: '',
  sortField: 'invoice_date',
  sortDirection: 'asc',
};

// True when anything that narrows the rows is set. Sort order is not a
// filter: changing it hides nothing, so it doesn't light up "Clear filters".
export function hasActiveFilters(f: InvoiceFilters): boolean {
  return !!(f.vendor || f.brand || f.branch || f.dateFrom || f.dateTo);
}

export function isDefaultView(f: InvoiceFilters): boolean {
  return (
    !hasActiveFilters(f) &&
    f.sortField === DEFAULT_FILTERS.sortField &&
    f.sortDirection === DEFAULT_FILTERS.sortDirection
  );
}

// The calendar day a row falls on for the chosen date field, as 'YYYY-MM-DD',
// or '' when the row has none (an unpaid invoice has no paid date).
export function dateValue(inv: FilterableInvoice, field: DateField): string {
  if (field === 'created_at') return riyadhDateOf(inv.created_at);
  if (field === 'payment_date') return inv.payment_date || '';
  return inv.invoice_date || '';
}

export function matchesFilters(inv: FilterableInvoice, f: InvoiceFilters): boolean {
  if (f.vendor && inv.vendor_name !== f.vendor) return false;
  if (f.brand && inv.brand_name !== f.brand) return false;
  if (f.branch && inv.branch_id !== f.branch) return false;

  if (f.dateFrom || f.dateTo) {
    const day = dateValue(inv, f.dateField);
    // A row with no value for the chosen date can't be inside any range.
    if (!day) return false;
    // 'YYYY-MM-DD' strings compare correctly as plain strings, and comparing
    // whole days keeps both ends of the range inclusive.
    if (f.dateFrom && day < f.dateFrom) return false;
    if (f.dateTo && day > f.dateTo) return false;
  }

  return true;
}

// Where each status sits in the payment pipeline, so "Payment Status" sorts
// in the order an invoice moves through it rather than alphabetically.
const STATUS_RANK: Record<string, number> = {
  Approved: 0,     // awaiting the accountant's authorization
  ReadyToPay: 1,   // authorized, awaiting transfer
  Paid: 2,
};

function statusRank(status: string): number {
  return STATUS_RANK[status] ?? 99;
}

const invoiceNumberCollator = new Intl.Collator(undefined, {
  numeric: true,          // INV-9 before INV-10
  sensitivity: 'base',
});

function compareBy(a: FilterableInvoice, b: FilterableInvoice, field: SortField): number {
  switch (field) {
    case 'amount':
      return Number(a.amount) - Number(b.amount);
    case 'invoice_number':
      return invoiceNumberCollator.compare(a.invoice_number || '', b.invoice_number || '');
    case 'status':
      return statusRank(a.status) - statusRank(b.status);
    case 'created_at':
      // Full timestamp, not just the day, so same-day entries keep their order.
      return (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0);
    case 'invoice_date':
    case 'payment_date':
      return (a[field] || '').localeCompare(b[field] || '');
  }
}

export function sortInvoices<T extends FilterableInvoice>(rows: T[], f: InvoiceFilters): T[] {
  const dir = f.sortDirection === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    // Rows with no paid date always go last, whichever way the sort runs —
    // otherwise "newest paid first" would open on a block of unpaid rows.
    if (f.sortField === 'payment_date') {
      const aMissing = !a.payment_date;
      const bMissing = !b.payment_date;
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
    }

    const primary = compareBy(a, b, f.sortField) * dir;
    if (primary !== 0) return primary;

    // Stable, predictable tie-breaks: invoice date, then entry time.
    return (
      compareBy(a, b, 'invoice_date') ||
      compareBy(a, b, 'created_at')
    );
  });
}

export function applyFilters<T extends FilterableInvoice>(rows: T[], f: InvoiceFilters): T[] {
  return sortInvoices(rows.filter(r => matchesFilters(r, f)), f);
}

// Distinct, non-empty values of a field across rows, sorted for a dropdown.
export function distinctValues<T extends FilterableInvoice>(
  rows: T[],
  key: 'vendor_name' | 'brand_name' | 'branch_id'
): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const v = r[key];
    if (v) seen.add(v);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}
