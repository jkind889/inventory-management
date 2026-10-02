# Inventory management

A desktop-first collection and purchase tracker. Built with Next.js, React, TypeScript, Tailwind, Hono, Drizzle, and Supabase.

## Current foundation

- Hono API inside the Next.js Node runtime.
- Supabase Auth access-token verification and a restricted Postgres login.
- SQL migrations for profiles, categories, items, expenses, and idempotent purchase requests.
- Row-level security and same-owner foreign keys on all application tables.
- Atomic item/expense creation, existing-item entry, and date-based spending totals.
- Local integration tests covering real Auth, API requests, transactions, and account isolation.

The homepage is a placeholder. Collection/sign-in interfaces, photos, wishlist conversion, refunds, subscriptions, and check-ins are next. See [the build plan](docs/build-plan.md) for the product scope.

## Project connections

- Repository: https://github.com/jkind889/inventory-management
- Supabase project: `mkthxogkzllahenbrxle`
- Dashboard: https://supabase.com/dashboard/project/mkthxogkzllahenbrxle
- Application tables are in the **app** schema, not public. Select that schema in the table editor.

Three migrations have been applied to the hosted project. Local filenames match its migration history. The repository contains the application scaffold, migration history, and setup instructions.

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

The initial verification passed 15 tests, the production build, lint, and TypeScript. The schema also passed a clean local reset and cloud RLS checks with rolled-back fixtures. Supabase's security advisories are clear; remaining performance notices identify unused indexes on the empty database. The dependency audit is clear. A scoped esbuild override fixes an advisory in Drizzle Kit's development tooling; introspection was verified with that override.

## API

Every endpoint except health requires `Authorization: Bearer <Supabase access token>`. Identity comes from Supabase Auth, never the request body. Anonymous Auth accounts are not accepted.

| Endpoint | Purpose |
| --- | --- |
| GET /api/health | Process health; does not claim database readiness. |
| POST /api/profile/bootstrap | Create a profile and six starter categories once. Body: `{}` or currency/timezone preferences. |
| GET /api/categories | Active categories belonging to the account. |
| GET /api/items | Owned, unarchived items; `limit` and `offset` pagination. |
| POST /api/items | Existing item with name/category and optional acquisition date/description; no expense. |
| POST /api/purchases | Owned item plus expense, in one transaction. Requires a UUID `Idempotency-Key` header. |
| GET /api/transactions | Confirmed expenses, paginated. |
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

Generate one idempotency key per intended purchase, reuse it on retries, and use a new key for a different purchase. The first success returns 201; an identical retry returns 200 with `replayed: true`; a reused key with different content returns 409.

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
