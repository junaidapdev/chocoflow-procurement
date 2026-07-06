import { supabase } from '@/lib/supabase';

// Opens a file from a PRIVATE storage bucket by minting a short-lived signed
// URL (valid 1 hour) in a new tab. Accepts either a raw storage path
// ("Brand/uuid.pdf") or a legacy public URL, from which it extracts the path.
// Client-side only (uses the browser Supabase client + window).
export async function openSecureDocument(pathOrUrl: string, bucket: string) {
  let path = pathOrUrl;
  if (pathOrUrl.startsWith('http')) {
    const parts = pathOrUrl.split(`/public/${bucket}/`);
    if (parts.length > 1) path = parts[1];
  }

  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);

  if (data?.signedUrl) {
    window.open(data.signedUrl, '_blank');
  } else {
    alert('Could not secure file link.');
  }
}
