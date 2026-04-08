'use client';

import { useState } from 'react';
import { Loader2, Search, AlertCircle, Trash2, Plus, X } from 'lucide-react';

type Brand = {
  id: string;
  brand_name: string;
  contact_name: string | null;
  whatsapp_number: string | null;
};

export default function BrandsClient({ initialBrands }: { initialBrands: Brand[] }) {
  const [brands, setBrands] = useState<Brand[]>(initialBrands);
  const [search, setSearch] = useState('');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addingBrand, setAddingBrand] = useState(false);
  const [newBrand, setNewBrand] = useState({ brand_name: '', contact_name: '', whatsapp_number: '' });

  // Status computation
  const totalBrands = brands.length;
  const configuredBrands = brands.filter(b => b.whatsapp_number && b.whatsapp_number.trim() !== '').length;

  const filteredBrands = brands.filter(b => 
    b.brand_name.toLowerCase().includes(search.toLowerCase())
  );

  const handleUpdate = async (id: string) => {
    setLoadingId(id);
    setErrorId(null);
    const brandToUpdate = brands.find(b => b.id === id);
    if (!brandToUpdate) return;

    try {
      const res = await fetch('/api/brands', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          brand_name: brandToUpdate.brand_name,
          contact_name: brandToUpdate.contact_name,
          whatsapp_number: brandToUpdate.whatsapp_number,
        }),
      });

      if (!res.ok) throw new Error('Failed to update brand');
      
    } catch (err) {
      console.error(err);
      setErrorId(id);
    } finally {
      setLoadingId(null);
    }
  };

  const handleDelete = async (id: string, brandName: string) => {
    const confirmed = window.confirm(`Are you sure you want to delete "${brandName}"? This action cannot be undone.`);
    if (!confirmed) return;

    setDeletingId(id);
    setErrorId(null);

    try {
      const res = await fetch(`/api/brands?id=${id}`, { method: 'DELETE' });

      if (!res.ok) throw new Error('Failed to delete brand');

      setBrands(prev => prev.filter(b => b.id !== id));
    } catch (err) {
      console.error(err);
      setErrorId(id);
    } finally {
      setDeletingId(null);
    }
  };

  const handleAddBrand = async () => {
    if (!newBrand.brand_name.trim()) return;
    setAddingBrand(true);

    try {
      const res = await fetch('/api/brands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand_name: newBrand.brand_name.trim(),
          contact_name: newBrand.contact_name.trim() || null,
          whatsapp_number: newBrand.whatsapp_number.trim() || null,
        }),
      });

      if (!res.ok) throw new Error('Failed to add brand');

      const data = await res.json();
      setBrands(prev => [...prev, data].sort((a, b) => a.brand_name.localeCompare(b.brand_name)));
      setNewBrand({ brand_name: '', contact_name: '', whatsapp_number: '' });
      setShowAddForm(false);
    } catch (err) {
      console.error(err);
      alert('Failed to add brand. Please try again.');
    } finally {
      setAddingBrand(false);
    }
  };

  const handleFieldChange = (id: string, field: keyof Brand, value: string) => {
    setBrands(prev => prev.map(brand => 
      brand.id === id ? { ...brand, [field]: value } : brand
    ));
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-[24px] shadow-sm border border-gray-200">
        <h3 className="text-xl font-bold text-gray-900 mb-2">Onboarding Status</h3>
        <p className="text-gray-500 font-medium">{configuredBrands} of {totalBrands} brands have WhatsApp numbers on file.</p>
        
        {/* Progress Bar */}
        <div className="w-full bg-gray-100 rounded-full h-2.5 mt-4">
          <div className="bg-yellow-400 h-2.5 rounded-full transition-all duration-500" style={{ width: `${(configuredBrands / Math.max(1, totalBrands)) * 100}%` }}></div>
        </div>
      </div>

      <div className="bg-white rounded-[24px] shadow-sm border border-gray-200 overflow-hidden">
        <div className="p-4 border-b border-gray-200 flex justify-between items-center gap-3 bg-gray-50/50">
          <div className="relative w-full max-w-md">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input 
              type="text" 
              placeholder="Search brand by name..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:border-yellow-400 transition-all font-medium placeholder-gray-400 text-gray-900"
            />
          </div>
          <button
            onClick={() => { setShowAddForm(true); setNewBrand({ brand_name: '', contact_name: '', whatsapp_number: '' }); }}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-xl transition-all shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-600 whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            Add Brand
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50/80 border-b border-gray-100">
                <th className="py-4 px-6 text-xs font-bold text-gray-500 uppercase tracking-wider">BRAND NAME</th>
                <th className="py-4 px-6 text-xs font-bold text-gray-500 uppercase tracking-wider">CONTACT NAME</th>
                <th className="py-4 px-6 text-xs font-bold text-gray-500 uppercase tracking-wider">WHATSAPP NUMBER</th>
                <th className="py-4 px-6 text-xs font-bold text-gray-500 uppercase tracking-wider text-right">ACTION</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {showAddForm && (
                <tr className="bg-emerald-50/40 animate-pulse-once">
                  <td className="py-3 px-6 whitespace-nowrap">
                    <input
                      type="text"
                      autoFocus
                      value={newBrand.brand_name}
                      onChange={(e) => setNewBrand(prev => ({ ...prev, brand_name: e.target.value }))}
                      className="w-full px-4 py-2 border border-emerald-300 rounded-xl text-sm font-bold bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                      placeholder="New brand name *"
                      onKeyDown={(e) => e.key === 'Enter' && handleAddBrand()}
                    />
                  </td>
                  <td className="py-3 px-6 whitespace-nowrap">
                    <input
                      type="text"
                      value={newBrand.contact_name}
                      onChange={(e) => setNewBrand(prev => ({ ...prev, contact_name: e.target.value }))}
                      className="w-full px-4 py-2 border border-emerald-300 rounded-xl text-sm bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                      placeholder="Contact name"
                      onKeyDown={(e) => e.key === 'Enter' && handleAddBrand()}
                    />
                  </td>
                  <td className="py-3 px-6 whitespace-nowrap">
                    <input
                      type="text"
                      value={newBrand.whatsapp_number}
                      onChange={(e) => setNewBrand(prev => ({ ...prev, whatsapp_number: e.target.value }))}
                      className="w-full px-4 py-2 border border-emerald-300 rounded-xl text-sm bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                      placeholder="+966XXXXXXXXX"
                      onKeyDown={(e) => e.key === 'Enter' && handleAddBrand()}
                    />
                  </td>
                  <td className="py-3 px-6 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end space-x-2">
                      <button
                        onClick={handleAddBrand}
                        disabled={addingBrand || !newBrand.brand_name.trim()}
                        className="inline-flex items-center justify-center px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-200 disabled:text-gray-400 text-white text-sm font-bold rounded-xl transition-all shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-600 min-w-[80px]"
                      >
                        {addingBrand ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          'Add'
                        )}
                      </button>
                      <button
                        onClick={() => setShowAddForm(false)}
                        disabled={addingBrand}
                        className="inline-flex items-center justify-center p-2.5 bg-gray-100 hover:bg-gray-200 text-gray-500 hover:text-gray-700 rounded-xl transition-all focus:outline-none"
                        title="Cancel"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              )}
              {filteredBrands.map((brand) => {
                const isAmber = !brand.whatsapp_number || brand.whatsapp_number.trim() === '';
                return (
                  <tr key={brand.id} className={`transition-colors hover:bg-gray-50/50 ${isAmber ? 'bg-amber-50/30' : ''}`}>
                    <td className="py-3 px-6 whitespace-nowrap">
                      <input 
                        type="text"
                        value={brand.brand_name || ''}
                        onChange={(e) => handleFieldChange(brand.id, 'brand_name', e.target.value)}
                        className={`w-full px-4 py-2 border rounded-xl text-sm font-bold bg-transparent text-gray-900 transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400 ${isAmber ? 'border-amber-200' : 'border-transparent hover:border-gray-200'}`}
                        placeholder="Brand Info"
                      />
                    </td>
                    <td className="py-3 px-6 whitespace-nowrap">
                      <input 
                        type="text"
                        value={brand.contact_name || ''}
                        onChange={(e) => handleFieldChange(brand.id, 'contact_name', e.target.value)}
                        className={`w-full px-4 py-2 border rounded-xl text-sm bg-transparent text-gray-900 transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400 ${isAmber ? 'border-amber-200' : 'border-transparent hover:border-gray-200'}`}
                        placeholder="John Doe"
                      />
                    </td>
                    <td className="py-3 px-6 whitespace-nowrap">
                      <input 
                        type="text"
                        value={brand.whatsapp_number || ''}
                        onChange={(e) => handleFieldChange(brand.id, 'whatsapp_number', e.target.value)}
                        className={`w-full px-4 py-2 border rounded-xl text-sm bg-transparent text-gray-900 transition-colors focus:bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400 ${isAmber ? 'border-amber-200' : 'border-transparent hover:border-gray-200'}`}
                        placeholder="+966XXXXXXXXX"
                      />
                    </td>
                    <td className="py-3 px-6 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end space-x-2">
                        {errorId === brand.id && (
                          <AlertCircle className="w-5 h-5 text-red-500 mr-1" />
                        )}
                        <button
                          onClick={() => handleUpdate(brand.id)}
                          disabled={loadingId === brand.id || deletingId === brand.id || brand.brand_name.trim() === ''}
                          className="inline-flex items-center justify-center px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-200 disabled:text-gray-400 text-white text-sm font-bold rounded-xl transition-all shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-600 min-w-[80px]"
                        >
                          {loadingId === brand.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            'Save'
                          )}
                        </button>
                        <button
                          onClick={() => handleDelete(brand.id, brand.brand_name)}
                          disabled={loadingId === brand.id || deletingId === brand.id}
                          className="inline-flex items-center justify-center p-2.5 bg-red-50 hover:bg-red-100 disabled:bg-gray-100 disabled:text-gray-300 text-red-600 hover:text-red-700 rounded-xl transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                          title="Delete brand"
                        >
                          {deletingId === brand.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              
              {filteredBrands.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-16 text-center text-gray-500">
                    <div className="flex flex-col items-center">
                      <Search className="w-10 h-10 text-gray-300 mb-4" />
                      <p className="font-bold text-gray-700">No brands found</p>
                      <p className="text-sm mt-1">We couldn&apos;t find any brands matching &quot;{search}&quot;</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
