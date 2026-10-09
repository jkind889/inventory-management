# Private item cover photos

Implemented October 8, 2026. Each saved owned item or Future Want can have one private cover. Open its details, choose **Add photo**, select a file, inspect the preview, and choose **Upload**. **Replace photo** keeps the previous cover until the new one validates and saves. **Remove photo** affects only the cover. Item creation forms and compact text-based item lists are unchanged. The existing collection-overview component uses covers in its artwork slots; the current homepage remains the workbench.

Alternatively, choose **Paste image link**, enter a direct HTTPS image URL, and choose **Import photo**. The server downloads and validates the image, stores a private copy, and uses the same completion flow. The source URL is never used as the displayed cover or fetched by the browser.

## Direct image links

A link must return HTTP 200 with JPEG, PNG, or static WebP bytes directly. An image filename extension is not required. Webpages, provider sharing pages, redirects, HTTP links, embedded URL credentials, fragments, custom ports, and compressed HTTP bodies are rejected. Links requiring cookies or authentication are not supported. Signed query-string image URLs are accepted when they return the image directly; the private copy survives expiry of the source link.

The downloader has a 15-second total DNS/connect/read deadline and an 8 KB response-header limit. It rejects reported lengths above 5,000,000 bytes and stops streaming at that limit even without a Content-Length. `ipaddr.js@2.5.0` classifies DNS results; any nonpublic answer rejects the destination. IPv4/IPv6 loopback, private/link-local/reserved ranges, mapped IPv6, and transition networks are blocked. The HTTPS socket is pinned to the validated address while retaining the original Host/SNI and certificate validation. Redirects are never followed. No user cookies, bearer token, or Supabase credentials are forwarded to the source.

The item and expected cover are checked before fetching. Downloading/validating and reservation creation are serialized by the shared account/key receipt helper; Storage writes occur after the reservation commits. An import receipt stores durable upload metadata, not the source URL or a signed read URL. A retry first verifies the stored object. If the first write failed, a source re-download must match the original checksum before an immutable upload can proceed. A changing source cannot change an existing attempt; cancel the link and start a new import to select new content. Validation failures roll back the receipt/reservation and preserve existing covers. Storage-write failures leave a recoverable reservation, and the old cover remains attached until completion succeeds.

## Limits and item-first enforcement

Accept JPEG, PNG, and static WebP. The limit is exactly **5,000,000 bytes**, including the uploaded file's original metadata. The browser, reservation API, Storage bucket, completion service, and SQL metadata constraints enforce the same limit. Empty files are rejected. Sharp verifies checksum, actual decoded format, dimensions up to 40 million pixels, and complete decodability before attachment. Original accepted bytes are preserved. HEIC conversion, cropping, compression, metadata removal, and galleries are not implemented.

The item must already exist, belong to the verified account, and be unarchived before a reservation is issued. A reservation owns exactly one immutable `account/item/photo` path. Storage INSERT policy checks that exact reservation, its expiry, and the existing item again. Inventing a path, item ID, or another account's path does not grant upload access. No Storage UPDATE policy exists, so overwrites and moves are denied.

`app.item_photos` has same-owner item foreign keys, forced RLS, one active-cover index, and one pending-upload index. The runtime uses transaction-local verified identity as before. Storage evaluates its verified JWT identity through the narrow `app.photo_storage_allowed` boolean helper. The helper's dedicated role cannot log in, create schema objects, write records, or bypass RLS. Browser roles cannot access the application schema or tables; Storage's stored policies can execute the helper without opening domain-table access. No additional server secret or media provider is required.

## API

All routes require the existing verified Supabase bearer session. Mutations require a UUID `Idempotency-Key` and strict JSON bodies; photos are never sent through Hono's 32 KB JSON boundary.

| Route | Body/result |
| --- | --- |
| `POST /api/items/:id/photo/uploads` | `{byteSize, mimeType, checksum, expectedCoverId}`; returns reserved upload metadata/path. Checksum is lowercase SHA-256; expected cover is a UUID or null. |
| `POST /api/items/:id/photo/imports` | `{url, expectedCoverId}`; verifies/downloads a direct image and writes it to its reservation; returns upload metadata for the existing completion endpoint. |
| `POST /api/items/:id/photo/uploads/:uploadId/complete` | `{}`; reads/verifies Storage bytes and returns `{photoId, replayed}` after atomic cover attachment. |
| `DELETE /api/items/:id/photo` | `{expectedCoverId}`; returns `{removedPhotoId, replayed}` after atomic detachment. |
| `GET /api/items/:id` | Adds nullable `cover` and `pendingPhoto` to existing item, transaction, and review fields. |
| `GET /api/collections/overview` | Each recent item adds nullable `cover`, with batched photo metadata/signing. |

Reservation/completion return 201 on first success, 200 on an identical retry. Removal returns 200. Conflicting receipt content or stale expected covers return 409. Missing/inaccessible items return 404; byte/content validation failures return 422. Cover metadata includes dimensions and a signed URL expiring after 15 minutes. Expiring URLs are not saved in operation receipts. Storage access problems degrade to category artwork without hiding the item; **Reload photo** retries a missing signed URL. Displayed URLs refresh on expiry, foreground return, or an initial image error. Private images use unoptimized rendering rather than a shared Next image cache.

## Retry, replacement, and cleanup

The browser keeps reservation/completion/removal attempts while the panel stays mounted, using the shared submission helper. Upload progress uses the existing account session and direct Storage requests. A lost Storage response or already-existing object leads to completion verification; a checksum mismatch never replaces the cover. Lost completion/removal responses replay the same operation receipt. Changing item or signing out aborts outstanding client requests and clears local previews/attempts.

Closing/reloading the panel may require selecting the local file again. Matching checksum/size/type/expected-cover reservations are recovered server-side for 24 hours. Choosing different content retires the prior pending reservation before creating another. Expired or superseded reservations cannot complete. Replacement/removal compare the expected current cover, so a stale action cannot overwrite a newer one.

Old covers are retired only when attachment/removal commits. Storage deletion is separate from SQL and uses the Storage API. Retired metadata remains as a tombstone for retries and reconciliation of late writes. Cleanup expires pending records and attempts up to 25 retired objects per authenticated photo interaction, rotating attempts so failures cannot starve later objects. It runs on item-detail reads and photo mutations. Deletion failures do not undo saved covers/removals. No scheduler is installed; leftovers for inactive accounts wait for the account to return. Account deletion and item deletion are not app features in this slice; future deletion flows must arrange Storage cleanup before cascading photo metadata.

## Setup and rollout

Migration `20261008221402_item_cover_photos.sql` creates the table, helper role, policies, receipt operation types, and private `item-photos` bucket. It is applied to the connected Supabase project and the local database. Apply it before deploying these API changes to another project. Use the normal private-schema migration workflow; no direct browser Data API grants or Storage admin key should be added.

Migration `20261009013445_item_photo_imports.sql` adds `photo_import` to the receipt operation constraint. It is also applied locally and to the connected project; apply it before enabling the import endpoint in another environment. Existing bucket restrictions, RLS, and private access policies are reused.

Local verification requires Supabase Auth, database, gateway, REST, and **Storage** services. Do not exclude `storage-api` from `supabase start`. Run `npm run db:reset`, `npm run db:setup:local`, and `npm test`; `.env.test.local` must point entirely to loopback services. Tests create temporary accounts and remove their Storage objects before deleting those accounts. The production build can run in a temporary source copy to avoid changing a running development server's build directory.

## Verification and existing advisories

All 66 unit/API/database tests pass, along with TypeScript, lint, a production build, and the browser checks below. Both photo migrations pass a clean local database reset.

Unit/API checks cover the exact byte boundary, unsupported/empty files, checksum and actual MIME mismatches, corrupt/oversized decoded images, animated WebP, strict input, authentication, and retry keys. Real Auth/database/Storage checks cover private reads, item-first enforcement including archiving after reservation, immutable uploads, cross-account reads/writes/removal, account-scoped keys, concurrent/sequential replay, validation rollback, stale covers, expiration, cleanup recovery, owned/wishlist covers, signed overview reads, and preserved item/spending records.

Desktop/mobile Playwright checks use isolated fixtures and installed Chrome because the Browser plugin is not available. They exercise preview/upload, replacement failure retaining the old cover, lost save/remove responses, reload, expired-URL refresh, item switching, rejected file sizes/formats, and layout/console checks. Screenshots and the temporary photo browser runner are kept outside the repository under `/tmp/inventory-item-photos*`. Existing collection/home/search browser regressions also pass.

Direct-link checks add URL validation, mixed/private DNS rejection, pinned lookup, redirects/HTML/encoding rejection, streaming limits, item-first fetching, real private Storage writes, concurrent/account-scoped retry receipts, rollback, changed-source detection, and ambiguous-write recovery. A real public HTTPS PNG download also passes with the pinned socket. Desktop 1536×1024 and mobile 390×844 fixtures verify link import/replacement, webpage errors preserving the old cover, lost-response retries, switching items, wishlist imports, and reload. URL-field contrast was corrected after screenshot inspection. Evidence is in `/tmp/inventory-item-links`. These browser flows use fixtures; temporary-account integration tests use real local Auth/database/Storage with injected source bytes, and the HTTPS smoke check exercises the actual external downloader separately.

Hosted security checks show forced RLS, denied browser schema/table access, three scoped Storage policies, the exact private bucket limit/types, and a non-login/non-superuser helper role without RLS bypass or schema CREATE rights. The existing Auth advisory remains [leaked password protection disabled](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). The dependency audit identifies the pre-existing development-only `braces@3.0.3` advisory through Next's ESLint tooling; the production dependency audit has no findings. This feature does not change Auth configuration or unrelated lint dependencies.
