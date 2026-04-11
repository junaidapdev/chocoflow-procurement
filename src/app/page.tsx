import ClientForm from './ClientForm';
import Image from 'next/image';

export default function Home() {
  return (
    <main className="min-h-screen bg-[#fafafa] flex items-center justify-center p-4 selection:bg-yellow-200 selection:text-black">
      <div className="w-full max-w-2xl bg-white rounded-[24px] shadow-sm overflow-hidden mt-8 mb-8 border border-gray-200">
        <div className="bg-white flex flex-col items-center rounded-t-[24px] overflow-hidden">
          <div className="w-full">
            <Image 
              src="/logo.png" 
              alt="Kayan Sweets" 
              width={1200}
              height={600}
              className="w-full h-auto object-contain"
              priority
            />
          </div>
          <div className="w-full bg-white border-b border-gray-100 py-4 text-center z-10 shadow-sm relative">
            <p className="text-gray-500 text-sm font-bold tracking-widest uppercase">Vendor Portal</p>
          </div>
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
