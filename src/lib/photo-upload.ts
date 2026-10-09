import { getBrowserClient } from './supabase-browser';
import { PHOTO_BUCKET } from '@/shared/photos';
export async function uploadPhoto(file: File, path: string, signal: AbortSignal, progress: (value: number) => void) {
  const { data, error } = await getBrowserClient().auth.getSession();
  if (error || !data.session) throw new Error('Your session has expired. Please sign in again.');
  if (signal.aborted) throw new DOMException('Upload cancelled', 'AbortError');
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener('abort', abort, { once: true });
    const finish = (error?: Error) => { signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(); };
    xhr.open('POST', `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${path}`);
    xhr.timeout = 90_000;
    xhr.setRequestHeader('Authorization', `Bearer ${data.session.access_token}`);
    xhr.setRequestHeader('apikey', process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('cache-control', '0');
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? undefined : new Error('Photo upload did not finish. Retry the same file.'));
    xhr.onerror = () => finish(new Error('Photo upload lost its connection. Retry the same file.'));
    xhr.ontimeout = () => finish(new Error('Photo upload timed out. Retry the same file.'));
    xhr.onabort = () => finish(new DOMException('Upload cancelled', 'AbortError'));
    xhr.send(file);
  });
}
