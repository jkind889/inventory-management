import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/server/api/app';
import { photoFileError, photoUploadInput, PHOTO_MAX_BYTES } from '../src/shared/photos';
import { validatePhoto } from '../src/server/services/photo-validation';
const userId = randomUUID();
const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const base = { byteSize: 100, mimeType: 'image/png' as const, checksum: 'a'.repeat(64), expectedCoverId: null };
describe('photo validation and API boundary', () => {
  it('accepts the exact byte limit and rejects one byte over, empty and unsupported files', () => {
    expect(photoFileError({ size: PHOTO_MAX_BYTES, type: 'image/jpeg' })).toBeNull();
    expect(photoFileError({ size: PHOTO_MAX_BYTES + 1, type: 'image/jpeg' })).toMatch(/5 MB/);
    expect(photoFileError({ size: 0, type: 'image/png' })).toMatch(/non-empty/);
    expect(photoFileError({ size: 100, type: 'image/heic' })).toMatch(/JPEG/);
    expect(photoUploadInput.safeParse({ ...base, byteSize: PHOTO_MAX_BYTES }).success).toBe(true);
    for (const byteSize of [0, -1, 1.5, PHOTO_MAX_BYTES + 1]) expect(photoUploadInput.safeParse({ ...base, byteSize }).success).toBe(false);
  });
  it('decodes supported original bytes, checks their checksum, size and actual image format', async () => {
    for (const [format, mimeType] of [['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']] as const) {
      const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#744e96' } }).toFormat(format).toBuffer();
      const expected = { byteSize: bytes.length, mimeType, checksum: checksum(bytes) };
      expect(await validatePhoto(bytes, expected)).toEqual({ width: 20, height: 10 });
      await expect(validatePhoto(bytes, { ...expected, checksum: 'b'.repeat(64) })).rejects.toMatchObject({ status: 422 });
      await expect(validatePhoto(bytes, { ...expected, byteSize: bytes.length + 1 })).rejects.toMatchObject({ status: 422 });
      await expect(validatePhoto(bytes, { ...expected, mimeType: mimeType === 'image/png' ? 'image/jpeg' : 'image/png' })).rejects.toMatchObject({ status: 422 });
    }
    const corrupt = Buffer.from('not an image');
    await expect(validatePhoto(corrupt, { byteSize: corrupt.length, mimeType: 'image/png', checksum: checksum(corrupt) })).rejects.toMatchObject({ status: 422 });
  });
  it('rejects images over the decoded pixel limit', async () => {
    const bytes = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: '#744e96' } }).png().toBuffer();
    expect(bytes.length).toBeLessThan(PHOTO_MAX_BYTES);
    await expect(validatePhoto(bytes, { byteSize: bytes.length, mimeType: 'image/png', checksum: checksum(bytes) })).rejects.toMatchObject({ status: 422 });
  });
  it('rejects animated WebP while accepting static WebP', async () => {
    const pixels = Buffer.alloc(10 * 20 * 3); pixels.fill(255, 0, 300); pixels.fill(64, 300);
    const bytes = await sharp(pixels, { raw: { width: 10, height: 20, channels: 3, pageHeight: 10 } }).webp({ delay: [100, 100], loop: 0 }).toBuffer();
    expect((await sharp(bytes, { animated: true }).metadata()).pages).toBe(2);
    await expect(validatePhoto(bytes, { byteSize: bytes.length, mimeType: 'image/webp', checksum: checksum(bytes) })).rejects.toMatchObject({ status: 422 });
  });
  it('requires auth, UUIDs, strict input and retry keys before photo services run', async () => {
    const app = createApi({ verifyToken: async token => token === 'valid' ? userId : null, service: () => { throw new Error('Unexpected domain service'); }, photos: () => { throw new Error('Unexpected photo service'); } });
    const path = `/api/items/${userId}/photo/uploads`;
    const headers = { Authorization: 'Bearer valid', 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };
    expect((await app.request(path, { method: 'POST', body: JSON.stringify(base) })).status).toBe(401);
    for (const body of [{ ...base, byteSize: PHOTO_MAX_BYTES + 1 }, { ...base, userId }, { ...base, storagePath: 'invented' }, { ...base, checksum: 'invalid' }, { ...base, mimeType: 'image/svg+xml' }]) {
      expect((await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect((await app.request(path, { method: 'POST', headers: { ...headers, 'Idempotency-Key': '' }, body: JSON.stringify(base) })).status).toBe(400);
    expect((await app.request(`${path}/invalid/complete`, { method: 'POST', headers, body: '{}' })).status).toBe(400);
    expect((await app.request(`/api/items/${userId}/photo`, { method: 'DELETE', headers, body: '{}' })).status).toBe(400);
  });
});
