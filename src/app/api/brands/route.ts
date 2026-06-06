import { NextRequest, NextResponse } from 'next/server';
import { logAuditEvent } from '@/lib/audit-log';
import { requireRoles } from '@/lib/auth-context';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BrandRecord = {
  id: string;
  brand_name: string;
  contact_name: string | null;
  whatsapp_number: string | null;
};

function safeBrandId(id: unknown) {
  return typeof id === 'string' && UUID_PATTERN.test(id) ? id : null;
}

function trimToNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function brandSnapshot(brand: BrandRecord) {
  return {
    brand_name: brand.brand_name,
    contact_name: brand.contact_name,
    whatsapp_number: brand.whatsapp_number,
  };
}

function buildBrandMetadata(input: {
  id?: unknown;
  brandName?: unknown;
  contactName?: unknown;
  whatsappNumber?: unknown;
  reason?: string;
}) {
  return {
    brand_id: typeof input.id === 'string' ? input.id : null,
    brand_name: typeof input.brandName === 'string' ? input.brandName : null,
    contact_name: typeof input.contactName === 'string' ? input.contactName : null,
    whatsapp_number: typeof input.whatsappNumber === 'string' ? input.whatsappNumber : null,
    reason: input.reason || null,
  };
}

// POST - Add a new brand
export async function POST(request: NextRequest) {
  try {
    const auth = await requireRoles(request, ['amin', 'salam']);

    if (!auth.ok) {
      await logAuditEvent({
        action: 'brand.denied',
        entityType: 'brand',
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: auth.error,
        metadata: buildBrandMetadata({ reason: 'insufficient_permissions' }),
        request,
      });

      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const { brand_name, contact_name, whatsapp_number } = body;

    if (typeof brand_name !== 'string' || !brand_name.trim()) {
      await logAuditEvent({
        action: 'brand.create_failed',
        entityType: 'brand',
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: 'Brand name is required',
        metadata: buildBrandMetadata({
          brandName: brand_name,
          contactName: contact_name,
          whatsappNumber: whatsapp_number,
          reason: 'missing_brand_name',
        }),
        request,
      });

      return NextResponse.json({ error: 'Brand name is required' }, { status: 400 });
    }

    const newBrand = {
      brand_name: brand_name.trim(),
      contact_name: trimToNull(contact_name),
      whatsapp_number: trimToNull(whatsapp_number),
    };

    const supabaseAdmin = getSupabaseAdminClient();

    const { data, error } = await supabaseAdmin
      .from('brands')
      .insert(newBrand)
      .select()
      .single();

    if (error) {
      console.error('Error adding brand:', error);
      await logAuditEvent({
        action: 'brand.create_failed',
        entityType: 'brand',
        entityLabel: newBrand.brand_name,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: error.message,
        afterState: newBrand,
        metadata: buildBrandMetadata({
          brandName: newBrand.brand_name,
          contactName: newBrand.contact_name,
          whatsappNumber: newBrand.whatsapp_number,
          reason: 'database_insert_failed',
        }),
        request,
      });

      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const createdBrand = data as BrandRecord;
    await logAuditEvent({
      action: 'brand.created',
      entityType: 'brand',
      entityId: createdBrand.id,
      entityLabel: createdBrand.brand_name,
      actor: auth.actor,
      outcome: 'success',
      afterState: brandSnapshot(createdBrand),
      metadata: buildBrandMetadata({
        id: createdBrand.id,
        brandName: createdBrand.brand_name,
        contactName: createdBrand.contact_name,
        whatsappNumber: createdBrand.whatsapp_number,
      }),
      request,
    });

    return NextResponse.json(data);
  } catch (err) {
    console.error('Error in POST /api/brands:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PUT - Update a brand
export async function PUT(request: NextRequest) {
  try {
    const auth = await requireRoles(request, ['amin', 'salam']);

    if (!auth.ok) {
      await logAuditEvent({
        action: 'brand.denied',
        entityType: 'brand',
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: auth.error,
        metadata: buildBrandMetadata({ reason: 'insufficient_permissions' }),
        request,
      });

      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const { id, brand_name, contact_name, whatsapp_number } = body;

    if (!id) {
      await logAuditEvent({
        action: 'brand.update_failed',
        entityType: 'brand',
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: 'Brand ID is required',
        metadata: buildBrandMetadata({
          id,
          brandName: brand_name,
          contactName: contact_name,
          whatsappNumber: whatsapp_number,
          reason: 'missing_brand_id',
        }),
        request,
      });

      return NextResponse.json({ error: 'Brand ID is required' }, { status: 400 });
    }

    const brandId = safeBrandId(id);
    if (!brandId) {
      await logAuditEvent({
        action: 'brand.update_failed',
        entityType: 'brand',
        entityLabel: typeof id === 'string' ? id : null,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: 'Brand ID must be a valid UUID',
        metadata: buildBrandMetadata({
          id,
          brandName: brand_name,
          contactName: contact_name,
          whatsappNumber: whatsapp_number,
          reason: 'invalid_brand_id',
        }),
        request,
      });

      return NextResponse.json({ error: 'Brand ID must be a valid UUID' }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdminClient();

    if (typeof brand_name !== 'string' || !brand_name.trim()) {
      await logAuditEvent({
        action: 'brand.update_failed',
        entityType: 'brand',
        entityId: brandId,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: 'Brand name is required',
        metadata: buildBrandMetadata({
          id: brandId,
          brandName: brand_name,
          contactName: contact_name,
          whatsappNumber: whatsapp_number,
          reason: 'missing_brand_name',
        }),
        request,
      });

      return NextResponse.json({ error: 'Brand name is required' }, { status: 400 });
    }

    const { data: existingBrand, error: fetchError } = await supabaseAdmin
      .from('brands')
      .select('id, brand_name, contact_name, whatsapp_number')
      .eq('id', brandId)
      .single();

    if (fetchError || !existingBrand) {
      await logAuditEvent({
        action: 'brand.update_failed',
        entityType: 'brand',
        entityId: brandId,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: fetchError?.message || 'Brand not found',
        metadata: buildBrandMetadata({
          id: brandId,
          brandName: brand_name,
          contactName: contact_name,
          whatsappNumber: whatsapp_number,
          reason: 'brand_fetch_failed',
        }),
        request,
      });

      return NextResponse.json({ error: fetchError?.message || 'Brand not found' }, { status: 404 });
    }

    const previousBrand = existingBrand as BrandRecord;
    const updateData = {
      brand_name: brand_name.trim(),
      contact_name: trimToNull(contact_name),
      whatsapp_number: trimToNull(whatsapp_number),
    };

    const { data: updatedBrand, error } = await supabaseAdmin
      .from('brands')
      .update(updateData)
      .eq('id', brandId)
      .select('id, brand_name, contact_name, whatsapp_number')
      .single();

    if (error) {
      console.error('Error updating brand:', error);
      await logAuditEvent({
        action: 'brand.update_failed',
        entityType: 'brand',
        entityId: previousBrand.id,
        entityLabel: previousBrand.brand_name,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: error.message,
        beforeState: brandSnapshot(previousBrand),
        afterState: updateData,
        metadata: buildBrandMetadata({
          id: previousBrand.id,
          brandName: updateData.brand_name,
          contactName: updateData.contact_name,
          whatsappNumber: updateData.whatsapp_number,
          reason: 'database_update_failed',
        }),
        request,
      });

      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const nextBrand = updatedBrand as BrandRecord;
    await logAuditEvent({
      action: 'brand.updated',
      entityType: 'brand',
      entityId: nextBrand.id,
      entityLabel: nextBrand.brand_name,
      actor: auth.actor,
      outcome: 'success',
      beforeState: brandSnapshot(previousBrand),
      afterState: brandSnapshot(nextBrand),
      metadata: buildBrandMetadata({
        id: nextBrand.id,
        brandName: nextBrand.brand_name,
        contactName: nextBrand.contact_name,
        whatsappNumber: nextBrand.whatsapp_number,
      }),
      request,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error in PUT /api/brands:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE - Delete a brand
export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireRoles(request, ['amin', 'salam']);

    if (!auth.ok) {
      await logAuditEvent({
        action: 'brand.denied',
        entityType: 'brand',
        actor: auth.actor,
        outcome: 'denied',
        errorMessage: auth.error,
        metadata: buildBrandMetadata({ reason: 'insufficient_permissions' }),
        request,
      });

      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      await logAuditEvent({
        action: 'brand.delete_failed',
        entityType: 'brand',
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: 'Brand ID is required',
        metadata: buildBrandMetadata({ reason: 'missing_brand_id' }),
        request,
      });

      return NextResponse.json({ error: 'Brand ID is required' }, { status: 400 });
    }

    const brandId = safeBrandId(id);
    if (!brandId) {
      await logAuditEvent({
        action: 'brand.delete_failed',
        entityType: 'brand',
        entityLabel: id,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: 'Brand ID must be a valid UUID',
        metadata: buildBrandMetadata({
          id,
          reason: 'invalid_brand_id',
        }),
        request,
      });

      return NextResponse.json({ error: 'Brand ID must be a valid UUID' }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdminClient();

    const { data: existingBrand, error: fetchError } = await supabaseAdmin
      .from('brands')
      .select('id, brand_name, contact_name, whatsapp_number')
      .eq('id', brandId)
      .single();

    if (fetchError || !existingBrand) {
      await logAuditEvent({
        action: 'brand.delete_failed',
        entityType: 'brand',
        entityId: brandId,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: fetchError?.message || 'Brand not found',
        metadata: buildBrandMetadata({
          id: brandId,
          reason: 'brand_fetch_failed',
        }),
        request,
      });

      return NextResponse.json({ error: fetchError?.message || 'Brand not found' }, { status: 404 });
    }

    const brandToDelete = existingBrand as BrandRecord;

    const { error } = await supabaseAdmin
      .from('brands')
      .delete()
      .eq('id', brandId);

    if (error) {
      console.error('Error deleting brand:', error);
      await logAuditEvent({
        action: 'brand.delete_failed',
        entityType: 'brand',
        entityId: brandToDelete.id,
        entityLabel: brandToDelete.brand_name,
        actor: auth.actor,
        outcome: 'failure',
        errorMessage: error.message,
        beforeState: brandSnapshot(brandToDelete),
        metadata: buildBrandMetadata({
          id: brandToDelete.id,
          brandName: brandToDelete.brand_name,
          contactName: brandToDelete.contact_name,
          whatsappNumber: brandToDelete.whatsapp_number,
          reason: 'database_delete_failed',
        }),
        request,
      });

      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await logAuditEvent({
      action: 'brand.deleted',
      entityType: 'brand',
      entityId: brandToDelete.id,
      entityLabel: brandToDelete.brand_name,
      actor: auth.actor,
      outcome: 'success',
      beforeState: brandSnapshot(brandToDelete),
      metadata: buildBrandMetadata({
        id: brandToDelete.id,
        brandName: brandToDelete.brand_name,
        contactName: brandToDelete.contact_name,
        whatsappNumber: brandToDelete.whatsapp_number,
      }),
      request,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error in DELETE /api/brands:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
