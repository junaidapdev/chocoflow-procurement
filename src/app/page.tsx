import ClientForm from './ClientForm';

export default function Home() {
  return (
    <main className="min-h-screen bg-[#fafafa] flex items-center justify-center p-4 selection:bg-yellow-200 selection:text-black">
      <div className="w-full max-w-2xl bg-white rounded-[24px] shadow-sm overflow-hidden mt-8 mb-8 border border-gray-200">
        <div className="bg-white border-b border-gray-100 py-10 px-8 flex flex-col items-center">
          <h1 className="text-4xl font-extrabold text-black tracking-tight mb-2">Kayan Sweets</h1>
          <p className="text-gray-500 text-sm font-medium tracking-wide uppercase">Vendor Portal</p>
        </div>
        <div className="p-8 sm:p-10">
          <div className="mb-8 text-center">
            <h2 className="text-2xl font-bold text-gray-900">Submit Invoice</h2>
            <p className="text-gray-500 text-sm mt-2">Please provide the details below to submit your invoice for processing.</p>
          </div>
          
          <ClientForm />
        </div>
      </div>
    </main>
  );
}
