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
        </div>
        <div className="pb-8 sm:pb-10">
          <ClientForm />
        </div>
      </div>
    </main>
  );
}
