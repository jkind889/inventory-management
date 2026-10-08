# Subscription reminders and item photos

Scope assessment: October 8, 2026. This is a proposal, not an implementation or a deployment. The user clarified that photos belong to items in this inventory app's collections.

Both features fit the existing architecture. Build them as separate releases: subscription tracking with in-app renewal reminders, and private item cover photos. Full charge confirmation and photo galleries can follow without making the first releases depend on them.

## What exists today

| Area | Current implementation | Missing work |
| --- | --- | --- |
| Subscriptions | A starter category, also added for existing accounts | Subscription records, billing dates, recurrence calculations, reminders, lifecycle controls |
| Item photos | Category SVG artwork; item details have no photo field | Storage configuration, photo records, upload/attachment/removal services, photo UI |
| Shared foundation | Verified Supabase Auth, account-scoped Hono/Drizzle services, profile timezone/currency, submission receipts | New contracts, migrations, operation types, and feature-specific checks |

Evidence: `src/shared/collection.ts`, `src/server/db/schema.ts`, `src/server/api/app.ts`, `src/server/services/inventory.ts`, and `src/features/collection/item-details.tsx`. The existing build plan already proposes `subscriptions` and `item_photos`, but neither appears in the current query models or checked-in migrations. Hosted Storage settings were not inspected in this assessment.

The original [build plan](build-plan.md) combines recurrence with confirmed charge accounting. The reminder-only release below is a smaller proposed first step; it does not replace that accounting design.

## Subscription reminders: first release

Let an account explicitly configure a subscription from an existing owned item, or create a subscription item and its metadata together. Do not automatically convert existing items based only on the Subscriptions category name. Never infer a billing date from the item's acquisition date.

Capture service name through the item, expected price in the account currency, monthly or yearly recurrence, billing anchor, next renewal date, an optional service/manage link, and reminder lead time. A proposed default is seven days before renewal, with an off option. These defaults are product proposals, not previously agreed requirements.

Show an Upcoming renewals section in the Subscriptions collection, ordered by date, with due today and overdue states. Refresh on app entry and after actions; derive today from the profile timezone. In-app reminders are visible while using the app and do not notify someone while it is closed.

Support editing the expected price/date/lead time, acknowledging a renewal without recording payment, and stopping reminders through cancellation. Preserve earlier expenses and item reviews. Make the acknowledgement label explicit: it updates tracking and does not claim a charge was paid. Do not offer a Paid action until confirmed-charge accounting exists.

Implementation boundaries:

- Add `app.subscriptions`, linked to an item through a same-owner foreign key, with one subscription per item. Include currency, expected amount, interval, anchor, next due date, reminder lead time, status, and effective end date. A cancelled subscription may retain reminders for periods through its recorded end date; later periods are suppressed. Constrain the item link and interval in SQL as well as the API.
- Add a small renewal acknowledgement history with a unique account/subscription/billing-period key. Acknowledgement and date advancement commit together. Repeated or stale submissions cannot accidentally advance two periods. For multiple overdue periods, advance one period at a time; a future explicit catch-up action can resolve several without fabricating spending.
- Implement pure recurrence calculations using the original anchor. January 31 becomes February's last day, then March 31; February 29 annual renewals recover their original day in leap years. Calendar dates must not drift with DST.
- Add authenticated list/create/edit/acknowledge/cancel endpoints and shared contracts. Use the existing submission receipt helper for creations and actions that advance dates, and conflict checks for stale edits. Keep domain tables in the private `app` schema.
- Extend item details and the Subscriptions collection with configuration and reminder controls. Existing generic Subscriptions items remain usable without metadata. Reminder counts are separate from spending totals.

This needs no background reminder scheduler. It is a medium-sized feature because the current category provides navigation but none of the recurrence model.

### Extensions after reminders

**Confirmed charges:** add `subscription_id` and `billing_period_on` to transactions, enforce same-owner links and at most one item/subscription target, and uniquely identify each confirmed subscription period. Confirm the actual amount and actual transaction date, record the expense, and advance recurrence atomically. Add skip-period behavior without an expense. Update history labels and spending links, which currently expect item-backed purchases. Expected prices and monthly equivalents must remain separate from actual spending. Keep manually entered historic subscription purchases intact; do not guess which periods they cover.

**Email or push:** add explicit notification preferences, a scheduler, a delivery provider, and durable delivery receipts/outbox handling. Deduplicate by account/subscription/period/channel/reminder offset, recheck eligibility after price/date/cancellation changes, and define how overdue reminders behave. Email delivery must be verified independently of existing Auth email configuration. Push adds browser permission and subscription lifecycle work. These are separate scope increments; provider and hosting choices need verification when implementing them.

**Broader recurrence:** weekly/custom intervals, free trials, temporary pauses, keep/cancel value check-ins, and snoozing individual reminders can follow.

## Item photos: first release

Start with one private cover photo per item. Add photo selection and preview to purchase, already-owned, and Future Wants forms, plus upload/replace/remove controls in existing item details. Show the cover in item details and relevant collection/wishlist thumbnails; retain category artwork as the fallback. The item photo follows the item when its category changes and can survive later wishlist conversion through the stable item ID.

Proposed limits: JPEG, PNG, or WebP; up to 5 MB per upload, with bounded decoded dimensions. Normalize orientation and strip location/EXIF metadata from the displayed asset. HEIC conversion, cropping, and multi-photo galleries are follow-up features. Validate actual image content server-side rather than trusting a filename or submitted MIME type; malformed or oversized files get a clear error.

Use private Supabase Storage with account-owned paths and short-lived signed read URLs. Private buckets support authenticated downloads or time-limited signed URLs, and bucket settings support size/type restrictions. See [Storage buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals) and [access control](https://supabase.com/docs/guides/storage/security/access-control).

Implementation boundaries:

- Add `app.item_photos` with same-owner item references, storage path, content metadata, and attachment state. Enforce one active cover per item for this release. Add upload-intent state for resumable application retries, quotas, and cleanup; gallery ordering can be introduced later.
- Configure the private bucket and explicit owner policies in migrations. Storage authorization uses verified Supabase Auth identity, while existing domain RLS uses transaction-local `app.user_id`; these are distinct mechanisms. Keep domain tables unexposed and all attachment/cover mutations behind Hono. Do not give browser policies unrestricted access to private domain tables just to validate paths.
- Keep Hono requests as small JSON metadata requests. Its current global body limit is 32 KB and `src/lib/api.ts` assumes JSON. Send image bytes directly to Storage under the user's session, then finalize through Hono after verifying the reserved path, owner, item, file existence, content, and size.
- Save the item/purchase first, then upload and attach. Upload failure must preserve the item and expense, show that the item was saved, and retry only the photo step. Retain the saved item ID and photo attempt key after an ambiguous failure; reloading can recover server-side pending metadata, but may require selecting the local file again.
- Use a reserved unique object path per upload intent, with no overwriting. On an ambiguous upload response, check the reserved object's content before attaching or resending. Finalization uses an idempotency receipt. A replacement uploads and validates the new asset before atomically changing the cover, with an expected-current-cover check to prevent stale concurrent replacement. Failed replacement leaves the old cover visible.
- Removal detaches the photo and schedules durable object cleanup; a cleanup failure cannot restore the attachment or delete a replacement. Clean up abandoned uploads after a grace period and account deletion as well as replaced assets. Delete bytes through the Storage API, not SQL. Cleanup work needs a retryable worker or explicit operational runner even though in-app reminders need no scheduler.
- Return durable photo IDs/paths, not expiring URLs, in saved mutation receipts. Sign fresh read URLs for current authenticated reads and refresh expired URLs; clear photo state on sign-out. Avoid a public cache for private images. Batch photo metadata reads rather than querying once per item.

Supabase recommends standard uploads for files up to 6 MB and unique replacement paths to avoid stale cached content. The proposed 5 MB cap fits that approach. See [standard uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads). Storage object deletion must use its API: [delete objects](https://supabase.com/docs/guides/storage/management/delete-objects).

This is a medium-sized feature. Storage authorization, image validation, and recovery across Storage/database failures are the main work; the file picker is a small portion. A gallery adds multiple-upload state, cover selection, ordering, and capacity controls.

## Verification and rollout

| Feature | Required acceptance checks |
| --- | --- |
| Reminders | Persist and reload; lead time/off; due/overdue; profile timezone; month-end/leap-year recurrence; effective cancellation date; retry/concurrent acknowledgement; stale edit conflict; no changes to spending; account isolation |
| Photos | Upload and reload; attach to owned/wishlist items; thumbnail/detail fallback; invalid types/content/size/dimensions; orientation/metadata handling; denied cross-account upload/read/attachment/removal; lost responses at each step; failed replacement preserves old cover; concurrent replacement conflict; expired URL recovery; cleanup retries; account deletion; unchanged item/spending counts |
| Both | Local migration reset, API/database integration checks, typecheck/lint/build, and desktop/mobile browser checks |

Implement and test additive SQL migrations locally before hosted rollout. Add new operation/result types to the existing receipt constraint and typed query model. Validate actual Storage access with separate test accounts, not only mocked API fixtures. Storage behavior must be verified alongside database behavior because the two systems cannot commit atomically.

Suggested delivery order: reminder model and calculations, reminder controls, photo storage and recovery, then photo form/detail integration. Photos can ship independently if they are the immediate priority. Confirmed-charge accounting, external notifications, and galleries remain separately estimable follow-up releases. These are relative scope assessments; no calendar estimate is justified until the release boundaries and notification/gallery choices are settled.
