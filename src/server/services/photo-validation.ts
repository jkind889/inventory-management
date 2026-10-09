import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { HTTPException } from 'hono/http-exception';
import { PHOTO_MAX_BYTES, PHOTO_MAX_PIXELS } from '../../shared/photos';
export async function validatePhoto(bytes: Buffer, expected: { byteSize: number; mimeType: string; checksum: string }) {
  if (!bytes.length || bytes.length > PHOTO_MAX_BYTES || bytes.length !== expected.byteSize) {
    throw new HTTPException(422, { message: 'The uploaded size does not match this photo, or exceeds 5 MB.' });
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expected.checksum) {
    throw new HTTPException(422, { message: 'The uploaded photo does not match the selected file. Select it again.' });
  }
  try {
    const image = sharp(bytes, { limitInputPixels: PHOTO_MAX_PIXELS, failOn: 'warning', animated: true });
    const metadata = await image.metadata();
    const formats: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    if (formats[metadata.format ?? ''] !== expected.mimeType || (metadata.pages ?? 1) !== 1 ||
      !metadata.width || !metadata.height || metadata.width * metadata.height > PHOTO_MAX_PIXELS) throw new Error('Invalid image');
    // metadata alone does not prove the complete image is decodable.
    await image.stats();
    return { width: metadata.width, height: metadata.height };
  } catch {
    throw new HTTPException(422, { message: 'Choose a valid JPEG, PNG, or static WebP image with at most 40 million pixels.' });
  }
}
