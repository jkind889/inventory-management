# Item tags

Owned items and Future Wants share an account-owned tag vocabulary across all
collections. Each item may have zero to five tags. Names normalize to lowercase,
trim surrounding whitespace, and collapse whitespace runs to a single space.
Names must contain 1–30 Unicode code points after normalization; control
characters and duplicate normalized names are rejected. No text is truncated.

All creation forms include a picker with existing suggestions, explicit Create,
Enter-to-add, counters and removal. An unfinished tag input must be added or
cleared before submitting the form. Item details provides Edit tags with
Save/Cancel. Failed saves retain the draft and request key while the editor stays
open; closing the editor abandons that attempt. Rows show two tags and a +N
indicator. The inspector shows all tags.

## API

- `GET /api/tags?q=camp&limit=20&offset=0` returns `{ data: [{ id, name }], total,
  limit, offset }`, sorted by name and ID. Unused tags remain available for reuse.
- `POST /api/items`, `/api/purchases`, and `/api/wants` accept optional
  `tags: string[]`. Omitted and empty tags preserve historical creation hashes.
  New mutation results include `item.tags`; old replay receipts return `[]`
  when the saved item has no tag field.
- `PUT /api/items/:id/tags` accepts `{ tags: string[] }` and requires a UUID
  `Idempotency-Key`. It returns `{ itemId, tags: [{ id, name }], replayed }` with
  status 200. `[]` clears assignments. Missing, archived and foreign-account
  items return 404. Invalid bodies return 400; conflicting key reuse returns 409.
- `GET /api/collection` and `/api/wants` accept repeated `tagId` UUID query
  parameters (up to five). An item must have all selected tags. Tag filters
  intersect with collection and text search. Text search matches an item name
  or an attached tag name, treating `%` and `_` literally. Filtering/counting
  happens before sorting and pagination.
- Item lists, overview previews and item details include `tags: [{ id, name }]`.

Tag assignment writes lock the parent item and replace the complete set in one
transaction. The `item_tags` operation receipt includes the target item and sorted
normalized names. Replaying an earlier save returns its receipt without changing
newer assignments. Creating a tag uses an account/name upsert in sorted order.
Creation and assignments share the originating item's creation transaction.

## Database and rollout

Migration `20261009155346_item_tags.sql` creates private `app.tags` and
`app.item_tags` tables, ownership RLS, restricted runtime grants, indexes and the
new receipt operation type. Composite foreign keys prevent cross-account links;
unique assignment slots 1–5 enforce the cap even under concurrency. PostgreSQL
checks enforce normalized names and code-point length. Existing items require no
backfill. Tag IDs remain stable when assignments are removed and re-added.

The migration is applied to the local development/test database and, with user
approval on October 10, 2026, the configured hosted project
`mkthxogkzllahenbrxle`. Apply it to any other environment before deploying the API/UI.

The hosted migration history was aligned, with separate user approval, to the
repository/local version `20261009155346_item_tags`. Its recorded history now
matches the repository, so subsequent deployments recognize it as applied.

Global renaming/deletion, bulk editing, saved views, relationships, activity
history and digital-item features are outside this increment.

## Verification

`tests/tags.test.ts` covers normalization, boundaries, creation compatibility,
authentication, API inputs and repeated filters. `tests/tags.database.test.ts`
covers actual SQL constraints, shared tags, ownership, full-set filtering,
concurrent writes, retries, rollback and historical receipts. Run `npm test`
with the local test database available; `REQUIRE_DATABASE_TESTS=1` makes missing
local configuration an error.

Browser plugin not available: tags interactions use the existing bundled
Playwright/Chrome fixture workflow against a local production preview. Fixture
traffic never reaches a real account. Tag-specific screenshots and temporary
interaction checks are retained in `/tmp/inventory-tags`.

Verified on the local production preview at `http://127.0.0.1:3002`: owned,
purchase and want creation with tags; inspector cancel/save; lost-response replay
with the same key; Unicode length errors; five-tag disabling; obsolete suggestion
responses; all-tags filtering; tag text search; removal of a selected item that
no longer matches; wishlist editing; and no horizontal overflow at 390 × 844.
Desktop evidence uses 1536 × 1024. Existing collection/search/wishlist browser
regressions also pass. No app console errors or framework overlays were observed.
The local schema advisor reports only pre-existing policies on other tables,
with no warnings for the new tags tables. Live hosted-account UI and other
browser engines are not covered by the fixture checks.

Final checks: 83 tests across 11 suites pass, including local Postgres/Auth/Storage
integration. TypeScript, ESLint, production build and `git diff --check` pass.
Replaying all migrations into Supabase's shadow database and comparing the `app`
schema reports no differences. Suggestion next/previous pagination is also
verified in Chrome.


## Hosted API failure repair — October 10, 2026

The application was connected to hosted Supabase while the tags migration had
only been applied locally. Missing `app.tags` and `app.item_tags` caused PostgreSQL
`42P01` and API 500 responses. Applying the existing tested migration restored
read-only Hono/Drizzle checks for `/api/collection`, `/api/wants`, `/api/tags`,
`/api/items`, and `/api/collections/overview` to HTTP 200. The checks used a
nonexistent account and the configured restricted runtime role, so they read no
user inventory. This verifies query execution, not a browser sign-in session.

Hosted advisors reported pre-existing [RLS initialization-plan warnings](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan)
on other tables and [disabled leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
Neither was changed as part of this repair. The new tag tables have ownership
policies; the new tag index is reported as unused before normal application use.
