# Collection entry, search, and transfers

The first-priority tools extend the existing dark Collections workbench. Select an item to edit or duplicate it; select row checkboxes for bulk category/ownership changes. New purchase and Already owned entry both support Add another after saving, retaining the chosen category. The most recently used category is remembered per account and used when adding outside a specific collection. Duplication copies descriptive fields, defaults to Already owned, and creates no expense or photo unless explicitly supplied separately.

Item edits and bulk edits preserve the original transaction amounts, dates, and spending categories. Marking an item sold, returned, or donated changes ownership only; it does not invent sale proceeds or refunds. Wishlist conversion remains separate.

Search matches literal text in names, descriptions, transaction notes, and merchants. Category, ownership state, acquisition date range, and recorded purchase cost range combine before counting, sorting, and pagination. Unknown dates/costs are excluded when the corresponding range is selected. The cost filter is actual linked expenses, including for wishlist rows; wishlist estimates do not count as expenses. State defaults to Owned. Additional sorting supports highest recorded cost. Search covers the entire account collection, including items beyond the current page.

Saved views retain the query, category, state, date/cost filters, and sort. Name a view and save it; using the same name updates it. Open views with the Saved views selector and remove them through Manage views. Up to 30 views are stored in a private RLS-protected table. Recent categories and views belong to the account and are included in backups.

## CSV import

Choose Import and a CSV with a header. Match columns, inspect the complete preview, fix all errors, then import. Files are limited to 4 MB and 500 data rows per submission. Quoted commas/newlines are supported through Papa Parse. Dates must be YYYY-MM-DD; prices use decimal major units with no currency symbols or thousands separators. Money is parsed into integer minor units without floating-point arithmetic. Name and category are required. Missing categories are created atomically; archived categories are rejected.

Supported columns: `name`, `category`, `acquiredOn`, `description`, `state`, `amount`, `currency`, and `merchant`. Common headings such as Item, Collection, Notes, Price, and Date are mapped automatically. A blank amount imports a possession without inventing spending. A price requires a known acquisition/purchase date, the account currency, and a non-wishlist state.

Possible duplicates match the trimmed, case-insensitive name/category and acquisition date, both against existing items and within the file. Skip possible duplicates is enabled by default and can be disabled for distinct similar possessions. The server checks again inside the transaction so stale previews cannot cause unintended duplicates. Any invalid row rolls back the complete import.

## Export and backup

Export & backup always includes the whole account rather than the visible filters/page.

- **CSV archive:** one ZIP containing `collection.csv` and `transactions.csv`. Spreadsheet formula cells are escaped. `recordedCost` is informational. The importable `amount` is populated only for an unambiguous single purchase with matching item date/category; use the transaction CSV or complete backup for complex history. CSV does not round-trip photo files, check-ins, or saved views.
- **Complete ZIP backup:** `inventory.json` plus `photos/` containing every active cover photo's actual bytes, including covers on archived items. The versioned manifest contains profile preferences, categories, all ownership states, archived items, expenses, all reviews, views, and recent categories. Account IDs and operational retry receipts are excluded. Every image is checked against its recorded byte length and SHA-256 checksum before the file is offered; unavailable/corrupt photos fail the export instead of producing a partial backup. The supported export limit is 20 MB of record JSON and 190 MB total contents; imports reject ZIPs over 200 MB or expanding beyond 200 MB.

Restore through Import by choosing a complete backup ZIP. Restoration is allowed only when the destination has no items or expenses. It generates new IDs while retaining relations, acquisition/transaction dates, amounts, descriptions, reviews, and preferences. Original archival dates are reinstated after photo upload. Default categories are matched by case-insensitive name. User identity always comes from the authenticated account, never the backup. ZIP validation rejects broken links, duplicate IDs/categories, mismatched currencies, unsupported versions, missing photo bytes, checksum mismatches, and excessive expansion.

Database restoration commits atomically; photo bytes are then uploaded through the existing reservation/completion protocol. If an upload fails, leave the dialog open and retry to finish using the same draft. Photos and archive finalization cannot be part of a Postgres transaction. A page reload or dismissed draft during partial photo restoration does not resume the photo work automatically; retain the backup file. There is no destructive replacement/merge restore for a populated account.

All creating operations, preference writes, edits, bulk changes, imports, and restores use the existing submission-attempt and transaction-receipt helpers. Same-account/key/type/content retries return the original result; changed requests and cross-operation key reuse return 409. Matching requests serialize, and the mutation and receipt commit together.

## Setup and verification

Apply `supabase/migrations/20261019003300_collection_tools.sql` before running the new code against a database. It creates only the private preferences table/policies and expands the existing operation-type constraint. It retains the existing grants and operation types. SQL migrations remain authoritative. This migration and the standalone-purchases migration are applied to hosted project `mkthxogkzllahenbrxle`; the repository filenames match the hosted migration versions.

The development verification used a separate Supabase project `inventory_priority_one`, with its directory at `/tmp/inventory-priority-one-db` and ports 55321–55329, preserving the pre-existing local project and its newer migration history. `SUPABASE_WORKDIR=/path/to/isolated/project npm run db:setup:local` can configure the restricted test connection for another local Supabase instance. The normal setup flow is unchanged. `.env.local` and `.env.test.local` in this checkout currently target this isolated backend.

Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. `npm run test:collection-tools` runs a real local Auth/API/Storage/browser flow against `http://localhost:3004` by default; override `UI_TEST_BASE_URL` for another local preview. Chrome is the default browser channel. It creates and removes its own accounts and refuses non-loopback application/Auth/database URLs. `UI_TEST_EVIDENCE_DIR` controls screenshot/download evidence outside the repository. Existing fixture browser tests remain available through `test:collection-ui` and `test:collection-home`.

Browser plugin availability: absent; verification uses Playwright. Checks cover notes search across pages, repeat entry, edit/duplicate without duplicate spending, combined filters, saved-view reload, bulk changes, import mapping/errors/duplicates, complete CSV/ZIP export, actual photo-byte restoration, and desktop/phone layout. Screenshots are inspected for the existing charcoal palette and purple accent, split workspace and category tree, monospace fields/rows, compact controls, aligned checkbox/table columns, and phone overflow. Existing workbench design is the reference; the initial light concept from an outdated snapshot is superseded and is not a production asset.

Runtime additions are pinned `papaparse` and `fflate`, loaded on demand for transfer actions. Playwright and Papa Parse types are development dependencies. The dependency audit reports no advisories for these additions; five existing high advisories remain in the ESLint/Next lint dependency chain. The suggested automatic downgrade is incompatible with the current Next version and was not applied.

## Final QA results

Verification passed against the production build at `http://localhost:3004`, using real local Supabase Auth, Postgres, and Storage in disposable accounts. The Browser plugin/skill was absent, so Playwright with Chrome was used. Desktop: 1536 × 1024. Phone: 390 × 844. The existing fixture suites also cover 900px tablet layouts.

| Check | Result |
| --- | --- |
| Page identity and nonblank UI | Inventory renders the existing Collections workbench at the intended local origin. |
| Framework overlay / console | No framework overlay, page errors, or console warnings/errors. The missing favicon found during testing was fixed. |
| Main interactions | Notes search across pages, add another, remembered category, edit, safe duplication, combined filters, saved views after reload, bulk edits, previewed CSV import, and empty-result recovery. |
| Transfers | CSV archive includes all records with formula escaping. ZIP backup and restore preserve actual photo bytes and the original archival date. Expenses remain unchanged through edit, duplication, and bulk ownership changes. |
| Phone interactions | Row selection, bulk dialog, and import dialog work at 390px. No horizontal document overflow. |
| Regressions | Both existing search/loading and collection/spending/wishlist/review browser suites pass against production. |
| Database and code | 77 tests across 11 suites, TypeScript, ESLint, production build, and whitespace checks pass. Clean migration reset passes. Local security advisors return no issues. |
| Visual inspection | Latest desktop, phone, and import-preview screenshots inspected with view_image. Existing palette, split panes, category rail, typography, borders, row alignment, and responsive controls match the workbench design. No unresolved material visual mismatch. |

Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:collection-tools`, `UI_TEST_BASE_URL=http://localhost:3004 npm run test:collection-ui`, `UI_TEST_BASE_URL=http://localhost:3004 npm run test:collection-home`, `npx supabase db advisors --local --workdir /tmp/inventory-priority-one-db --type security --fail-on warn`, and `git diff --check`.

Screenshot evidence lives outside the repository in the task's visualization directory as `collection-tools-desktop.png` and `collection-tools-mobile.png`. Preview data in those captures belongs to isolated test accounts that are removed after verification. Remaining scope: browsers other than Chrome, hosted application deployment, and automatic recovery after dismissing/reloading a partially completed photo restore.
