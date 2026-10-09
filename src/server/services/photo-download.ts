import 'server-only';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { HTTPException } from 'hono/http-exception';
import { isDirectPhotoUrl, PHOTO_MAX_BYTES, photoMimeTypes } from '../../shared/photos';

export type DownloadedPhoto = { bytes: Buffer; mimeType: typeof photoMimeTypes[number] };
export type PhotoDownloader = (url: string) => Promise<DownloadedPhoto>;
type Address = { address: string; family: number };

export function isPublicPhotoAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const parsed = ipaddr.parse(address);
  // Reject IPv4-mapped IPv6, transition networks, metadata, loopback,
  // private, link-local, multicast, documentation and reserved ranges.
  if (parsed.range() !== 'unicast') return false;
  return parsed.kind() === 'ipv4' || parsed.match(ipaddr.parse('2000::'), 3);
}

export async function resolvePhotoAddress(host: string, signal: AbortSignal,
  resolve: (hostname: string) => Promise<Address[]> = hostname => lookup(hostname, { all: true, verbatim: true }),
): Promise<Address> {
  const hostname = host.replace(/^\[|\]$/g, '');
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
      resolve(hostname),
      new Promise<never>((_, reject) => { abort = () => reject(new Error('Timeout')); signal.addEventListener('abort', abort, { once: true }); }),
    ]);
    if (!addresses.length || addresses.some(row => !isPublicPhotoAddress(row.address))) throw new Error('Unsafe destination');
    return addresses[0];
  } catch {
    throw new HTTPException(422, { message: 'Use a reachable public HTTPS image link.' });
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

// Consume bounded original bytes; reject compressed HTTP bodies rather than
// introducing a second decompression limit or changing the accepted file.
export async function readPhotoResponse(response: AsyncIterable<Uint8Array> & {
  statusCode?: number; headers: { [key: string]: string | string[] | undefined };
}): Promise<DownloadedPhoto> {
  if (response.statusCode !== 200) {
    throw new HTTPException(422, { message: 'This link must return an image directly. Redirects, sharing pages, and unavailable links are not supported.' });
  }
  const mimeType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!(photoMimeTypes as readonly string[]).includes(mimeType)) throw new HTTPException(422, { message: 'This link must return a JPEG, PNG, or static WebP image, not a webpage.' });
  const encoding = response.headers['content-encoding'];
  if (encoding && encoding !== 'identity') throw new HTTPException(422, { message: 'This link uses an unsupported HTTP encoding. Use a direct image file link.' });
  const length = response.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) < 1 || Number(length) > PHOTO_MAX_BYTES)) {
    throw new HTTPException(422, { message: 'Photos must be non-empty and 5 MB or smaller (5,000,000 bytes).' });
  }
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    total += chunk.byteLength;
    if (total > PHOTO_MAX_BYTES) throw new HTTPException(422, { message: 'Photos must be 5 MB or smaller (5,000,000 bytes).' });
    chunks.push(Buffer.from(chunk));
  }
  if (!total || (length !== undefined && total !== Number(length))) throw new HTTPException(422, { message: 'The image download was empty or incomplete. Try another direct link.' });
  return { bytes: Buffer.concat(chunks, total), mimeType: mimeType as DownloadedPhoto['mimeType'] };
}

export const downloadPhoto: PhotoDownloader = async value => {
  if (!isDirectPhotoUrl(value)) throw new HTTPException(422, { message: 'Use a direct HTTPS image link.' });
  const url = new URL(value), signal = AbortSignal.timeout(15_000);
  const target = await resolvePhotoAddress(url.hostname, signal);
  try {
    return await new Promise<DownloadedPhoto>((resolve, reject) => {
      // Preserve the original Host/SNI/certificate checks, but pin the socket to
      // the already-validated IP. Disable pooled sockets and a second DNS lookup.
      const req = request(url, {
        agent: false, family: target.family, signal, maxHeaderSize: 8192,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [target]); else callback(null, target.address, target.family);
        },
        headers: { Accept: photoMimeTypes.join(', '), 'Accept-Encoding': 'identity' },
      }, response => {
        readPhotoResponse(response).then(resolve, reject).finally(() => response.destroy());
      });
      req.on('error', reject);
      req.end();
    });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(422, { message: 'The image could not be downloaded within 15 seconds. Check the direct link and retry.' });
  }
};
