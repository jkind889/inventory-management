import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { Database, UserTransaction } from '../db/client';
import { withUser } from '../db/client';
import { itemPhotos, items } from '../db/schema';
import { withIdempotency } from './idempotency';
import { validatePhoto } from './photo-validation';
import type { PhotoStorage } from './photo-storage';
import { downloadPhoto, type DownloadedPhoto, type PhotoDownloader } from './photo-download';
import { PHOTO_URL_SECONDS, type PhotoCover, type PhotoImportInput, type PhotoUploadInput } from '../../shared/photos';

async function lockItem(tx: UserTransaction, userId: string, itemId: string) {
  const [item] = await tx.select().from(items).where(and(eq(items.userId, userId), eq(items.id, itemId), isNull(items.archivedAt))).for('update');
  if (!item) throw new HTTPException(404, { message: 'This item could not be found.' });
}
async function currentCover(tx: UserTransaction, userId: string, itemId: string) {
  const [photo] = await tx.select().from(itemPhotos).where(and(eq(itemPhotos.userId, userId), eq(itemPhotos.itemId, itemId), eq(itemPhotos.status, 'active')));
  return photo ?? null;
}
function checkCover(actual: string | null, expected: string | null) {
  if (actual !== expected) throw new HTTPException(409, { message: 'The cover changed. Reload this item before changing its photo.' });
}
async function reservePending(tx: UserTransaction, userId: string, itemId: string, input: PhotoUploadInput) {
  const [pending] = await tx.select().from(itemPhotos).where(and(eq(itemPhotos.userId, userId), eq(itemPhotos.itemId, itemId), eq(itemPhotos.status, 'pending')));
  if (pending && new Date(pending.expiresAt).valueOf() > Date.now() && pending.checksum === input.checksum && pending.byteSize === input.byteSize &&
    pending.mimeType === input.mimeType && pending.expectedCoverId === input.expectedCoverId) return { upload: pending };
  if (pending) await tx.update(itemPhotos).set({ status: 'retired' }).where(eq(itemPhotos.id, pending.id));
  const id = randomUUID();
  const [upload] = await tx.insert(itemPhotos).values({ id, userId, itemId, storagePath: `${userId}/${itemId}/${id}`, ...input }).returning();
  return { upload };
}
export function createPhotoService(db: Database, storage: PhotoStorage, fetchImage: PhotoDownloader = downloadPhoto) {
  const service = {
    signBackup(paths: string[]) { return storage.sign(paths); },
    async cleanup(userId: string) {
      // Bytes cannot be rolled back with SQL. Retain tombstones and retry cleanup
      // on later interactions, including a late Storage write to a retired path.
      try {
        const candidates = await withUser(db, userId, async tx => {
          await tx.update(itemPhotos).set({ status: 'retired' }).where(and(eq(itemPhotos.userId, userId), eq(itemPhotos.status, 'pending'), lte(itemPhotos.expiresAt, sql`now()`)));
          return tx.select().from(itemPhotos).where(and(eq(itemPhotos.userId, userId), eq(itemPhotos.status, 'retired')))
            .orderBy(sql`${itemPhotos.cleanupCheckedAt} asc nulls first`, itemPhotos.id).limit(25);
        });
        await Promise.all(candidates.map(async photo => {
          try { await storage.remove(photo.storagePath); } catch { /* Retired records remain retryable. */ }
          // Rotate failed attempts too, so one failing object cannot starve later work.
          await withUser(db, userId, tx => tx.update(itemPhotos).set({ cleanupCheckedAt: sql`now()` }).where(and(eq(itemPhotos.userId, userId), eq(itemPhotos.id, photo.id), eq(itemPhotos.status, 'retired'))));
        }));
      } catch { console.error('Photo cleanup deferred'); }
    },
    async covers(userId: string, itemIds: string[]): Promise<Map<string, PhotoCover>> {
      if (!itemIds.length) return new Map();
      const rows = await withUser(db, userId, tx => tx.select({ photo: itemPhotos }).from(itemPhotos)
        .innerJoin(items, and(eq(items.id, itemPhotos.itemId), eq(items.userId, userId), isNull(items.archivedAt)))
        .where(and(eq(itemPhotos.userId, userId), eq(itemPhotos.status, 'active'), inArray(itemPhotos.itemId, itemIds))));
      let urls = new Map<string, string>();
      try { urls = await storage.sign(rows.map(({ photo }) => photo.storagePath)); } catch { /* Item reads remain available during a Storage outage. */ }
      const expiresAt = new Date(Date.now() + PHOTO_URL_SECONDS * 1000).toISOString();
      return new Map(rows.map(({ photo }) => [photo.itemId, { id: photo.id, itemId: photo.itemId, byteSize: photo.byteSize,
        mimeType: photo.mimeType, width: photo.width!, height: photo.height!, url: urls.get(photo.storagePath) ?? null, expiresAt }]));
    },
    async pending(userId: string, itemId: string) {
      const [photo] = await withUser(db, userId, tx => tx.select().from(itemPhotos).where(and(eq(itemPhotos.userId, userId), eq(itemPhotos.itemId, itemId), eq(itemPhotos.status, 'pending'), sql`${itemPhotos.expiresAt} > now()`)));
      return photo ?? null;
    },
    async reserve(userId: string, itemId: string, key: string, input: PhotoUploadInput) {
      await service.cleanup(userId);
      return withIdempotency(db, userId, key, 'photo_upload', { itemId, ...input }, async tx => {
        await lockItem(tx, userId, itemId);
        checkCover((await currentCover(tx, userId, itemId))?.id ?? null, input.expectedCoverId);
        return reservePending(tx, userId, itemId, input);
      });
    },
    async importFromUrl(userId: string, itemId: string, key: string, input: PhotoImportInput) {
      await service.cleanup(userId);
      let downloaded: DownloadedPhoto | undefined;
      const result = await withIdempotency(db, userId, key, 'photo_import', { itemId, ...input }, async tx => {
        // Check item ownership/current cover before any outgoing request. The
        // bounded external read may roll back; Storage writes happen after commit.
        await lockItem(tx, userId, itemId);
        checkCover((await currentCover(tx, userId, itemId))?.id ?? null, input.expectedCoverId);
        downloaded = await fetchImage(input.url);
        const metadata = { byteSize: downloaded.bytes.length, mimeType: downloaded.mimeType,
          checksum: createHash('sha256').update(downloaded.bytes).digest('hex'), expectedCoverId: input.expectedCoverId };
        await validatePhoto(downloaded.bytes, metadata);
        return reservePending(tx, userId, itemId, metadata);
      });
      const upload = await withUser(db, userId, async tx => {
        await lockItem(tx, userId, itemId);
        const [row] = await tx.select().from(itemPhotos).where(and(eq(itemPhotos.id, result.upload.id), eq(itemPhotos.userId, userId), eq(itemPhotos.itemId, itemId)));
        if (!row) throw new HTTPException(404, { message: 'This photo upload could not be found.' });
        if (row.status === 'retired' || (row.status === 'pending' && new Date(row.expiresAt).valueOf() <= Date.now())) {
          throw new HTTPException(409, { message: 'This import is no longer pending. Start a new import.' });
        }
        return row;
      });
      if (!downloaded) {
        // Lost responses recover the original stored bytes without contacting
        // the source again. If the first write failed, re-fetch must match the
        // durable checksum; a changing source cannot change this attempt.
        try { await validatePhoto(await storage.download(upload.storagePath), upload); return result; }
        catch (error) { if (!(error instanceof HTTPException) || error.status !== 422) throw error; }
        downloaded = await fetchImage(input.url);
        await validatePhoto(downloaded.bytes, upload);
      }
      try { await storage.upload(upload.storagePath, downloaded.bytes, upload.mimeType); }
      catch (error) {
        // A duplicate or ambiguous write is safe only when the immutable object
        // validates against the reserved content. Never use upsert.
        try { await validatePhoto(await storage.download(upload.storagePath), upload); }
        catch { throw error; }
      }
      return result;
    },
    async complete(userId: string, itemId: string, uploadId: string, key: string) {
      const result = await withIdempotency(db, userId, key, 'photo_complete', { itemId, uploadId }, async tx => {
        await lockItem(tx, userId, itemId);
        const [upload] = await tx.select().from(itemPhotos).where(and(eq(itemPhotos.id, uploadId), eq(itemPhotos.userId, userId), eq(itemPhotos.itemId, itemId))).for('update');
        if (!upload) throw new HTTPException(404, { message: 'This photo upload could not be found.' });
        if (upload.status !== 'pending' || new Date(upload.expiresAt).valueOf() <= Date.now()) throw new HTTPException(409, { message: 'This upload is no longer pending. Reload the item and select the file again.' });
        const cover = await currentCover(tx, userId, itemId);
        checkCover(cover?.id ?? null, upload.expectedCoverId);
        // Bounded read/validation only; external Storage writes never happen in this transaction.
        const dimensions = await validatePhoto(await storage.download(upload.storagePath), upload);
        if (new Date(upload.expiresAt).valueOf() <= Date.now()) throw new HTTPException(409, { message: 'This upload expired. Reload the item and select the file again.' });
        if (cover) await tx.update(itemPhotos).set({ status: 'retired' }).where(eq(itemPhotos.id, cover.id));
        await tx.update(itemPhotos).set({ status: 'active', ...dimensions }).where(eq(itemPhotos.id, upload.id));
        return { photoId: upload.id };
      });
      await service.cleanup(userId);
      return result;
    },
    async remove(userId: string, itemId: string, key: string, expectedCoverId: string) {
      const result = await withIdempotency(db, userId, key, 'photo_remove', { itemId, expectedCoverId }, async tx => {
        await lockItem(tx, userId, itemId);
        checkCover((await currentCover(tx, userId, itemId))?.id ?? null, expectedCoverId);
        await tx.update(itemPhotos).set({ status: 'retired' }).where(and(eq(itemPhotos.id, expectedCoverId), eq(itemPhotos.userId, userId)));
        return { removedPhotoId: expectedCoverId };
      });
      await service.cleanup(userId);
      return result;
    },
  };
  return service;
}
export type PhotoService = ReturnType<typeof createPhotoService>;
