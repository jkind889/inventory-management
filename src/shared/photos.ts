import { z } from 'zod';
export const PHOTO_BUCKET = 'item-photos';
export const PHOTO_MAX_BYTES = 5_000_000;
export const PHOTO_MAX_PIXELS = 40_000_000;
export const PHOTO_URL_SECONDS = 15 * 60;
export const photoMimeTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const photoUploadInput = z.object({
  byteSize: z.number().int().min(1).max(PHOTO_MAX_BYTES),
  mimeType: z.enum(photoMimeTypes),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  expectedCoverId: z.uuid().nullable(),
}).strict();
export const photoRemoveInput = z.object({ expectedCoverId: z.uuid() }).strict();
export function isDirectPhotoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443');
  } catch { return false; }
}
export const photoImportInput = z.object({
  url: z.string().trim().min(1).max(2048).refine(isDirectPhotoUrl, 'Use a direct HTTPS image link without credentials, fragments, or a custom port.'),
  expectedCoverId: z.uuid().nullable(),
}).strict();
export type PhotoImportInput = z.infer<typeof photoImportInput>;
export type PhotoUploadInput = z.infer<typeof photoUploadInput>;
export type PhotoCover = { id: string; itemId: string; byteSize: number; mimeType: string; width: number; height: number; url: string | null; expiresAt: string };
export type PhotoUpload = { id: string; itemId: string; storagePath: string; expiresAt: string; checksum: string; byteSize: number; mimeType: string; expectedCoverId: string | null; status: string };
export function photoFileError(file: Pick<File, 'size' | 'type'>): string | null {
  if (!file.size) return 'Choose a non-empty image.';
  if (file.size > PHOTO_MAX_BYTES) return 'Photos must be 5 MB or smaller (5,000,000 bytes).';
  if (!(photoMimeTypes as readonly string[]).includes(file.type)) return 'Choose a JPEG, PNG, or static WebP image.';
  return null;
}
