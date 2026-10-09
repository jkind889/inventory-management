# Collection app: data model and first build

Status: backend foundation, sign-in, collection interface, and a read-only monthly Spending view are implemented. See README.md for tested endpoints and setup. Collections now has an editorial category overview with two recent purchased items per category, and Future Wants supports persistent wishlist creation and browsing. Spending includes category totals, date-filtered pagination, and linked item details; standalone expense entry, wishlist-to-purchase conversion, refunds/sales, recurring subscription billing, and suggested check-in dates remain future slices. Private cover photos are implemented as described in [item-photos.md](item-photos.md). Subscriptions is now a starter category; persistent item value check-ins are implemented as described in [item-worth.md](item-worth.md).

## Product scope

A desktop-first personal web app whose home screen is the collection. Track tech, clothes, hobbies, and furniture individually; record groceries as quick expenses and subscriptions as recurring commitments. Connect spending to reflections about usefulness and enjoyment.

Agreed stack: Next.js, React, TypeScript, Tailwind CSS, Hono, Drizzle ORM, Supabase Postgres/Auth/Storage, and Vercel.

Initial assumptions: one private collection per account, manual entry, one reporting currency per account, and in-app check-ins. USD is a proposed initial default, selectable at onboarding. Shared collections, bank connections, receipt scanning, currency conversion, and external notifications are later scope.

## Data model

Use UUID identifiers. User-owned tables carry `user_id` referencing Supabase Auth and creation/update timestamps. Calendar dates use `date`; audit timestamps use `timestamptz`. Foreign keys between user-owned records must enforce matching ownership, using composite references where appropriate.

| Table | Main fields | Purpose |
| --- | --- | --- |
| profiles | user_id, display_name, currency, timezone | Preferences; Auth remains the source of identity. |
| categories | id, user_id, name, archived_at | Seed Tech, Clothes, Hobbies, Furniture, Subscriptions, Groceries, and Other per user; allow changes. |
| items | id, user_id, category_id, name, description, state, acquired_on, condition, product_url, target_amount_minor, priority, archived_at | One record per separately tracked possession or wishlist candidate. |
| transactions | id, user_id, category_id, item_id?, subscription_id?, refund_of_id?, kind, amount_minor, currency, occurred_on, merchant?, note?, billing_period_on? | Confirmed expenses, refunds, and sale proceeds. An entry may reference an item, a subscription, or neither, but not both. |
| subscriptions | id, user_id, category_id, name, amount_minor, currency, interval_unit, interval_count, billing_anchor_on, next_due_on, status, ends_on?, service_url?, archived_at | Recurrence rules and expected prices. Confirmed charges remain separate transaction records. |
| item_reviews (implemented) | id, user_id, item_id, verdict, usage_frequency?, would_buy_again?, note?, created_at | Append-only item value check-ins; latest 20 shown in details. |
| check_ins (future extension) | id, user_id, item_id?, subscription_id?, checked_on, usage, satisfaction, would_buy_again?, keep_subscription?, note? | Dated reflections linked to exactly one item or subscription. |
| item_photos (implemented) | id, user_id, item_id, storage_path, status, byte_size, mime_type, checksum, expected_cover_id, width, height, expires_at, cleanup_checked_at | One private cover and one pending upload per saved item; galleries/order are later scope. |
| operations | id, user_id, idempotency_key, operation_type, request_hash, result_reference | Prevent duplicate compound writes when the client retries. |

Items use these initial states: `wishlist`, `owned`, `sold`, `returned`, and `donated`. Archiving hides a record without rewriting its ownership or spending history. Additional usage states such as stored/lent out can follow once the core flow works.

Wishlist target prices are estimates and never count as expenses. Purchasing a wishlist item preserves its ID, links, notes, and photos, changes its state to owned, and creates a transaction. Historical items may have an unknown acquisition date and no transaction; never invent a date or a zero price to fill a gap.

## Money rules

- Store money as integer minor units with a currency code; parse decimal input without floating-point arithmetic. Bound accepted values and totals to the safe range used by the implementation.
- Initially accept only the account's reporting currency. Once financial records exist, block casually changing that currency; do not relabel existing amounts.
- `kind` is `expense`, `refund`, or `sale`; amounts are positive and direction comes from kind. Zero-priced acquisitions create an item without an expense.
- Gross spending is expenses in the selected period. Show refunds and sale proceeds separately; net outflow is expenses minus refunds minus sale proceeds. Filter each by its actual transaction date.
- Transaction categories are recorded independently of current item categories. Reclassifying an item must not silently rewrite spending history.
- Refunds link to an original expense. Validate matching owner, currency, and target, and prevent cumulative refunds exceeding that expense. A partial refund does not automatically mark an item returned.
- Item net cost is linked expenses minus refunds minus sale proceeds across its lifetime. Negative net cost is possible and should be displayed honestly.
- Ordinary item edits, archiving, and category archiving must not delete transactions. Explicit transaction corrections are separate actions.
- Keep subscription monthly-equivalent estimates separate from actual cash spending. A yearly fee is an expense when confirmed, not twelve invented monthly transactions.
- Currency values, recurrence intervals, ownership links, and target cardinality receive database constraints as well as API validation.

## Subscription and value behavior

Show subscriptions due for confirmation when the app opens. Confirming a charge records the actual amount and billing period, then advances the next due date atomically. A unique user/subscription/billing-period constraint prevents confirming the same charge twice. Also allow skipping a period without claiming money was spent.

Calculate recurrence from the original billing anchor, clamping short months without permanent date drift: a January 31 monthly anchor gives February's last day, then March 31. Price edits affect future expectations; past confirmed charges retain their recorded amounts. Cancelled subscriptions stop producing future expected charges after their recorded effective end date.

The initial item check-in records a verdict (`worth_it`, `not_worth_it`, `unsure`), optional usage (`daily`, `weekly`, `monthly`, `rarely`, `never`), and an optional yes/no/unsure repurchase answer. Satisfaction ratings can be added later. Subscriptions get a keep/cancel/unsure answer. Calculate suggested check-ins from acquisition dates and the latest reflection when opening the app; a background scheduler is unnecessary for this initial behavior.

Show these answers separately. Do not calculate cost per use from a qualitative usage answer, or invent a universal value score.

## Backend organization

```text
src/
  app/                         Next.js pages and the Hono API entry point
  components/                  Shared interface components
  features/                    Collection, purchases, subscriptions, check-ins
  server/
    api/                       Hono routes, validation, auth middleware
    services/                  Business operations and transaction boundaries
    db/                        Drizzle schema, connection, user-scoped queries
  shared/                      Request/response contracts and pure calculations
supabase/
  migrations/                  The sole migration history
```

Run Hono in the Next.js Node.js runtime. All domain reads and writes go through Hono and shared services. Use Drizzle transactions for operations that affect multiple records. Keep connection details and administrative credentials server-side.

Use Supabase CLI SQL migrations as the single migration authority, including roles, policies, constraints, and Storage configuration. Maintain Drizzle's typed schema from the migrated database, using introspection as a starting point. Do not also run a competing Drizzle migration history or push schema changes directly to production. Verify migrations against a clean local database before deployment.

Hono verifies the Supabase session and derives identity from the verified token, never a submitted user ID. For Drizzle queries, use a restricted non-owner database role without BYPASSRLS, and set verified user context transaction-locally before querying. Policies enforce row ownership using that context; never rely on Supabase automatically forwarding identity into a direct SQL connection. Use explicit owner filters and same-owner foreign keys as additional checks.

Keep domain tables in an unexposed application schema with RLS enabled. Storage uses its own policies and verified Auth identity, with private paths scoped to the user. Runtime and migration credentials are separate. For Vercel, configure the appropriate pooled database connection and ensure driver settings match the pool mode.

Initial indexes follow actual access paths: items by owner/state and owner/category, transactions by owner/date and linked target, check-ins by owner/target/date, and subscriptions by owner/status/due date. Index foreign-key access paths and enforce unique owner/idempotency keys.

## First working slice

1. Sign in and open the empty collection.
2. Choose Add purchase; enter name, category, amount, and purchase date, with no photo in the creation form. Add a photo from details after saving.
3. Submit one authenticated request. Validate input, claim an idempotency key, and insert an owned item plus its expense in a single database transaction.
4. Return the saved records and update the collection. Reloading must preserve the result.
5. Show the same expense in the spending list and monthly category totals.
6. Offer Add existing item separately, requiring only a name and category; an optional known historical purchase can be recorded explicitly.

Photo upload is a separate retriable step after the item exists. If it fails, preserve the item and expense and offer a retry. Do not present Storage upload as part of a Postgres transaction. Attach only objects owned by the signed-in user and clean up abandoned uploads.

Initial API surface:

| Route | Behavior |
| --- | --- |
| GET /api/items | Paginated collection with search, category, and state filters. |
| GET /api/items/:id | Item details and linked costs. |
| POST /api/items | Add an existing possession without implicitly recording spending. |
| POST /api/purchases | Create an owned item and expense atomically; require an idempotency key. |
| POST /api/items/:id/photo/uploads | Reserve a private upload after verifying the saved item. |
| POST /api/items/:id/photo/imports | Import validated original bytes from a direct HTTPS image link into a private reservation. |
| POST /api/items/:id/photo/uploads/:uploadId/complete | Verify the uploaded bytes and attach/replace the private cover. |
| DELETE /api/items/:id/photo | Detach the expected cover and clean up Storage separately. |
| GET /api/transactions | Paginated actual spending records for a date range. |
| GET /api/spending/summary | Gross spending, refunds, sale proceeds, net outflow, and category breakdown. |

## Acceptance checks and subsequent slices

The first slice is complete when a purchase persists across reloads and appears exactly once in the collection and spending, failed database writes leave neither half behind, retries do not duplicate it, existing possessions do not create phantom spending, and one account cannot access another account's records or photos. Include tests for invalid amounts, calendar boundaries, unauthenticated requests, and cross-owner references. Verify the main flow in a browser.

Then implement, in order: wishlist conversion; item editing and ownership changes with refunds/sales; subscription confirmation and recurrence; check-ins; and data export. Test each slice's financial and access-control behavior when it is introduced.

## Technical references

- [Hono in Next.js](https://hono.dev/docs/getting-started/nextjs)
- [Drizzle transactions](https://orm.drizzle.team/docs/transactions)
- [Drizzle database introspection](https://orm.drizzle.team/docs/drizzle-kit-pull)
- [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase database connections](https://supabase.com/docs/guides/database/connecting-to-postgres)
