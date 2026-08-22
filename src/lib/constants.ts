import type { ProfileRole } from '@/lib/auth-context';

// Request header the middleware uses to hand the already-verified user profile
// to the dashboard layout, so the layout doesn't have to re-query the database
// on every navigation. The middleware always overwrites this header, so a
// client can never spoof it.
export const USER_PROFILE_HEADER = 'x-user-profile';

// Which roles may open each dashboard section. This is the single source of
// truth for route protection: the middleware enforces it server-side, and the
// Sidebar reads it to decide which links to show. The first matching prefix
// wins, so list more specific prefixes before more general ones.
export const DASHBOARD_ROUTE_ROLES: { prefix: string; roles: ProfileRole[] }[] = [
  { prefix: '/dashboard/verify', roles: ['amin'] },
  { prefix: '/dashboard/approve', roles: ['salam'] },
  { prefix: '/dashboard/finance', roles: ['accountant', 'salam'] },
  { prefix: '/dashboard/payments', roles: ['payer', 'salam'] },
  { prefix: '/dashboard/brands', roles: ['amin', 'salam'] },
  { prefix: '/dashboard/logs', roles: ['salam'] },
];

export const BRANCHES = [
  'السلامة',
  'الحرمين',
  'سنابل',
  'أبحر',
  'الرصيفة',
  'العوالي',
  'المدينة المنورة',
  'الصالحية',
];

// Map Arabic brand names to safe English ASCII names. Used for:
//  - storage folder names on the upload bucket (Arabic chars don't survive URL encoding well)
//  - display: showing the English transliteration alongside Arabic in the payer dashboard
//    so non-Arabic readers can recognize the brand at a glance.
export const BRAND_FOLDER_MAP: Record<string, string> = {
  "شنده": "Shunda",
  "رولز": "Rols",
  "المذاق الحجاز": "Al Mazaq Al Hijazi",
  "فليك": "Fleek",
  "المذاق العربي": "Al Mazaq Al Arabi",
  "شرقي": "Sharqi",
  "بيرلين": "Berlin",
  "زماني": "Zamani",
  "البحره الدمشقية": "Al Bahra Al Dimashqiya",
  "رهش": "Rahsh",
  "فيلان": "Faylan",
  "كحيله": "Kaheela",
  "زاد شرق": "Zad Sharq",
  "لافيره": "Laviere",
  "بايت كرانشي": "Bite",
  "ميراه سويت": "Mirah Sweet",
  "باقة الاصاله": "Baqat Al Asala",
  "خليج حلا": "Khaleej Hala",
  "ارينا": "Arena",
  "دلع مذاق": "Dala Mazaq",
  "الما": "Alma",
  "سنابل رهف": "Sanabel Rahaf",
  "بوكودور": "Bouquet Dor",
  "حميده": "Humaida",
  "نخبة كيك": "Nukhbat Cake",
  "السيوف": "Al Suyouf",
  "مرابج الخليج": "Marabej Al Khaleej",
  "لوثيره": "Luthira",
  "ديكو": "Deco",
  "دولشي": "Dolce",
  "ريفي": "Reefy",
  "راما الضيافه": "Rama Al Diyafa"
};

// Convenience: returns the English brand name if mapped, else null.
export const getBrandEnglishName = (brandArabic: string): string | null =>
  BRAND_FOLDER_MAP[brandArabic] || null;

// Company bank accounts money is paid out from, identified by the last 4
// digits of the account number. We deliberately store nothing more — the last
// 4 is enough to tell the accounts apart, and full account numbers have no
// reason to live in this database.
//
// This is the single source of truth: the payments form renders the dropdown
// from it and the receipts API validates against it, the same way BRANCHES
// works. Adding an account here needs no migration.
export const BANK_ACCOUNTS = [
  { code: '4000', label: 'Account ••••4000' },
  { code: '8000', label: 'Account ••••8000' },
  { code: '9000', label: 'Account ••••9000' },
] as const;

export const BANK_ACCOUNT_CODES: readonly string[] = BANK_ACCOUNTS.map(a => a.code);

export const isBankAccount = (value: unknown): value is string =>
  typeof value === 'string' && BANK_ACCOUNT_CODES.includes(value);

// Display helper for history tables and exports. Payments made before this
// feature existed have no account on record.
export const getBankAccountLabel = (code: string | null | undefined): string => {
  if (!code) return 'Not recorded';

  const known = BANK_ACCOUNTS.find(a => a.code === code);
  if (known) return known.label;

  // Not in the current list. That is expected for an account since retired —
  // its past payments must still show where the money came from, so this can't
  // just collapse to "Not recorded" — but it equally covers a value that
  // reached the database without passing validation. Show at most the last 4
  // characters, so a full account number can never be echoed back here, and
  // mark it so it is never read as one of the live accounts.
  return `Account ••••${code.slice(-4)} (unrecognized)`;
};
