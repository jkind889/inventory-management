# Bugs to review before styling

Audit date: October 6, 2026. Implementation baseline: `f9971bd`.

The audit reviewed application code, database migrations, and dependencies. TypeScript, lint, and all 23 existing tests passed. The UI issues below were identified from source review; they still need focused reproduction and regression tests. No fixes have been applied.

## Review checklist

- [ ] BUG-001: Collection search can stay in a loading state.
- [ ] BUG-002: Spending retains an old error after a successful reload.
- [ ] BUG-003: Retrying an existing-item submission can create duplicates.
- [ ] DEP-001: Review the development-only dependency advisory.
- [ ] PREP-001: Decide on component/style organization before restyling.

## BUG-001 — Collection search can stay loading

Priority: P2 · Status: Open

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

Priority: P2 · Status: Open

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

Priority: P2 · Status: Open

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
