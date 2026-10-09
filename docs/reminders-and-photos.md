# Subscription reminders and item photos

Scope assessment: October 8, 2026. Item cover photos are implemented; subscription reminders remain a proposal deferred until their external dependencies are ready. Photos belong to items in this inventory app's collections.

Both features fit the existing architecture. Build them as separate releases: subscription tracking with in-app renewal reminders, and private item cover photos. Full charge confirmation and photo galleries can follow without making the first releases depend on them.

## What exists today

| Area | Current implementation | Missing work |
| --- | --- | --- |
| Subscriptions | A starter category, also added for existing accounts | Subscription records, billing dates, recurrence calculations, reminders, lifecycle controls |
| Item photos | Private cover uploads and direct HTTPS imports, replacement/removal, Storage policies and retry recovery | Galleries, conversion, cropping, metadata stripping |
| Shared foundation | Verified Supabase Auth, account-scoped Hono/Drizzle services, profile timezone/currency, submission receipts | Subscription contracts, migrations, operation types, and feature-specific checks |

Evidence: `src/shared/collection.ts`, `src/server/db/schema.ts`, `src/server/api/app.ts`, `src/server/services/inventory.ts`, and `src/features/collection/item-details.tsx`. The build plan proposes `subscriptions` and `item_photos`. Subscriptions remain a proposal; item photos now appear in the query models and applied migration history. Hosted photo Storage settings have been verified.

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

## Item photos: implemented first release

The approved release is implemented. It supports one private cover per saved item, added from details only, with the exact 5,000,000-byte limit. Item-first authorization is enforced by both the API and Storage policies. File upload/direct HTTPS image import, replacement/removal, retry recovery, signed read URLs, and interaction-driven cleanup are included. Original accepted bytes are preserved; no metadata stripping or photo selection in item creation forms is included. See [item-photos.md](item-photos.md) for the current implementation, setup, API, verification, and limitations.

## Verification and rollout

| Feature | Required acceptance checks |
| --- | --- |
| Reminders | Persist and reload; lead time/off; due/overdue; profile timezone; month-end/leap-year recurrence; effective cancellation date; retry/concurrent acknowledgement; stale edit conflict; no changes to spending; account isolation |
| Photos | Upload and reload; attach to owned/wishlist items; overview/detail fallback; invalid types/content/size/dimensions; preserve original bytes; denied cross-account upload/read/attachment/removal; lost responses at each step; failed replacement preserves old cover; concurrent replacement conflict; expired URL recovery; cleanup retries; unchanged item/spending counts. Future account deletion flows must clean Storage before cascading metadata. |
| Both | Local migration reset, API/database integration checks, typecheck/lint/build, and desktop/mobile browser checks |

Implement and test additive SQL migrations locally before hosted rollout. Add new operation/result types to the existing receipt constraint and typed query model. Validate actual Storage access with separate test accounts, not only mocked API fixtures. Storage behavior must be verified alongside database behavior because the two systems cannot commit atomically.

Item cover photos were implemented first, independently of reminders. Subscription reminders are deferred. Confirmed-charge accounting, external notifications, and galleries remain separately estimable follow-up releases. No calendar estimate is justified until those release boundaries and dependency choices are settled.
