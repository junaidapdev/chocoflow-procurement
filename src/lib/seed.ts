import { supabase } from './supabase';
import { BRANCHES } from './constants';

const INITIAL_BRANDS = [
  'Patchi', 'Bateel', 'Godiva', 'Anthon Berg', 'Ferrero Rocher', 
  'Lindt', 'Neuhaus', 'Toblerone', 'Cadbury', 'Kinder', 
  'Mars', 'Bounty', 'Twix', 'Snickers', 'KitKat', 
  'Milka', 'Raffaello', 'After Eight', 'Galaxy', 'Celebrations'
];

export async function seedBrands() {
  console.log('Seeding initial brands data...');
  const brandData = INITIAL_BRANDS.map(brand => ({ brand_name: brand }));
  
  const { data, error } = await supabase.from('brands').insert(brandData).select();
  
  if (error) {
    console.error('Error seeding brands:', error);
    return null;
  }
  
  console.log(`Successfully seeded ${data.length} brands!`);
  return data;
}

export async function seedInvoices() {
  console.log('Seeding initial invoices data...');
  
  const sampleInvoices = Array.from({ length: 15 }).map((_, index) => {
    const brand = INITIAL_BRANDS[Math.floor(Math.random() * INITIAL_BRANDS.length)];
    const branch = BRANCHES[Math.floor(Math.random() * BRANCHES.length)];
    const states = ['Pending', 'Verified', 'Rejected', 'Approved', 'Paid'];
    const status = states[Math.floor(Math.random() * states.length)];
    
    return {
      brand_name: brand,
      branch_id: branch,
      invoice_number: `INV-${new Date().getFullYear()}-${String(index + 1).padStart(4, '0')}`,
      invoice_date: new Date(Date.now() - Math.floor(Math.random() * 30) * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      amount: Math.floor(Math.random() * 5000) + 100, // Random amount between 100 and 5100
      status,
      vendor_name: `Vendor for ${brand}`,
      vendor_email: `vendor${index}@example.com`,
      rejection_comment: status === 'Rejected' ? 'Missing proper signature on the receipt.' : null
    };
  });

  const { data, error } = await supabase.from('invoices').insert(sampleInvoices).select();

  if (error) {
    console.error('Error seeding invoices:', error);
    return null;
  }
  
  console.log(`Successfully seeded ${data.length} invoices!`);
  return data;
}
