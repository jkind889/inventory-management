import { createHash, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import postgres from 'postgres';
import sharp from 'sharp';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { createDatabase, withUser } from '../src/server/db/client';
import { createInventoryService } from '../src/server/services/inventory';
import { createPhotoService } from '../src/server/services/photos';
import { createPhotoStorage } from '../src/server/services/photo-storage';
import { itemPhotos, operations } from '../src/server/db/schema';
import { PHOTO_BUCKET, PHOTO_MAX_BYTES, type PhotoUploadInput } from '../src/shared/photos';
import { createApi } from '../src/server/api/app';
import { verifyToken } from '../src/server/api/auth';
config({ path: '.env.test.local', override: true, quiet: true });
const enabled = !!process.env.DATABASE_ADMIN_URL;
if (!enabled && process.env.REQUIRE_DATABASE_TESTS === '1') throw new Error('Local test database is required.');
describe.skipIf(!enabled)('real Auth, database and Storage photos', () => {
  let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof createDatabase>, inventory: ReturnType<typeof createInventoryService>;
  const users: { id: string; token: string; client: SupabaseClient; photos: ReturnType<typeof createPhotoService>; categoryId: string }[] = [];
  let bytes: Buffer, input: PhotoUploadInput;
  beforeAll(async () => {
    for (const value of [process.env.DATABASE_ADMIN_URL!, process.env.DATABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_URL!]) {
      if (!['localhost', '127.0.0.1'].includes(new URL(value).hostname)) throw new Error('Photo integration tests require loopback services.');
    }
    admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
    connection = createDatabase(process.env.DATABASE_URL!); inventory = createInventoryService(connection.db);
    bytes = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#744e96' } }).png().toBuffer();
    input = { byteSize: bytes.length, mimeType: 'image/png', checksum: createHash('sha256').update(bytes).digest('hex'), expectedCoverId: null };
    for (let i = 0; i < 2; i++) {
      const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await client.auth.signUp({ email: `photo-${randomUUID()}@example.com`, password: `Photo-${randomUUID()}!` });
      if (error || !data.session) throw new Error(`Test sign-up failed: ${error?.message}`);
      const id = data.session.user.id, token = data.session.access_token;
      await inventory.bootstrap(id, { currency: 'USD', timezone: 'America/New_York' });
      const categoryId = (await inventory.categories(id))[0].id;
      users.push({ id, token, client, categoryId, photos: createPhotoService(connection.db, createPhotoStorage(token)) });
    }
  }, 30000);
  afterAll(async () => {
    if (admin) {
      for (const user of users) {
        // Retire first: owner JWTs may only delete retired/expired objects.
        await admin`update app.item_photos set status = 'retired' where user_id = ${user.id}`;
        for (let i = 0; i < 3; i++) await user.photos.cleanup(user.id);
        await admin`delete from auth.users where id = ${user.id}`;
      }
      await admin.end();
    }
    await connection?.close();
  });
  async function item(user = users[0], wishlist = false) {
    return (wishlist ? await inventory.addWant(user.id, randomUUID(), { name: 'Photo want', categoryId: user.categoryId, description: null, productUrl: null, targetAmountMinor: null, priority: 2 }) : await inventory.existingItem(user.id, randomUUID(), { name: 'Photo item', categoryId: user.categoryId, acquiredOn: null, description: null })).item;
  }
  async function upload(user: typeof users[number], path: string, body = bytes, contentType = 'image/png') {
    return user.client.storage.from(PHOTO_BUCKET).upload(path, body, { contentType, upsert: false });
  }
  it('enforces private bucket, item-first uploads, ownership and no direct domain access', async () => {
    const [a, b] = users;
    const [bucket] = await admin`select public, file_size_limit, allowed_mime_types from storage.buckets where id = ${PHOTO_BUCKET}`;
    expect(bucket.public).toBe(false); expect(Number(bucket.file_size_limit)).toBe(PHOTO_MAX_BYTES);
    const missingId = randomUUID();
    await expect(a.photos.reserve(a.id, missingId, randomUUID(), input)).rejects.toMatchObject({ status: 404 });
    expect((await upload(a, `${a.id}/${missingId}/${randomUUID()}`)).error).toBeTruthy();
    const owned = await item(a), other = await item(b);
    await expect(a.photos.reserve(a.id, other.id, randomUUID(), input)).rejects.toMatchObject({ status: 404 });
    await admin`update app.items set archived_at = now() where id = ${owned.id}`;
    await expect(a.photos.reserve(a.id, owned.id, randomUUID(), input)).rejects.toMatchObject({ status: 404 });
    const saved = await item(a), reserved = await a.photos.reserve(a.id, saved.id, randomUUID(), input);
    await admin`update app.items set archived_at = now() where id = ${saved.id}`;
    expect((await upload(a, reserved.upload.storagePath)).error).toBeTruthy();
    await expect(a.photos.complete(a.id, saved.id, reserved.upload.id, randomUUID())).rejects.toMatchObject({ status: 404 });
    const access = await admin`select has_table_privilege('authenticated','app.item_photos','select,insert,update') as photos, has_table_privilege('authenticated','app.items','select,insert,update') as items, (select rolbypassrls from pg_roles where rolname = 'inventory_photo_policy') as bypass`;
    expect(access[0]).toMatchObject({ photos: false, items: false, bypass: false });
  });
  it('reserves once, recovers matching pending content and rejects retry conflicts', async () => {
    const a = users[0], owned = await item(); const key = randomUUID();
    const results = await Promise.all([a.photos.reserve(a.id, owned.id, key, input), a.photos.reserve(a.id, owned.id, key, input)]);
    expect(results[0].upload.id).toBe(results[1].upload.id); expect(results.map(row => row.replayed).sort()).toEqual([false, true]);
    expect((await a.photos.reserve(a.id, owned.id, randomUUID(), input)).upload.id).toBe(results[0].upload.id);
    await expect(a.photos.reserve(a.id, owned.id, key, { ...input, checksum: 'b'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    await expect(a.photos.complete(a.id, owned.id, results[0].upload.id, key)).rejects.toMatchObject({ status: 409 });
    const replacement = await a.photos.reserve(a.id, owned.id, randomUUID(), { ...input, checksum: 'b'.repeat(64) });
    expect(replacement.upload.id).not.toBe(results[0].upload.id);
    expect((await upload(a, results[0].upload.storagePath)).error).toBeTruthy();
  });
  it('uses real Storage policies for private reads, cross-owner denial, immutable objects and active deletion denial', async () => {
    const [a, b] = users; const owned = await item();
    const result = await a.photos.reserve(a.id, owned.id, randomUUID(), input);
    const path = result.upload.storagePath;
    expect((await upload(b, path)).error).toBeTruthy();
    expect((await upload(a, path)).error).toBeNull();
    expect((await upload(a, path)).error).toBeTruthy();
    expect((await a.client.storage.from(PHOTO_BUCKET).upload(path, bytes, { contentType: 'image/png', upsert: true })).error).toBeTruthy();
    expect((await b.client.storage.from(PHOTO_BUCKET).download(path)).error).toBeTruthy();
    expect((await b.client.storage.from(PHOTO_BUCKET).createSignedUrl(path, 60)).error).toBeTruthy();
    const bRemoval = await b.client.storage.from(PHOTO_BUCKET).remove([path]);
    expect(bRemoval.data ?? []).toHaveLength(0);
    expect((await a.client.storage.from(PHOTO_BUCKET).download(path)).error).toBeNull();
    const key = randomUUID();
    const completed = await Promise.all([a.photos.complete(a.id, owned.id, result.upload.id, key), a.photos.complete(a.id, owned.id, result.upload.id, key)]);
    expect(completed.map(row => row.replayed).sort()).toEqual([false, true]);
    const activeRemoval = await a.client.storage.from(PHOTO_BUCKET).remove([path]);
    expect(activeRemoval.data ?? []).toHaveLength(0);
    expect((await a.client.storage.from(PHOTO_BUCKET).download(path)).error).toBeNull();
    await expect(b.photos.complete(b.id, owned.id, result.upload.id, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(b.photos.remove(b.id, owned.id, randomUUID(), result.upload.id)).rejects.toMatchObject({ status: 404 });
    const cover = (await a.photos.covers(a.id, [owned.id])).get(owned.id)!;
    expect(cover.url).toBeTruthy(); expect(cover.width).toBe(30);
    expect(new Date(cover.expiresAt).valueOf() - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    expect((await fetch(cover.url!)).status).toBe(200);
    expect((await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${path}`)).ok).toBe(false);
  });
  it('enforces exact bucket byte limit and file types even when client checks are bypassed', async () => {
    const a = users[0], owned = await item();
    const exact = Buffer.alloc(PHOTO_MAX_BYTES); bytes.copy(exact);
    const expected = { ...input, byteSize: exact.length, checksum: createHash('sha256').update(exact).digest('hex') };
    const result = await a.photos.reserve(a.id, owned.id, randomUUID(), expected);
    expect((await upload(a, result.upload.storagePath, Buffer.alloc(PHOTO_MAX_BYTES + 1))).error).toBeTruthy();
    expect((await upload(a, result.upload.storagePath, exact, 'image/svg+xml')).error).toBeTruthy();
    expect((await upload(a, result.upload.storagePath, exact)).error).toBeNull();
    await a.photos.complete(a.id, owned.id, result.upload.id, randomUUID());
  });
  it('preserves old cover on failed validation, rolls back receipts and rejects stale changes', async () => {
    const a = users[0], owned = await item();
    const original = await a.photos.reserve(a.id, owned.id, randomUUID(), input);
    await upload(a, original.upload.storagePath); await a.photos.complete(a.id, owned.id, original.upload.id, randomUUID());
    const corrupt = Buffer.from('corrupt image');
    const bad = { ...input, byteSize: corrupt.length, checksum: createHash('sha256').update(corrupt).digest('hex'), expectedCoverId: original.upload.id };
    const pending = await a.photos.reserve(a.id, owned.id, randomUUID(), bad); await upload(a, pending.upload.storagePath, corrupt);
    const key = randomUUID();
    await expect(a.photos.complete(a.id, owned.id, pending.upload.id, key)).rejects.toMatchObject({ status: 422 });
    expect((await a.photos.covers(a.id, [owned.id])).get(owned.id)?.id).toBe(original.upload.id);
    expect(await withUser(connection.db, a.id, tx => tx.select().from(operations).where(eq(operations.idempotencyKey, key)))).toHaveLength(0);
    const good = await a.photos.reserve(a.id, owned.id, randomUUID(), { ...input, expectedCoverId: original.upload.id });
    await upload(a, good.upload.storagePath); await a.photos.complete(a.id, owned.id, good.upload.id, randomUUID());
    await expect(a.photos.remove(a.id, owned.id, randomUUID(), original.upload.id)).rejects.toMatchObject({ status: 409 });
    await expect(a.photos.reserve(a.id, owned.id, randomUUID(), { ...input, expectedCoverId: original.upload.id })).rejects.toMatchObject({ status: 409 });
    expect((await a.photos.covers(a.id, [owned.id])).get(owned.id)?.id).toBe(good.upload.id);
  });
  it('expires pending reservations, denies late uploads and retries cleanup failures', async () => {
    const a = users[0], owned = await item(); const pending = await a.photos.reserve(a.id, owned.id, randomUUID(), input);
    await upload(a, pending.upload.storagePath);
    await admin`update app.item_photos set expires_at = now() - interval '1 second' where id = ${pending.upload.id}`;
    await expect(a.photos.complete(a.id, owned.id, pending.upload.id, randomUUID())).rejects.toMatchObject({ status: 409 });
    const failing = createPhotoService(connection.db, { upload: async () => {}, download: async () => bytes, sign: async () => new Map(), remove: async () => { throw new Error('Offline'); } });
    await failing.cleanup(a.id);
    expect((await a.client.storage.from(PHOTO_BUCKET).download(pending.upload.storagePath)).error).toBeNull();
    await a.photos.cleanup(a.id);
    expect((await a.client.storage.from(PHOTO_BUCKET).download(pending.upload.storagePath)).error).toBeTruthy();
    expect((await upload(a, pending.upload.storagePath)).error).toBeTruthy();
    expect((await a.photos.reserve(a.id, owned.id, randomUUID(), input)).upload.id).not.toBe(pending.upload.id);
  });
  it('isolates retry keys by account and exposes confirmed covers through the real API and overview', async () => {
    const [a, b] = users, key = randomUUID();
    const owned = (await inventory.purchase(a.id, randomUUID(), { name: 'Purchased with photo', categoryId: a.categoryId, amountMinor: 100, currency: 'USD', occurredOn: '2026-10-08', merchant: null, note: null })).item;
    const other = await item(b);
    const app = createApi({ verifyToken, service: () => inventory, photos: token => createPhotoService(connection.db, createPhotoStorage(token)) });
    const headers = { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key };
    const path = `/api/items/${owned.id}/photo/uploads`;
    const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(response.status).toBe(201); const result = await response.json();
    const replay = await app.request(path, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(replay.status).toBe(200); expect((await replay.json()).upload.id).toBe(result.upload.id);
    expect((await b.photos.reserve(b.id, other.id, key, input)).upload.id).not.toBe(result.upload.id);
    expect((await upload(a, result.upload.storagePath)).error).toBeNull();
    const completeHeaders = { ...headers, 'Idempotency-Key': randomUUID() }, completePath = `${path}/${result.upload.id}/complete`;
    expect((await app.request(completePath, { method: 'POST', headers: completeHeaders, body: '{}' })).status).toBe(201);
    const completed = await app.request(completePath, { method: 'POST', headers: completeHeaders, body: '{}' });
    expect(completed.status).toBe(200); expect((await completed.json()).replayed).toBe(true);
    const overview = await app.request('/api/collections/overview', { headers });
    const latest = (await overview.json()).data.flatMap((entry: { latest: { id: string; cover: { id: string; url: string } }[] }) => entry.latest).find((row: { id: string }) => row.id === owned.id);
    expect(latest.cover.id).toBe(result.upload.id); expect((await fetch(latest.cover.url)).status).toBe(200);
    expect((await inventory.spending(a.id, '2026-10-01', '2026-10-31')).grossSpendingMinor).toBe('100');
  });
  it('handles wishlist covers, lost-response removal retries and preserves spending/item counts', async () => {
    const a = users[0], wanted = await item(a, true);
    const before = await inventory.spending(a.id, '2026-01-01', '2026-12-31');
    const countBefore = await admin`select count(*)::int as n from app.items where user_id = ${a.id}`;
    const pending = await a.photos.reserve(a.id, wanted.id, randomUUID(), input);
    await upload(a, pending.upload.storagePath); await a.photos.complete(a.id, wanted.id, pending.upload.id, randomUUID());
    const app = createApi({ verifyToken, service: () => inventory, photos: token => createPhotoService(connection.db, createPhotoStorage(token)) });
    const detail = await app.request(`/api/items/${wanted.id}`, { headers: { Authorization: `Bearer ${a.token}` } });
    expect(detail.status).toBe(200); expect((await detail.json()).cover.id).toBe(pending.upload.id);
    const key = randomUUID();
    const results = await Promise.all([a.photos.remove(a.id, wanted.id, key, pending.upload.id), a.photos.remove(a.id, wanted.id, key, pending.upload.id)]);
    expect(results.map(row => row.replayed).sort()).toEqual([false, true]);
    expect((await a.photos.covers(a.id, [wanted.id])).size).toBe(0);
    expect(await inventory.spending(a.id, '2026-01-01', '2026-12-31')).toEqual(before);
    expect(await admin`select count(*)::int as n from app.items where user_id = ${a.id}`).toEqual(countBefore);
    const otherAccountPhotos = await withUser(connection.db, users[1].id, tx => tx.select().from(itemPhotos));
    expect(otherAccountPhotos.length).toBeGreaterThan(0);
    expect(otherAccountPhotos.every(photo => photo.userId === users[1].id)).toBe(true);
    expect(otherAccountPhotos.some(photo => photo.itemId === wanted.id)).toBe(false);
    await expect(withUser(connection.db, a.id, tx => tx.insert(itemPhotos).values({ ...input, id: randomUUID(), userId: a.id, itemId: randomUUID(), storagePath: `${a.id}/fake/path` }))).rejects.toBeDefined();
  });
  it('checks saved item ownership and availability before fetching an image link', async () => {
    const [a, b] = users, fetchImage = vi.fn(async () => ({ bytes, mimeType: 'image/png' as const }));
    const photos = createPhotoService(connection.db, createPhotoStorage(a.token), fetchImage);
    const other = await item(b), archived = await item(a);
    await admin`update app.items set archived_at = now() where id = ${archived.id}`;
    for (const id of [randomUUID(), other.id, archived.id]) {
      await expect(photos.importFromUrl(a.id, id, randomUUID(), { url: 'https://images.example.com/direct.png', expectedCoverId: null })).rejects.toMatchObject({ status: 404 });
    }
    expect(fetchImage).not.toHaveBeenCalled();
  });
  it('imports immutable private bytes with concurrent/sequential retries and account-scoped keys', async () => {
    const [a, b] = users, owned = await item(a), other = await item(b), key = randomUUID();
    const fetchImage = vi.fn(async () => ({ bytes, mimeType: 'image/png' as const }));
    const photos = createPhotoService(connection.db, createPhotoStorage(a.token), fetchImage);
    const link = { url: 'https://images.example.com/direct.png', expectedCoverId: null };
    const results = await Promise.all([photos.importFromUrl(a.id, owned.id, key, link), photos.importFromUrl(a.id, owned.id, key, link)]);
    expect(results.map(row => row.replayed).sort()).toEqual([false, true]);
    expect(results[0].upload.id).toBe(results[1].upload.id);
    const calls = fetchImage.mock.calls.length;
    expect((await photos.importFromUrl(a.id, owned.id, key, link)).upload.id).toBe(results[0].upload.id);
    expect(fetchImage).toHaveBeenCalledTimes(calls);
    await expect(photos.importFromUrl(a.id, owned.id, key, { ...link, url: 'https://images.example.com/changed.png' })).rejects.toMatchObject({ status: 409 });
    await expect(photos.reserve(a.id, owned.id, key, input)).rejects.toMatchObject({ status: 409 });
    const otherPhotos = createPhotoService(connection.db, createPhotoStorage(b.token), fetchImage);
    expect((await otherPhotos.importFromUrl(b.id, other.id, key, link)).upload.id).not.toBe(results[0].upload.id);
    const path = results[0].upload.storagePath;
    expect(Buffer.from(await (await a.client.storage.from(PHOTO_BUCKET).download(path)).data!.arrayBuffer())).toEqual(bytes);
    expect((await b.client.storage.from(PHOTO_BUCKET).download(path)).error).toBeTruthy();
    const completionKey = randomUUID();
    await photos.complete(a.id, owned.id, results[0].upload.id, completionKey);
    const replay = await photos.importFromUrl(a.id, owned.id, key, link);
    expect(replay.replayed).toBe(true);
    expect((await photos.complete(a.id, owned.id, replay.upload.id, completionKey)).replayed).toBe(true);
  });
  it('rolls back invalid imports, recovers failed writes and rejects changed source bytes on retry', async () => {
    const a = users[0], owned = await item(a, true), key = randomUUID();
    const storage = createPhotoStorage(a.token), link = { url: 'https://images.example.com/direct.png', expectedCoverId: null };
    const before = await inventory.spending(a.id, '2026-01-01', '2026-12-31');
    const bad = createPhotoService(connection.db, storage, async () => ({ bytes: Buffer.from('not an image'), mimeType: 'image/png' }));
    await expect(bad.importFromUrl(a.id, owned.id, key, link)).rejects.toMatchObject({ status: 422 });
    expect(await withUser(connection.db, a.id, tx => tx.select().from(operations).where(eq(operations.idempotencyKey, key)))).toHaveLength(0);
    expect(await withUser(connection.db, a.id, tx => tx.select().from(itemPhotos).where(eq(itemPhotos.itemId, owned.id)))).toHaveLength(0);
    let offline = true, source = bytes;
    const importer = createPhotoService(connection.db, { ...storage, upload: async (...args) => {
      if (offline) throw new HTTPException(503, { message: 'Offline' });
      await storage.upload(...args);
    } }, async () => ({ bytes: source, mimeType: 'image/png' }));
    await expect(importer.importFromUrl(a.id, owned.id, key, link)).rejects.toMatchObject({ status: 503 });
    expect((await importer.covers(a.id, [owned.id])).size).toBe(0);
    source = await sharp({ create: { width: 30, height: 20, channels: 3, background: 'blue' } }).png().toBuffer();
    offline = false;
    await expect(importer.importFromUrl(a.id, owned.id, key, link)).rejects.toMatchObject({ status: 422 });
    source = bytes;
    const imported = await importer.importFromUrl(a.id, owned.id, key, link);
    expect(imported.replayed).toBe(true);
    await importer.complete(a.id, owned.id, imported.upload.id, randomUUID());
    expect(await inventory.spending(a.id, '2026-01-01', '2026-12-31')).toEqual(before);
  });
  it('recovers an ambiguous Storage write and exposes direct-link imports through the authenticated API', async () => {
    const a = users[0], owned = await item(a), storage = createPhotoStorage(a.token);
    const photos = createPhotoService(connection.db, { ...storage, upload: async (...args) => {
      await storage.upload(...args); throw new HTTPException(503, { message: 'Response lost' });
    } }, async () => ({ bytes, mimeType: 'image/png' }));
    const app = createApi({ verifyToken, service: () => inventory, photos: () => photos });
    const path = `/api/items/${owned.id}/photo/imports`, key = randomUUID();
    const headers = { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key };
    const link = { url: 'https://images.example.com/direct.png', expectedCoverId: null };
    expect((await app.request(path, { method: 'POST', body: JSON.stringify(link) })).status).toBe(401);
    expect((await app.request(path, { method: 'POST', headers, body: JSON.stringify({ ...link, url: 'http://example.com/a.png' }) })).status).toBe(400);
    const result = await app.request(path, { method: 'POST', headers, body: JSON.stringify(link) });
    expect(result.status).toBe(201);
    const imported = (await result.json()).upload;
    expect((await app.request(path, { method: 'POST', headers, body: JSON.stringify(link) })).status).toBe(200);
    await photos.complete(a.id, owned.id, imported.id, randomUUID());
    const stale = await app.request(path, { method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() }, body: JSON.stringify(link) });
    expect(stale.status).toBe(409);
    expect((await photos.covers(a.id, [owned.id])).get(owned.id)?.id).toBe(imported.id);
  });
});
