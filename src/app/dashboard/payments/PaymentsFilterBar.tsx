'use client';

import { ArrowDownNarrowWide, ArrowUpNarrowWide, FilterX, SlidersHorizontal } from 'lucide-react';
import { getBrandEnglishName } from '@/lib/constants';
import {
  DATE_FIELD_LABELS,
  DEFAULT_FILTERS,
  SORT_FIELD_LABELS,
  hasActiveFilters,
  isDefaultView,
  type DateField,
  type InvoiceFilters,
  type SortField,
} from '@/lib/invoice-filters';

const fieldClass =
  'w-full px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-900 bg-white focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 outline-none transition-colors';
const labelClass = 'block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1';

export default function PaymentsFilterBar({
  filters,
  onChange,
  vendors,
  brands,
  branches,
  shownCount,
  totalCount,
  noun,
}: {
  filters: InvoiceFilters;
  onChange: (next: InvoiceFilters) => void;
  vendors: string[];
  brands: string[];
  branches: string[];
  shownCount: number;
  totalCount: number;
  noun: string;
}) {
  const set = <K extends keyof InvoiceFilters>(key: K, value: InvoiceFilters[K]) =>
    onChange({ ...filters, [key]: value });

  const filtering = hasActiveFilters(filters);
  const rangeInverted = !!(filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo);

  return (
    <div className="px-4 lg:px-6 py-4 border-b border-gray-200 bg-white space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label htmlFor="filter-vendor" className={labelClass}>Vendor</label>
          <select
            id="filter-vendor"
            value={filters.vendor}
            onChange={e => set('vendor', e.target.value)}
            className={fieldClass}
          >
            <option value="">All vendors</option>
            {vendors.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="filter-brand" className={labelClass}>Brand</label>
          <select
            id="filter-brand"
            value={filters.brand}
            onChange={e => set('brand', e.target.value)}
            className={fieldClass}
          >
            <option value="">All brands</option>
            {brands.map(b => {
              const english = getBrandEnglishName(b);
              return <option key={b} value={b}>{english ? `${b} (${english})` : b}</option>;
            })}
          </select>
        </div>
        <div>
          <label htmlFor="filter-branch" className={labelClass}>Branch</label>
          <select
            id="filter-branch"
            value={filters.branch}
            onChange={e => set('branch', e.target.value)}
            className={fieldClass}
          >
            <option value="">All branches</option>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 items-end">
        <div className="lg:col-span-2">
          <label htmlFor="filter-date-field" className={labelClass}>Date range on</label>
          <select
            id="filter-date-field"
            value={filters.dateField}
            onChange={e => set('dateField', e.target.value as DateField)}
            className={fieldClass}
          >
            {(Object.keys(DATE_FIELD_LABELS) as DateField[]).map(f => (
              <option key={f} value={f}>{DATE_FIELD_LABELS[f]}</option>
            ))}
          </select>
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="filter-date-from" className={labelClass}>From</label>
          <input
            id="filter-date-from"
            type="date"
            value={filters.dateFrom}
            max={filters.dateTo || undefined}
            onChange={e => set('dateFrom', e.target.value)}
            className={fieldClass}
          />
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="filter-date-to" className={labelClass}>To</label>
          <input
            id="filter-date-to"
            type="date"
            value={filters.dateTo}
            min={filters.dateFrom || undefined}
            onChange={e => set('dateTo', e.target.value)}
            className={fieldClass}
          />
        </div>
        <div className="lg:col-span-3">
          <label htmlFor="filter-sort" className={labelClass}>Sort by</label>
          <div className="flex gap-2">
            <select
              id="filter-sort"
              value={filters.sortField}
              onChange={e => set('sortField', e.target.value as SortField)}
              className={fieldClass}
            >
              {(Object.keys(SORT_FIELD_LABELS) as SortField[]).map(f => (
                <option key={f} value={f}>{SORT_FIELD_LABELS[f]}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => set('sortDirection', filters.sortDirection === 'asc' ? 'desc' : 'asc')}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors"
              title={filters.sortDirection === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
            >
              {filters.sortDirection === 'asc'
                ? <><ArrowUpNarrowWide className="w-4 h-4" /> Asc</>
                : <><ArrowDownNarrowWide className="w-4 h-4" /> Desc</>}
            </button>
          </div>
        </div>
        <div className="sm:col-span-2 lg:col-span-3 flex items-center justify-between lg:justify-end gap-3">
          <span className="text-xs text-gray-500 inline-flex items-center gap-1.5">
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {filtering
              ? <>Showing <strong className="text-gray-900">{shownCount}</strong> of {totalCount} {noun}</>
              : <>{totalCount} {noun}</>}
          </span>
          <button
            type="button"
            onClick={() => onChange(DEFAULT_FILTERS)}
            disabled={isDefaultView(filters)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold text-rose-600 hover:bg-rose-50 disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
          >
            <FilterX className="w-4 h-4" /> Clear filters
          </button>
        </div>
      </div>

      {rangeInverted && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          The &ldquo;From&rdquo; date is after the &ldquo;To&rdquo; date, so nothing can match. Swap them to see results.
        </p>
      )}
      {filtering && filters.dateField === 'payment_date' && (filters.dateFrom || filters.dateTo) && (
        <p className="text-xs text-gray-500">
          Filtering on Paid Date leaves only paid invoices — pending, authorized and unused credits have no paid date yet.
        </p>
      )}
    </div>
  );
}
