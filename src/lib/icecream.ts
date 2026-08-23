// Shared types and helpers for the ice cream billing module.
//
// This module is deliberately self-contained: nothing here imports from or
// writes to the chocolate procurement side. The only things the two share are
// the login, the audit log and the bank account list.

// Private storage bucket for the receipts accounts send back. Separate from the
// chocolate `receipts` bucket so the two modules' files can never collide, and
// so revoking access to one leaves the other untouched.
export const ICE_RECEIPT_BUCKET = 'ice-receipts';

export const ICE_CITIES = ['makkah', 'jeddah'] as const;
export type IceCity = (typeof ICE_CITIES)[number];

export const ICE_CITY_LABELS: Record<IceCity, string> = {
  makkah: 'Makkah',
  jeddah: 'Jeddah',
};

export const isIceCity = (value: unknown): value is IceCity =>
  typeof value === 'string' && (ICE_CITIES as readonly string[]).includes(value);

/**
 * Reads an embedded `ice_members(active)` select into a plain boolean.
 *
 * PostgREST returns an object for a to-one embed and an array for a to-many
 * one. ice_members.profile_id is the primary key, so it is to-one today —
 * normalising both shapes here means the middleware, the dashboard layout and
 * the login redirect cannot drift apart if that ever changes.
 */
export function hasActiveIceMembership(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(entry => !!(entry as { active?: boolean } | null)?.active);
  }
  return !!(value as { active?: boolean } | null)?.active;
}

export type IceBranch = {
  id: string;
  name_en: string;
  name_ar: string | null;
  city: IceCity;
  sort_order: number;
};

export type IceBill = {
  id: string;
  branch_id: string;
  salesman_id: string | null;
  bill_date: string;
  amount: number;
  status: 'pending' | 'batched' | 'paid' | 'void';
  batch_id: string | null;
  source: 'link' | 'manual';
  submitted_by_name: string | null;
  note: string | null;
  created_at: string;
};

export type IceBatch = {
  id: string;
  city: IceCity;
  kind: 'weekly' | 'urgent';
  status: 'approved' | 'sent' | 'paid';
  reference: string;
  period_start: string | null;
  period_end: string | null;
  total_amount: number;
  bill_count: number;
  approved_at: string;
  sent_at: string | null;
};

// Rows the sheet is built from — a bill with its branch and salesman resolved.
export type IceBillRow = IceBill & {
  branch_name: string;
  branch_sort: number;
  city: IceCity;
  salesman_name: string;
};

// Shown when a branch has bills but no salesman is currently assigned to it.
// Better than an empty cell, which reads as a rendering bug rather than a
// missing assignment the manager needs to fix.
export const UNASSIGNED_SALESMAN = 'Unassigned';

// ── Money ──────────────────────────────────────────────────────────────────
// Amounts are numeric(12,2) in Postgres but arrive as JS numbers. Every total
// is summed in integer halalas and converted back once, so a sheet of 40 bills
// cannot drift a halala from repeated float addition — the branch totals and
// the salesman summary have to reconcile exactly, since that cross-check is the
// main thing the manager eyeballs before sending.

export const toHalalas = (amount: number): number => Math.round(amount * 100);

export const sumAmounts = (amounts: number[]): number =>
  amounts.reduce((total, amount) => total + toHalalas(amount), 0) / 100;

export const formatAmount = (amount: number): string =>
  amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Sheet shape ────────────────────────────────────────────────────────────
// Mirrors the Excel the manager sends today: a block per branch listing its
// bills and a branch total, then a summary down the side. The summary has one
// row per *branch assignment*, not per salesman — a salesman covering two
// branches appears twice, exactly as in the source sheet, so the person in
// accounts reading it recognises the layout.

export type IceSheetBranchBlock = {
  branchId: string;
  branchName: string;
  branchNameAr: string | null;
  salesmanName: string;
  bills: IceBillRow[];
  total: number;
};

export type IceSheetSummaryRow = {
  salesmanName: string;
  branchName: string;
  total: number;
};

export type IceSheet = {
  city: IceCity;
  blocks: IceSheetBranchBlock[];
  summary: IceSheetSummaryRow[];
  grandTotal: number;
  periodStart: string | null;
  periodEnd: string | null;
};

/**
 * Builds one city's sheet from its bills.
 *
 * `branches` carries every active branch for the city, including ones with no
 * bills this round. Those render as a zero block on purpose: a branch that is
 * simply absent is indistinguishable from one that was forgotten, and the
 * source sheets have always shown "TOTAL 0" for a quiet branch.
 */
export function buildSheet(
  city: IceCity,
  branches: IceBranch[],
  bills: IceBillRow[]
): IceSheet {
  const byBranch = new Map<string, IceBillRow[]>();
  for (const bill of bills) {
    const existing = byBranch.get(bill.branch_id);
    if (existing) existing.push(bill);
    else byBranch.set(bill.branch_id, [bill]);
  }

  const blocks: IceSheetBranchBlock[] = branches
    .filter(branch => branch.city === city)
    .sort((a, b) => a.sort_order - b.sort_order || a.name_en.localeCompare(b.name_en))
    .map(branch => {
      const branchBills = (byBranch.get(branch.id) || []).sort((a, b) =>
        a.bill_date.localeCompare(b.bill_date)
      );

      return {
        branchId: branch.id,
        branchName: branch.name_en,
        branchNameAr: branch.name_ar,
        // Every bill in a branch carries the same salesman, resolved when it was
        // submitted. Reading it off the first bill rather than the branch's
        // current assignment is what keeps an old sheet showing who actually
        // covered it at the time.
        salesmanName: branchBills[0]?.salesman_name || UNASSIGNED_SALESMAN,
        bills: branchBills,
        total: sumAmounts(branchBills.map(b => b.amount)),
      };
    });

  const dates = bills.map(b => b.bill_date).sort();

  return {
    city,
    blocks,
    summary: blocks.map(block => ({
      salesmanName: block.salesmanName,
      branchName: block.branchName,
      total: block.total,
    })),
    grandTotal: sumAmounts(blocks.map(block => block.total)),
    periodStart: dates[0] || null,
    periodEnd: dates[dates.length - 1] || null,
  };
}

/**
 * Flags bills that look like the same bill entered twice — same branch, same
 * day, same amount. Returns the set of ids involved so the review table can
 * mark every member of a duplicate group.
 *
 * Never blocks a submission. Two genuine deliveries to one branch on one day
 * for an identical amount are uncommon but real, and only the manager can tell
 * the difference.
 */
export function findDuplicateBillIds(bills: IceBillRow[]): Set<string> {
  const groups = new Map<string, string[]>();

  for (const bill of bills) {
    const key = `${bill.branch_id}|${bill.bill_date}|${toHalalas(bill.amount)}`;
    const existing = groups.get(key);
    if (existing) existing.push(bill.id);
    else groups.set(key, [bill.id]);
  }

  const flagged = new Set<string>();
  Array.from(groups.values()).forEach(ids => {
    if (ids.length > 1) ids.forEach((id: string) => flagged.add(id));
  });

  return flagged;
}
