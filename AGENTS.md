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
