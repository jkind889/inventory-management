# Submission retries

Retry protection is the default for any mutation where repeating an intended
action could create duplicate records or repeat a side effect. Purchases,
“Already owned” entries, wants, and item value check-ins implement this contract today. Naturally idempotent
actions, such as setting a preference to a specific value, may use their own
atomic implementation if repetition already has the same effect.

## Request identity

The browser creates one UUID `Idempotency-Key` for an intended submission and
retains it after a timeout, lost response, or other ambiguous error. Creation
flows use `getSubmissionAttempt` in `src/shared/submission.ts`. The endpoint and
serialized fields identify the current attempt. Edited fields or a different
flow receive a new key; confirmed success clears the attempt. A separate intended
entry gets a new key even when its fields match an earlier item.

The current add-item form retains its attempt while that form stays open. Closing
the form or reloading the page discards it. If a future flow resumes a saved draft
after remount/reload, persist its request key with the draft, scope it to the
account and operation, and clear it on confirmed success or explicit abandonment.
Do not regenerate a key merely because a request failed, and do not deduplicate
possessions by their names or fields alone.

## Server contract

Authenticate the account, require a UUID request key, and validate/normalize the
body before invoking `withIdempotency` in
`src/server/services/idempotency.ts`. Register new operation/result types in the
query model and SQL constraint when extending the helper.

The helper opens an account-scoped transaction and acquires the shared
account/key advisory lock. It looks for a completed operation before performing
new writes. A saved operation must match both its type and the hash of the
validated request. The write and its replay receipt commit together; a failure
rolls both back. Existing purchase receipt hashes remain compatible.

| Request | Behavior |
| --- | --- |
| First successful submission | Create once; return 201 with `replayed: false`. |
| Same account/key/type/content | Return the original result with 200 and `replayed: true`. |
| Same key with changed content or operation type | Return 409 without new writes. |
| Simultaneous identical requests | One creates; the others replay its result. |
| Separate keys with identical fields | Create separate intended records. |
| Different accounts using the same key | Independent operations, with account isolation. |
| Failed transaction | No record or receipt; allow the key to be retried. |

“Already owned” creates no expense, including on retries. Disabling the submit
button improves interaction but does not provide the server guarantee.

For future external side effects, such as provider payments or messages, use the
provider's idempotency support or a transactional outbox. A database transaction
alone cannot roll back an external action.

## Verification and rollout

Regression coverage must include lost-response replay, simultaneous first
requests, conflicting key reuse, rollback, separate intentional submissions, and
account isolation. Client tests verify key reuse and renewal; local database/API
tests verify actual effects and replay responses.

Migration `20261007022934_existing_item_idempotency.sql` has been applied to the
configured hosted project and the local database. Apply it before deploying this
API change to any other database. `POST /api/items` now requires an
`Idempotency-Key` header just like `POST /api/purchases`.

Item value check-ins use the `item_review` operation type. The validated receipt
payload includes the item ID to reject reuse across targets. See
[item-worth.md](item-worth.md) for the API contract and form lifetime. Migration
`20261008172949_subscriptions_and_item_reviews.sql` is applied locally and to the
configured hosted project.
