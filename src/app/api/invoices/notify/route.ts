import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// POST /api/invoices/notify
//
// Marks an invoice as having been notified — either to the vendor (WhatsApp
// "your payment is done" message) or to Salam (internal team notification).
// State lives on the invoice row itself so it's authoritative across all
// browsers and users, not local to whoever clicked first.
//
// Body: { id: string, target: 'vendor' | 'salam' }
export async function POST(request: NextRequest) {
  try {
    const { id, target } = await request.json();

    if (!id || !target) {
      return NextResponse.json({ error: 'id and target are required' }, { status: 400 });
    }

    if (target !== 'vendor' && target !== 'salam') {
      return NextResponse.json({ error: "target must be 'vendor' or 'salam'" }, { status: 400 });
    }

    const column = target === 'vendor' ? 'vendor_notified_at' : 'salam_notified_at';
    const now = new Date().toISOString();

    const { error } = await supabaseAdmin
      .from('invoices')
      .update({ [column]: now })
      .eq('id', id);

    if (error) {
      console.error('Failed to mark notification:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, notified_at: now });
  } catch (err) {
    console.error('Error in POST /api/invoices/notify:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
