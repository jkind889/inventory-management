# Bugs to review before styling

Audit date: October 6, 2026. Implementation baseline: `f9971bd`.

The audit reviewed application code, database migrations, and dependencies. TypeScript, lint, and all 23 existing tests passed at the audit baseline. The UI issues below were identified from source review; open issues still need focused reproduction and regression tests. Subsequent fixes are recorded under each issue.

## Review checklist

- [x] BUG-001: Collection search can stay in a loading state (fixed; browser regression verified).
- [x] BUG-002: Spending retains an old error after a successful reload (fixed).
- [x] BUG-003: Retrying an existing-item submission can create duplicates (fixed; verified locally and hosted migration applied).
- [ ] DEP-001: Review the development-only dependency advisory.
- [ ] PREP-001: Decide on component/style organization before restyling.

## BUG-001 — Collection search can stay loading

Priority: P2 · Status: Fixed

**Resolution — October 7, 2026:** Loading now derives from unsettled search input
and whether the current collection request has completed. Each completed result
or error records its request key; all search/filter/sort/page/refresh changes use
that state instead of manually toggling loading. Aborted requests cannot publish
results or errors. Rapid edit-and-undo returns to the existing results without
an unnecessary request. A saved browser regression reproduced the original
stuck state before the change and passed afterward. It also covers nonempty
search undo, normal searches, page-two reset, delayed obsolete responses, request
failure/retry, sorting, category filtering, and desktop/mobile rendering using
isolated Auth/API fixtures. Run `npm run test:collection-ui` against the local
app with an existing Playwright runtime. No database migration is required.
The reproduction below describes the audit baseline, before this fix.

Source: [Search input](../../src/features/collection/collection-screen.tsx#L575) and [debounce/request effects](../../src/features/collection/collection-screen.tsx#L388).

**Reproduction**

1. Open the collection with an empty search on the first page and wait for it to load.
2. Type or paste a search term, then undo or erase it before the 250ms debounce completes.
3. Wait for the debounce to finish.

Expected: The original collection remains visible or finishes loading.

Actual from source: The input sets `loading` to true, but the settled search value and page offset match their existing values. The request effect does not run, leaving loading true.

Suggested fix: Derive pending state from the active request and unsettled search, or set loading only when a new request actually starts. Preserve cancellation of obsolete requests.

Acceptance: Rapid edit-and-undo returns to the original results without a stuck skeleton. Normal searches and pagination still work. Add a regression test for the unchanged debounced value.

## BUG-002 — Spending retains an old error

Priority: P2 · Status: Fixed

**Resolution — October 14, 2026:** Successful Spending requests now clear the previous failure together with saving the loaded summary/history. Aborted requests still cannot publish results or clear current errors. The collection-home browser regression passes against a local production build and covers a failed month, a successful different month, and returning to the failed month with a successful response. The reproduction below describes the original behavior.

Source: [Request/error state](../../src/features/spending/spending-screen.tsx#L30) and [success handler](../../src/features/spending/spending-screen.tsx#L60).

**Reproduction**

1. Open Spending and wait for a month to load.
2. Temporarily disable the network in browser developer tools and select another month; wait for the error screen.
3. Restore the network, select a different month, and wait for a successful load.
4. Return to the month that failed and allow its request to succeed.

Expected: Successful data replaces the error screen.

Actual from source: The successful request updates `result` but does not clear `failure`. Returning to the same month/page reuses the failed request key, so the old error still takes precedence over the new data.

Suggested fix: Clear the matching failure on a successful response, or represent each request with one loading/success/error state. Ensure an obsolete request cannot overwrite the current selection.

Acceptance: A previously failing month displays its total and history after a successful reload, including when revisited through month navigation. Add a regression test for failure → another month → original month succeeds.

## BUG-003 — Existing-item retries can create duplicates

Priority: P2 · Status: Fixed · Hosted migration applied

**Resolution — October 6, 2026:** Purchases and existing-item creation now share
an account/key lock, request/type conflict checks, and an atomic result receipt.
Both form modes send a retry key and reuse it after failure. Existing-item
creation returns 201 initially and 200 with the original item on replay. The
operation model and new migration allow `existing_item` receipts. Local
regression tests cover lost-response replay, concurrent requests, changed fields,
cross-flow conflicts, separate intentional items, rollback, and account isolation.
All 30 tests, TypeScript, lint, and the production build passed. Local database
security advisors found no issues, and local migration history matches the SQL
files. After user approval, the hosted migration was applied and its validated
operation-type constraint and unique account/key constraint were verified.
The [submission retry baseline](submission-retries.md) and project instructions
require this protection for future mutations that could repeat an effect.
Migration `20261007022934_existing_item_idempotency.sql` is applied to the hosted
database. The local filename matches Supabase's assigned version. The
reproduction below describes the audit baseline, before this fix.

Source: [Form submission](../../src/features/collection/collection-screen.tsx#L138), [POST /api/items](../../src/server/api/app.ts#L40), and [existing-item service](../../src/server/services/inventory.ts#L49).

**Reproduction**

1. Submit an item through the “Already owned” form.
2. Simulate a lost response after the server has committed the item.
3. Retry the same submission without changing its fields.

Expected: The retry returns the item already created by that intended submission.

Actual from source: The form sends an idempotency key only for purchases. Existing-item creation always inserts a new row, so a retry after an ambiguous failure creates another possession.

Suggested fix: Extend retry protection to existing-item creation. Validate a request key, serialize concurrent requests for that account/key, and store the request hash and result atomically. This requires updating the operations model/migration, which currently permits only purchase operations. Reuse a key for retries and generate a new one for a separate intended item.

Acceptance: Identical sequential/concurrent retries with the same key produce one item. Reusing the key with different fields is rejected. Separate keys may create distinct items with the same name. Existing-item entry still creates no spending.

## DEP-001 — Development dependency advisory

Status: Open · Scope: Development tooling

At audit time, `npm audit` reported five high-severity package entries from one dependency chain:

`eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces@3.0.3`

The underlying [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) concerns stack exhaustion from deeply nested patterns. The advisory listed no patched version at the time of the audit. `npm audit --omit=dev` reported zero vulnerabilities.

Suggested review: Check for an upstream compatible fix before changing versions. The audit's automatic recommendation would downgrade the Next ESLint configuration across major versions; do not apply that blindly. This is one underlying advisory, not five independent vulnerabilities.

Acceptance: Record the resolution or temporary rationale after reviewing the dependency chain. Rerun dependency audit, lint, TypeScript, tests, and build after any dependency change.

## PREP-001 — Organize the UI before styling

Status: Optional cleanup · Not a functional bug

The collection module is 773 lines and owns the app navigation, profile setup, collection controls, add-item form, item-detail dialog, and composition of both screens. The global stylesheet is 1,186 lines.

Suggested direction: Extract a shared app shell/navigation, add-item form, item-detail dialog, and focused collection data hook. Group styles by shared tokens/components and individual surfaces, or adopt scoped styles where useful. Preserve the current behavior while making styling changes easier to review.

Acceptance: Collection, Spending, sign-in, form submission, and dialogs retain their behavior after reorganization. Choose the visual direction separately before adding more features.
