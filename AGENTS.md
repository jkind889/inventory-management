# Working in this repository

This is a personal inventory and spending app built with Next.js, React,
TypeScript, Hono, Drizzle, and Supabase. Keep changes focused, preserve existing
work, and follow the surrounding code's patterns.

## Delegation

Spawn subagents when independent exploration, implementation, or verification
would help. Give each agent a bounded task, clear file ownership, and the
relevant context. Tell agents that others may be editing the same checkout and
that they must preserve those changes. Avoid overlapping edits; the primary
agent integrates the results, reviews the combined diff, and verifies the final
behavior. Small tasks can stay with one agent.

## Repository map

- `src/app`: Next.js entry points, global styles, and the Hono API adapter.
- `src/features`: React screens and feature-specific forms.
- `src/components`: shared interface components.
- `src/shared`: validation contracts, types, and browser-safe helpers.
- `src/server/api`: authenticated API boundaries.
- `src/server/services`: account-scoped business logic and transactions.
- `src/server/db`: Drizzle query models and database connection handling.
- `supabase/migrations`: authoritative SQL constraints, indexes, grants, and RLS.
- `tests`: Vitest unit/API/database checks and Playwright browser scripts.
- `docs`: feature contracts, setup, and rollout notes.

## Implementation expectations

Inspect `git status` before editing and preserve unrelated or unfinished work.
Read the relevant feature documentation and nearby implementation first.
Validate input at authenticated API boundaries; derive account identity from
authentication, never request fields. Keep queries account-scoped, retain RLS
and same-owner relationships, and keep credentials out of source and logs.

Store money as integer minor units and calendar dates in the established format.
Owned items and spending are distinct: an already-owned item creates no expense,
and a purchase can be recorded without creating an item. Keep totals, history,
exports, and backups consistent when changing either model.

Use SQL migrations for schema changes and update the Drizzle models alongside
them. Keep testing on the local backend; do not reset databases, overwrite
environment files, or apply hosted migrations as a routine verification step.
State any migration required before deployment.

## Verification

Use `npm run typecheck`, `npm run lint`, and focused `npm test -- <test paths>`
checks while developing. Run the relevant database integration tests for data
changes and browser flows for visible behavior changes. Check desktop and mobile
layouts when the interface changes. Use `npm run build` for production build
validation. See `README.md` for local setup and browser test environment options.

Report what changed, what passed, and any unverified behavior or rollout steps.
Do not claim a skipped test passed or discard unrelated changes to make a check
green.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Submission retry baseline

All new mutations that could create duplicate records or repeat a side effect must
support retries as part of their initial implementation. Use the shared
`src/shared/submission.ts` attempt helper and
`src/server/services/idempotency.ts` transaction helper for database creations.
Keep one UUID request key per intended submission, reuse it after ambiguous
failures, and generate a new key for a separate intended action. Validate the key
at the authenticated API boundary. Serialize matching account/key requests,
check the operation type and validated request content, and commit the mutation
and saved result atomically. Identical retries return the original result;
changed content or another operation type with the same key returns 409.
Include sequential/concurrent retry, conflict, rollback, and account-isolation
coverage. See `docs/submission-retries.md` for the contract and draft lifetime.
