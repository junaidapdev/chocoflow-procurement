import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_RECEIPT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

// POST - Upload a receipt and mark invoice as Paid
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();

    const file = formData.get('file') as File | null;
    const filePath = formData.get('filePath') as string;
    const invoiceId = formData.get('invoiceId') as string;
    const appliedReturnIdsRaw = formData.get('appliedReturnIds') as string | null;

    let appliedReturnIds: string[] = [];
    if (appliedReturnIdsRaw) {
      try {
        const parsed = JSON.parse(appliedReturnIdsRaw);
        if (Array.isArray(parsed)) {
          appliedReturnIds = parsed.filter((x): x is string => typeof x === 'string');
        }
      } catch {
        return NextResponse.json({ error: 'appliedReturnIds must be a JSON array of strings' }, { status: 400 });
      }
    }

    if (!file || !filePath || !invoiceId) {
      return NextResponse.json({ error: 'file, filePath, and invoiceId are required' }, { status: 400 });
    }

    // --- File validation ---
    if (!ALLOWED_RECEIPT_TYPES.includes(file.type)) {
      return NextResponse.json({ error: 'Only PDF and image files (JPEG, PNG, WebP) are accepted for receipts.' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File exceeds the 5MB size limit.' }, { status: 400 });
    }

    // --- 1. Upload receipt to storage ---
    const buffer = Buffer.from(await file.arrayBuffer());
    const { error: uploadError } = await supabaseAdmin.storage
      .from('receipts')
      .upload(filePath, buffer, { upsert: true, contentType: file.type });

    if (uploadError) {
      console.error('Receipt upload error:', uploadError);
      return NextResponse.json({ error: `Receipt upload failed: ${uploadError.message}` }, { status: 500 });
    }

    // --- 2. Get public URL ---
    const { data: urlData } = supabaseAdmin.storage
      .from('receipts')
      .getPublicUrl(filePath);

    // --- 3. Update invoice status to Paid with receipt URL ---
    const { error: dbError } = await supabaseAdmin
      .from('invoices')
      .update({ 
        status: 'Paid', 
        receipt_url: urlData.publicUrl 
      })
      .eq('id', invoiceId);

    if (dbError) {
      console.error('DB update error after receipt upload:', dbError);
      // Cleanup: remove the uploaded receipt since DB update failed
      await supabaseAdmin.storage.from('receipts').remove([filePath]);
      return NextResponse.json(
        { error: `Payment could not be recorded. The receipt was not saved. Please try again. (${dbError.message})` },
        { status: 500 }
      );
    }

    // --- 4. Apply selected return credits (if any) ---
    // The filters ensure we only consume returns that are still applicable:
    // type='return', status='Approved', and not already applied to another invoice.
    if (appliedReturnIds.length > 0) {
      const { error: returnErr } = await supabaseAdmin
        .from('invoices')
        .update({ status: 'Paid', applied_to_invoice_id: invoiceId })
        .in('id', appliedReturnIds)
        .eq('type', 'return')
        .eq('status', 'Approved')
        .is('applied_to_invoice_id', null);

      if (returnErr) {
        // Invoice is already marked paid — log the issue but don't fail the request.
        // Finance team can reconcile manually if this ever happens.
        console.error('Failed to mark returns as applied:', returnErr);
      }
    }

    return NextResponse.json({ success: true, publicUrl: urlData.publicUrl });
  } catch (err) {
    console.error('Error in POST /api/receipts:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
