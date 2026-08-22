// Date helpers for payment recording.
//
// The business runs in Saudi Arabia but the server runs in UTC. A payer
// entering "today" at 1am Riyadh time is still on yesterday's UTC date, so
// comparing against a UTC "today" would reject a perfectly valid entry. Every
// payment-date check therefore resolves "today" in Riyadh.

import { format } from 'date-fns';

export const RIYADH_TIME_ZONE = 'Asia/Riyadh';

// Earliest date we'll accept. Catches fat-fingered years ("0225-03-14") that
// would otherwise sail through as a valid past date.
export const EARLIEST_PAYMENT_DATE = '2020-01-01';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Today in Riyadh as YYYY-MM-DD. 'en-CA' formats as ISO, which saves us
// assembling the parts by hand.
export function riyadhToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: RIYADH_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;

  // Date.parse is not enough on its own: it rolls an impossible day over into
  // the next month rather than failing, so '2025-02-31' parses happily as
  // 3 March and '2025-02-29' as 1 March. Round-tripping the parsed components
  // back to what was asked for is what actually rejects them.
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

// Validates a payer-entered payment date. Returns null when fine, or the
// message to show the user. Both the API and the payment form call this, so
// the rule can't drift between them.
export function validatePaymentDate(value: unknown): string | null {
  if (!isValidDateString(value)) {
    return 'Payment date is required (YYYY-MM-DD).';
  }

  if (value > riyadhToday()) {
    return 'Payment date cannot be in the future.';
  }

  if (value < EARLIEST_PAYMENT_DATE) {
    return `Payment date looks wrong — it must be on or after ${EARLIEST_PAYMENT_DATE}.`;
  }

  return null;
}

// Formats a stored payment_date for display.
//
// Deliberately does NOT do `new Date('2026-08-22')` — that parses as UTC
// midnight, which renders as the previous day for any viewer in a timezone
// behind UTC. Splitting the parts builds a local date instead, so the day shown
// is always the day recorded.
export function formatPaymentDate(
  value: string | null | undefined,
  pattern = 'MMM dd, yyyy'
): string {
  if (!isValidDateString(value)) return '—';
  const [year, month, day] = value.split('-').map(Number);
  return format(new Date(year, month - 1, day), pattern);
}
