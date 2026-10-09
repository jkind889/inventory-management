# Inventory management

A desktop-first collection and purchase tracker. Built with Next.js, React, TypeScript, Tailwind, Hono, Drizzle, and Supabase.

## Current foundation

- Hono API inside the Next.js Node runtime.
- Supabase Auth access-token verification and a restricted Postgres login.
- SQL migrations for profiles, categories, items, expenses, and idempotent purchase/existing-item requests.
- Row-level security and same-owner foreign keys on all application tables.
- Atomic item/expense creation, existing-item entry, and date-based spending totals.
- Local integration tests covering real Auth, API requests, transactions, and account isolation.

The homepage now includes email sign-in, account creation, password-reset screens, and a responsive collection interface. Search, category filters, sorting, grid/list views, item details, new purchases, and existing-item entry use the authenticated Hono API. The Spending view shows a selected month’s total, category breakdown, and paginated purchase history with linked item details. The collection home groups categories into editorial blocks with the two latest distinct purchased items by actual transaction date. Future Wants saves wishlist entries with optional estimated prices, product links, notes, and priority; these do not affect owned-item counts or spending. Subscriptions is available as a category, and item details supports saved value check-ins with verdict, usage, repurchase intent, notes, and history. Private item cover photos are implemented: save an item first, then add, replace, or remove its photo from details using a file or a direct HTTPS image link. The enforced limit is 5,000,000 bytes. Wishlist-to-purchase conversion, refunds, recurring subscription billing, and suggested check-in dates are next. See [item photos](docs/item-photos.md). See [item value check-ins](docs/item-worth.md). See [the build plan](docs/build-plan.md) for the product scope.

## Project connections

- Repository: https://github.com/jkind889/inventory-management
- Supabase project: `mkthxogkzllahenbrxle`
- Dashboard: https://supabase.com/dashboard/project/mkthxogkzllahenbrxle
- Application tables are in the **app** schema, not public. Select that schema in the table editor.

Seven migrations have been applied to the hosted project, including retry receipts for existing-item creation, item value check-ins, private item-photo Storage policies, and direct image imports. Local filenames match its migration history. The repository contains the application scaffold, migration history, and setup instructions.

The hosted URL, publishable key, and restricted `inventory_runtime` connection are configured in the ignored `.env.local`. The connection uses `aws-0-us-east-1.pooler.supabase.com:6543` with a generated password kept out of Git. TLS verifies the certificate chain and hostname using the official Supabase root CA bundled in `src/server/db/supabase-ca.ts`. Run `npm run db:check` for a read-only hosted connection check. Supabase CLI authentication/linking is separate from the connected Supabase tool used to apply these migrations.

## Local development

Requires Node 22+ and Docker running.

```sh
npm ci
npm run db:start
npm run db:setup:local
```

The setup script creates a random password for the local `inventory_runtime` role and writes `.env.test.local`. It does not change cloud credentials. Rerun it after a local database reset.

For a fully local app, back up an existing `.env.local` before replacing it with `.env.test.local`, then start the app:

```sh
npm run dev
```

Open http://localhost:3000. The API lives under `/api`. Auth comes from whichever Supabase URL is configured in `.env.local`; keep its database and Auth project consistent.

Webpack is selected for dev/build because Turbopack's CSS subprocess could not bind its internal port in this execution environment. This can be revisited on another machine.

## Verification

```sh
npm run db:check
npm run typecheck
npm run lint
npm test
npm run db:test
npm run build
```

`npm test` runs API boundary tests and includes database integration tests when `.env.test.local` exists. `npm run db:test` requires the local test environment and fails if it is missing. Integration tests refuse remote database hosts, create temporary accounts, and remove them afterward.

`npm run test:collection-home` verifies the new collection blocks, drill-down, category-specific Add Item, Spending, wishlist creation/retry/reload, error recovery, and desktop/tablet/mobile layouts with isolated API fixtures. It uses the same Playwright environment options as the search regression.

`npm run test:collection-ui` runs the collection search/loading browser regression
against an already-running local app (default `http://localhost:3000`). It uses
isolated Auth/API fixtures and an existing Playwright installation with installed
Chrome; it changes no account data. If Playwright is bundled outside this project,
set `PLAYWRIGHT_MODULE_PATH` to its `playwright/index.js`. Set `UI_TEST_BASE_URL`
for another loopback URL, `UI_TEST_BROWSER_CHANNEL` for another installed browser,
or `UI_TEST_EVIDENCE_DIR` for screenshots (default `/tmp/inventory-collection-search`).

The current verification passed 66 unit/API/database tests, real local Auth/Storage checks, a real HTTPS image download, the collection browser regressions, item-photo/direct-link desktop/mobile checks, the production build, lint, and TypeScript. The schema passed a clean local reset, and hosted photo bucket/RLS/grants and import receipts were verified after migration. Auth retains its existing leaked-password-protection advisory (see [item photo notes](docs/item-photos.md)); remaining performance notices identify unused indexes on the empty database. The production dependency audit is clear; Next ESLint tooling has a pre-existing development-only braces advisory. A scoped esbuild override fixes an advisory in Drizzle Kit's development tooling; introspection was verified with that override.

## API

Every endpoint except health requires `Authorization: Bearer <Supabase access token>`. Identity comes from Supabase Auth, never the request body. Anonymous Auth accounts are not accepted.

| Endpoint | Purpose |
| --- | --- |
| GET /api/health | Process health; does not claim database readiness. |
| POST /api/profile/bootstrap | Create a profile and seven starter categories once. Body: `{}` or currency/timezone preferences. |
| GET /api/categories | Active categories belonging to the account. |
| GET /api/collections/overview | Active categories, owned-item counts, and the two latest purchased items per category across all records. |
| GET /api/wants | Account-scoped wishlist, priority-first ordering, and `limit`/`offset` pagination. |
| POST /api/wants | Save a wishlist entry without an expense; requires a UUID `Idempotency-Key` header. |
| GET /api/collection | Owned collection with exact recorded costs, total count, `q`, `categoryId`, `sort` (newest/name/purchased), `limit`, and `offset`. |
| GET /api/items/:id | Account-scoped item, purchase records, up to 20 latest value check-ins, private cover and pending upload. |
| POST /api/items/:id/photo/uploads | Reserve one private upload for an existing account-owned item; requires an idempotency key. |
| POST /api/items/:id/photo/imports | Import a direct HTTPS image into a private reservation; requires an idempotency key. |
| POST /api/items/:id/photo/uploads/:uploadId/complete | Validate uploaded bytes and atomically attach/replace the cover; requires an idempotency key. |
| DELETE /api/items/:id/photo | Detach the expected cover and retry Storage cleanup; requires an idempotency key. |
| POST /api/items/:id/reviews | Append a value check-in with verdict, usage, repurchase intent and notes; requires an idempotency key. |
| GET /api/items | Owned, unarchived items; `limit` and `offset` pagination. |
| POST /api/items | Existing item with name/category and optional acquisition date/description; no expense. Requires a UUID `Idempotency-Key` header. |
| POST /api/purchases | Owned item plus expense, in one transaction. Requires a UUID `Idempotency-Key` header. |
| GET /api/transactions | Confirmed expenses with item/category names and total count; `limit`/`offset` pagination and optional paired `from`/`to` dates (inclusive). |
| GET /api/spending/summary?from=2026-10-01&to=2026-10-31 | Inclusive calendar-date spending total and category breakdown. |

Example purchase body:

```json
{
  "name": "Headphones",
  "categoryId": "<UUID from GET /api/categories>",
  "amountMinor": 19999,
  "currency": "USD",
  "occurredOn": "2026-10-01"
}
```

Generate one idempotency key per intended purchase or existing-item entry, reuse it on retries, and use a new key for a separate intended submission. The first success returns 201; an identical retry returns 200 with `replayed: true`; a reused key with different content or operation type returns 409. All future mutations that could repeat an effect follow the [submission retry baseline](docs/submission-retries.md).

Amounts are integer minor units. Supported initial currencies are USD, EUR, GBP, CAD, and AUD; one per account, with no conversion. Spending aggregates are integer strings to avoid precision loss. Zero-cost possessions use existing-item entry. Refund/sale transactions are intentionally disallowed until their accounting behavior is implemented.

## Database workflow

SQL files in `supabase/migrations` are the sole migration authority. Drizzle's schema is a query model; it does not manage migrations. Do not use `drizzle-kit push` or apply generated introspection SQL.

```sh
npx supabase migration new descriptive_name
# Edit and validate locally before applying to a hosted project.
npm run db:reset
npm run db:setup:local
npm run db:test
```

`npm run db:types` introspects the database into the ignored `drizzle-introspection` directory. Set `DATABASE_ADMIN_URL` locally for full introspection, then review the output and update `src/server/db/schema.ts`. Never use an administrative connection for application traffic.

Each application query runs in a transaction with transaction-local verified identity. The runtime role has no bypass-RLS, role-management, or DDL rights. The private schema has no browser Data API grants. Profiles/categories/items permit scoped updates; expense and operation records are insert/read only at this stage. Credentials remain in ignored environment files.

## Sign-in configuration

Use the Supabase publishable key in the browser; the restricted database connection stays server-only. Sessions persist in the browser and API requests carry the access token; Hono verifies it before running account-scoped queries. Signing out clears the collection UI.

Set Supabase Auth's Site URL to the deployed app origin and allow its callback URLs, including `/?mode=recovery`; allow `http://localhost:3000` and its recovery URL for local development. Account creation can require email confirmation depending on the project configuration. Confirmation and password recovery depend on Supabase email delivery; production email delivery has not been verified in this UI pass. Use an appropriate SMTP provider before relying on production email flows.

The collection creates a profile and seven starter categories on first sign-in. New accounts choose one reporting currency. New purchases create spending; “Already owned” creates only an item. Unknown prices/dates are explicitly labeled. Category artwork is the fallback for items without a private cover photo.

## Spending view

After signing in, choose **Spending** in the sidebar or mobile navigation. The initial month uses the account timezone. Month controls update both the total and history using actual purchase dates, including the first and last calendar day. History pages show 10 transactions; totals always include the full selected month. Existing possessions without expenses do not affect totals. Archived items/categories retain their spending records. This first spending slice is read-only; quick-expense entry, corrections, refunds, and recurring subscription charges remain future work.

## Editorial layout and Future Wants

The signed-in app uses three top tabs: Collections, Spending, and Future Wants. Collection blocks remain visible with zero or one purchase. Existing possessions count toward a collection but do not displace recent purchased items. Item panels support uploaded private covers, with labeled category artwork as the fallback. See [the visual spec and verification notes](docs/design/collections.md).

Wishlist writes use the existing item-only `existing_item` receipt type, with `state: wishlist` in the validated receipt payload. This keeps the existing migration and old owned-item hashes intact, distinguishes submission content across the two flows, and commits the item and receipt together. No schema change is needed. The first write returns 201; identical retries return 200; conflicting content returns 409. Wishlist conversion, editing, and removal are not included in this styling slice.
