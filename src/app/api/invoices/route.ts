import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_INVOICE_TYPES = ['application/pdf'];

// POST - Create a new invoice (file upload + DB insert)
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    
    const file = formData.get('file') as File | null;
    const filePath = formData.get('filePath') as string;
    const brand_name = formData.get('brand_name') as string;
    const branch_id = formData.get('branch_id') as string;
    const invoice_number = formData.get('invoice_number') as string;
    const invoice_date = formData.get('invoice_date') as string;
    const amountRaw = formData.get('amount') as string;
    const vendor_name = formData.get('vendor_name') as string;
    const vendor_email = formData.get('vendor_email') as string;
    const typeRaw = (formData.get('type') as string) || 'invoice';
    const type = typeRaw === 'return' ? 'return' : 'invoice';

    // --- Validation ---
    if (!file || !filePath) {
      return NextResponse.json({ error: 'File and filePath are required' }, { status: 400 });
    }

    if (!ALLOWED_INVOICE_TYPES.includes(file.type)) {
      return NextResponse.json({ error: 'Only PDF files are accepted.' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File exceeds the 5MB size limit.' }, { status: 400 });
    }

    const amount = Number(amountRaw);
    if (isNaN(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Amount must be a positive number greater than zero.' }, { status: 400 });
    }

    // --- Duplicate check (scoped by type, so an invoice and a return
    // with the same number don't collide) ---
    const { data: existingInvoice } = await supabaseAdmin
      .from('invoices')
      .select('id')
      .eq('invoice_number', invoice_number)
      .eq('brand_name', brand_name)
      .eq('type', type)
      .limit(1)
      .maybeSingle();

    if (existingInvoice) {
      const label = type === 'return' ? 'return bill number' : 'invoice number';
      return NextResponse.json(
        { error: `This ${label} already exists for this brand. Please check and resubmit.` },
        { status: 409 }
      );
    }

    // --- 1. Upload file to storage ---
    const buffer = Buffer.from(await file.arrayBuffer());
    const { error: uploadError } = await supabaseAdmin.storage
      .from('invoices')
      .upload(filePath, buffer, { 
        upsert: true,
        contentType: file.type 
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return NextResponse.json({ error: `Upload Failed: ${uploadError.message}` }, { status: 500 });
    }

    // --- 2. Insert into DB ---
    const { error: dbError } = await supabaseAdmin.from('invoices').insert({
      brand_name,
      branch_id,
      invoice_number,
      invoice_date,
      amount,
      invoice_url: filePath,
      vendor_name,
      vendor_email,
      status: 'Pending',
      type,
    });

    if (dbError) {
      console.error('DB insert error:', dbError);
      // Cleanup: remove the uploaded file since DB insert failed
      await supabaseAdmin.storage.from('invoices').remove([filePath]);
      return NextResponse.json({ error: `Database Error: ${dbError.message}` }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error in POST /api/invoices:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PUT - Update invoice status
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, status, rejection_comment, receipt_url } = body;

    if (!id || !status) {
      return NextResponse.json({ error: 'ID and status are required' }, { status: 400 });
    }

    const validStatuses = ['Verified', 'Rejected', 'Approved', 'Paid'];
    if (!validStatuses.includes(status)) {
      return NextResponse.json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 });
    }

    const updateData: Record<string, string> = { status };
    if (rejection_comment) updateData.rejection_comment = rejection_comment;
    if (receipt_url) updateData.receipt_url = receipt_url;

    const { error } = await supabaseAdmin
      .from('invoices')
      .update(updateData)
      .eq('id', id);

    if (error) {
      console.error('Error updating invoice:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error in PUT /api/invoices:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
