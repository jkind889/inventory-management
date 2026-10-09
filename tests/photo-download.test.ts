import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { photoImportInput, PHOTO_MAX_BYTES } from '../src/shared/photos';
import { downloadPhoto, isPublicPhotoAddress, readPhotoResponse, resolvePhotoAddress } from '../src/server/services/photo-download';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
function response(chunks: Buffer[], headers: Record<string, string> = { 'content-type': 'image/png' }, statusCode = 200) {
  return { headers, statusCode, async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; } };
}
beforeEach(() => { vi.clearAllMocks(); });
describe('direct image URL safety and bounded downloads', () => {
  it('only accepts bounded HTTPS links without credentials, fragments or custom ports', () => {
    const input = { expectedCoverId: null };
    for (const url of ['https://images.example.com/photo.png', 'https://images.example.com/image?id=1', ' https://images.example.com/photo.png ']) {
      expect(photoImportInput.safeParse({ ...input, url }).success).toBe(true);
    }
    for (const url of ['http://example.com/a.jpg', 'file:///a.png', 'data:image/png;base64,a', 'https://user:secret@example.com/a.png', 'https://example.com:444/a.png', 'https://example.com/a.png#fragment', 'https://example.com/' + 'a'.repeat(2048)]) {
      expect(photoImportInput.safeParse({ ...input, url }).success).toBe(false);
    }
    expect(photoImportInput.safeParse({ ...input, url: 'https://example.com/a.png', storagePath: 'invented' }).success).toBe(false);
  });
  it('blocks nonpublic IPv4/IPv6, mapped addresses, transition networks and metadata destinations', () => {
    for (const address of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:8.8.8.8', '2001:db8::1', '2002::1', '64:ff9b::1', '2001::1', 'not-an-ip']) {
      expect(isPublicPhotoAddress(address), address).toBe(false);
    }
    for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) expect(isPublicPhotoAddress(address), address).toBe(true);
  });
  it('rejects mixed DNS answers, private literal IPs, failed lookups and cancelled lookups', async () => {
    const signal = new AbortController().signal;
    await expect(resolvePhotoAddress('example.com', signal, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])).rejects.toMatchObject({ status: 422 });
    for (const host of ['127.0.0.1', '[::1]']) await expect(resolvePhotoAddress(host, signal)).rejects.toMatchObject({ status: 422 });
    await expect(resolvePhotoAddress('example.com', signal, async () => { throw new Error('DNS failure'); })).rejects.toMatchObject({ status: 422 });
    const controller = new AbortController();
    const pending = resolvePhotoAddress('example.com', controller.signal, () => new Promise(() => {}));
    controller.abort(); await expect(pending).rejects.toMatchObject({ status: 422 });
  });
  it('allows the exact size, rejects oversized headers and bounds streaming bodies without trusting headers', async () => {
    const exact = Buffer.alloc(PHOTO_MAX_BYTES);
    expect((await readPhotoResponse(response([exact]))).bytes.length).toBe(PHOTO_MAX_BYTES);
    await expect(readPhotoResponse(response([exact, Buffer.alloc(1)]))).rejects.toMatchObject({ status: 422 });
    await expect(readPhotoResponse(response([], { 'content-type': 'image/png', 'content-length': String(PHOTO_MAX_BYTES + 1) }))).rejects.toMatchObject({ status: 422 });
    await expect(readPhotoResponse(response([Buffer.from('a')], { 'content-type': 'image/png', 'content-length': '2' }))).rejects.toMatchObject({ status: 422 });
    await expect(readPhotoResponse(response([]))).rejects.toMatchObject({ status: 422 });
  });
  it('rejects redirects, sharing pages, unsupported types and compressed HTTP bodies', async () => {
    for (const status of [301, 302, 307, 404, 500]) await expect(readPhotoResponse(response([], { location: 'https://127.0.0.1/image' }, status))).rejects.toMatchObject({ status: 422 });
    for (const type of ['text/html', 'image/svg+xml', 'image/heic', 'application/octet-stream']) await expect(readPhotoResponse(response([Buffer.from('a')], { 'content-type': type }))).rejects.toMatchObject({ status: 422 });
    await expect(readPhotoResponse(response([Buffer.from('a')], { 'content-type': 'image/png', 'content-encoding': 'gzip' }))).rejects.toMatchObject({ status: 422 });
  });
  it('pins the validated DNS result, preserves the TLS hostname, sends no credentials and never follows redirects', async () => {
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mocks.request.mockImplementation((url, options, receive) => {
      expect(url.hostname).toBe('images.example.com');
      expect(options.agent).toBe(false); expect(options.family).toBe(4); expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.headers).toEqual({ Accept: 'image/jpeg, image/png, image/webp', 'Accept-Encoding': 'identity' });
      options.lookup('images.example.com', { all: false }, (error: unknown, address: string, family: number) => {
        expect(error).toBeNull(); expect(address).toBe('93.184.216.34'); expect(family).toBe(4);
      });
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        const incoming = new PassThrough() as PassThrough & { headers: Record<string, string>; statusCode: number };
        incoming.headers = { location: 'https://127.0.0.1/image' }; incoming.statusCode = 302;
        receive(incoming); incoming.end();
      };
      return req;
    });
    await expect(downloadPhoto('https://images.example.com/a.png')).rejects.toMatchObject({ status: 422 });
    expect(mocks.lookup).toHaveBeenCalledTimes(1); expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('rejects unsafe resolved destinations before making an HTTPS request', async () => {
    mocks.lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(downloadPhoto('https://images.example.com/a.png')).rejects.toMatchObject({ status: 422 });
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
