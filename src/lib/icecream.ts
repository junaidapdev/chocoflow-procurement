// Shared types and helpers for the ice cream billing module.
//
// This module is deliberately self-contained: nothing here imports from or
// writes to the chocolate procurement side. The only things the two share are
// the login, the audit log and the bank account list.

// Private storage bucket for the receipts accounts send back. Separate from the
// chocolate `receipts` bucket so the two modules' files can never collide, and
// so revoking access to one leaves the other untouched.
export const ICE_RECEIPT_BUCKET = 'ice-receipts';

// Private bucket for the bill photo a store manager attaches when filing a bill
// from the public /bill link. Separate from ICE_RECEIPT_BUCKET so submitted
// evidence and proof-of-payment never share a path, and access to one can be
// revoked without touching the other.
export const ICE_BILL_BUCKET = 'ice-bills';

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
  // Who covers this branch today. Used only to label a branch with no bills —
  // a block that showed "Unassigned" for a quiet branch would read as a data
  // problem rather than as a quiet week. Bills that exist always carry their
  // own stored salesman instead, so this never rewrites history.
  current_salesman_name?: string | null;
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
  // Storage path of the photo the branch attached, or null when none was. The
  // bucket is private, so the dashboard views this through a signed URL rather
  // than treating it as a link.
  bill_photo_path: string | null;
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
 *
 * Two invariants this function has to hold, because the manager reads its
 * output and then approves a payment against it:
 *
 *  1. Every bill passed in appears somewhere. `branches` lists *active*
 *     branches, but approval batches every pending bill regardless — so a bill
 *     on a branch that was deactivated after it was filed would otherwise be
 *     invisible here while still being paid, and the screenshot sent to
 *     accounts would understate the total.
 *  2. A block is one branch AND one salesman. Bills spanning a reassignment
 *     split into two blocks, matching the source sheet's "BRANCH / SALES MAN"
 *     header, rather than filing everything under whoever happened to be first.
 */
export function buildSheet(
  city: IceCity,
  branches: IceBranch[],
  bills: IceBillRow[]
): IceSheet {
  const cityBranches = branches.filter(branch => branch.city === city);
  const known = new Map(cityBranches.map(branch => [branch.id, branch]));

  // Invariant 1: rescue bills whose branch is missing from `branches`. The row
  // carries its own branch name, so the block can still be labelled correctly.
  const orphans = new Map<string, IceBranch>();
  for (const bill of bills) {
    if (known.has(bill.branch_id) || orphans.has(bill.branch_id)) continue;
    orphans.set(bill.branch_id, {
      id: bill.branch_id,
      name_en: bill.branch_name || 'Unknown branch',
      name_ar: null,
      city,
      // Sorted last: these are branches that should not normally be receiving
      // deliveries, so they belong at the bottom where they get noticed.
      sort_order: Number.MAX_SAFE_INTEGER,
    });
  }

  const allBranches = [...cityBranches, ...Array.from(orphans.values())].sort(
    (a, b) => a.sort_order - b.sort_order || a.name_en.localeCompare(b.name_en)
  );

  // Invariant 2: group by branch *and* salesman.
  const byBranchSalesman = new Map<string, IceBillRow[]>();
  for (const bill of bills) {
    const key = `${bill.branch_id}|${bill.salesman_name || UNASSIGNED_SALESMAN}`;
    const existing = byBranchSalesman.get(key);
    if (existing) existing.push(bill);
    else byBranchSalesman.set(key, [bill]);
  }

  const blocks: IceSheetBranchBlock[] = [];

  for (const branch of allBranches) {
    const groups = Array.from(byBranchSalesman.entries())
      .filter(([key]) => key.startsWith(`${branch.id}|`))
      .sort(([a], [b]) => a.localeCompare(b));

    if (groups.length === 0) {
      // A quiet branch still gets a block, labelled with whoever covers it now.
      blocks.push({
        branchId: branch.id,
        branchName: branch.name_en,
        branchNameAr: branch.name_ar,
        salesmanName: branch.current_salesman_name || UNASSIGNED_SALESMAN,
        bills: [],
        total: 0,
      });
      continue;
    }

    for (const [key, groupBills] of groups) {
      blocks.push({
        branchId: branch.id,
        branchName: branch.name_en,
        branchNameAr: branch.name_ar,
        salesmanName: key.slice(branch.id.length + 1),
        bills: groupBills.slice().sort((a, b) => a.bill_date.localeCompare(b.bill_date)),
        total: sumAmounts(groupBills.map(b => b.amount)),
      });
    }
  }

  return { city, ...totalsFor(blocks, bills) };
}

// Derives the summary, grand total and period from a set of blocks. Split out
// so that hiding empty branches in the UI recomputes the summary from the same
// blocks, instead of leaving the two halves of the sheet disagreeing.
function totalsFor(
  blocks: IceSheetBranchBlock[],
  bills: IceBillRow[]
): Omit<IceSheet, 'city'> {
  const dates = bills.map(b => b.bill_date).sort();

  return {
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
 * Re-derives a sheet from a subset of its blocks, keeping the summary and grand
 * total consistent with what is actually shown. Used by "hide empty branches":
 * dropping a block from the table but leaving it in the side summary would put
 * a row in the screenshot that the sheet above it does not explain.
 */
export function sheetFromBlocks(sheet: IceSheet, blocks: IceSheetBranchBlock[]): IceSheet {
  return {
    city: sheet.city,
    ...totalsFor(blocks, blocks.flatMap(block => block.bills)),
  };
}

const dupeKey = (bill: { branch_id: string; bill_date: string; amount: number }) =>
  `${bill.branch_id}|${bill.bill_date}|${toHalalas(bill.amount)}`;

/**
 * Flags pending bills that look like the same bill recorded twice — same
 * branch, same day, same amount. Returns the ids to mark in the review table.
 *
 * `alreadyBatched` carries bills that are already in a batch or paid. Checking
 * against those matters more than checking pending-against-pending: the
 * dangerous case is a store manager re-filing a bill that was already settled
 * (often an urgent payment made mid-week, which the branch cannot see), because
 * the earlier copy is no longer on screen for the manager to notice. Without
 * this, that bill gets approved and paid a second time — the exact outcome the
 * batching rules exist to prevent.
 *
 * Never blocks a submission. Two genuine deliveries to one branch on one day
 * for an identical amount are uncommon but real, and only the manager can tell
 * the difference.
 */
export function findDuplicateBillIds(
  pending: IceBillRow[],
  alreadyBatched: { branch_id: string; bill_date: string; amount: number }[] = []
): Set<string> {
  const settled = new Set(alreadyBatched.map(dupeKey));

  const groups = new Map<string, string[]>();
  for (const bill of pending) {
    const key = dupeKey(bill);
    const existing = groups.get(key);
    if (existing) existing.push(bill.id);
    else groups.set(key, [bill.id]);
  }

  const flagged = new Set<string>();
  Array.from(groups.entries()).forEach(([key, ids]) => {
    // Either two pending copies of each other, or one pending copy of something
    // that has already been paid.
    if (ids.length > 1 || settled.has(key)) {
      ids.forEach((id: string) => flagged.add(id));
    }
  });

  return flagged;
}
