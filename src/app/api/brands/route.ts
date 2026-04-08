import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

// Use service role key to bypass RLS
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// POST - Add a new brand
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { brand_name, contact_name, whatsapp_number } = body;

    if (!brand_name || !brand_name.trim()) {
      return NextResponse.json({ error: 'Brand name is required' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('brands')
      .insert({
        brand_name: brand_name.trim(),
        contact_name: contact_name?.trim() || null,
        whatsapp_number: whatsapp_number?.trim() || null,
      })
      .select()
      .single();

    if (error) {
      console.error('Error adding brand:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error('Error in POST /api/brands:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PUT - Update a brand
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, brand_name, contact_name, whatsapp_number } = body;

    if (!id) {
      return NextResponse.json({ error: 'Brand ID is required' }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from('brands')
      .update({
        brand_name,
        contact_name,
        whatsapp_number,
      })
      .eq('id', id);

    if (error) {
      console.error('Error updating brand:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error in PUT /api/brands:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE - Delete a brand
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Brand ID is required' }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from('brands')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting brand:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error in DELETE /api/brands:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
