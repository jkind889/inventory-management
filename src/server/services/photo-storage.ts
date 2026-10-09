import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { HTTPException } from 'hono/http-exception';
import { PHOTO_BUCKET, PHOTO_MAX_BYTES, PHOTO_URL_SECONDS } from '../../shared/photos';
export type PhotoStorage = {
  upload: (path: string, bytes: Buffer, mimeType: string) => Promise<void>;
  download: (path: string) => Promise<Buffer>;
  sign: (paths: string[]) => Promise<Map<string, string>>;
  remove: (path: string) => Promise<void>;
};
export function createPhotoStorage(token: string): PhotoStorage {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Photo storage is not configured.');
  // Request-scoped identity. Never reuse a client that carries another user's JWT.
  const client = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` }, fetch: (input, init) => fetch(input, {
      ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    }) },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const bucket = client.storage.from(PHOTO_BUCKET);
  return {
    async upload(path, bytes, mimeType) {
      const { error } = await bucket.upload(path, bytes, { contentType: mimeType, upsert: false, cacheControl: '0' });
      if (error) throw new HTTPException(503, { message: 'The imported image could not be stored. Retry the same link.' });
    },
    async download(path) {
      const { data, error } = await bucket.download(path);
      if (error || !data) throw new HTTPException(422, { message: 'The photo could not be read. Retry its upload before saving.' });
      if (!data.size || data.size > PHOTO_MAX_BYTES) throw new HTTPException(422, { message: 'Photos must be non-empty and 5 MB or smaller.' });
      return Buffer.from(await data.arrayBuffer());
    },
    async sign(paths) {
      if (!paths.length) return new Map();
      const { data, error } = await bucket.createSignedUrls(paths, PHOTO_URL_SECONDS);
      if (error) throw new HTTPException(503, { message: 'Photo access is temporarily unavailable. Try again.' });
      return new Map((data ?? []).filter(row => row.signedUrl && !row.error).map(row => [row.path!, row.signedUrl]));
    },
    async remove(path) {
      const { error } = await bucket.remove([path]);
      if (error) throw new Error('Photo cleanup failed.');
    },
  };
}
