# Item value check-ins

The first working slice adds Subscriptions as a starter category and a **Worth
it?** section to item details. Existing profiles receive the category through
migration `20261008172949_subscriptions_and_item_reviews.sql`; profile bootstrap
also fills a missing category without duplicating it or changing preferences.

Select an acquired item, choose **Review this item**, and save a verdict:
**Worth it**, **Not worth it**, or **Still deciding**. Optional answers record
usage frequency, whether you would buy it again, and a reason. Later check-ins
append new records; earlier answers remain in history. The inspector shows the
20 most recent records, newest first, with dates in the account timezone.
All history remains stored in the database.

Wishlist entries cannot be reviewed. Acquired items with no known price or date
can still be reviewed. Reviews never create transactions or change spending.
The verdict and usage answers remain separate; qualitative frequency does not
produce a cost-per-use calculation or an automatic value score.

## Data and API

`app.item_reviews` stores the item, verified owner, verdict, optional usage,
optional boolean repurchase answer, note, and server creation timestamp. An
owner/item foreign key, forced RLS, and limited runtime grants protect the
append-only history. The table is unavailable to browser Data API roles.

`GET /api/items/:id` includes `reviews`. `POST /api/items/:id/reviews` requires a
UUID `Idempotency-Key` and a strict validated body, for example:

```json
{
  "verdict": "worth_it",
  "usageFrequency": "weekly",
  "wouldBuyAgain": true,
  "note": "Useful for weekend projects."
}
```

Usage accepts `daily`, `weekly`, `monthly`, `rarely`, `never`, or null. The
repurchase answer accepts true, false, or null. Notes are optional and limited
to 5,000 characters. The item must be accessible, unarchived, and acquired.

The mutation and its `item_review` receipt commit atomically. The receipt hash
includes the item ID, so reusing a key for another item also returns 409. A new
write returns 201; identical retries return 200 and the original review. The
browser retains the attempt while its form remains open, clears it on confirmed
success or cancellation, and does not persist drafts across navigation/reload.

## Verification and next steps

Local tests cover concurrent/sequential retries, changed content and operation
conflicts, rollback, separate check-ins, account isolation, wishlist/archived
item rejection, and unchanged spending. Fixture browser checks cover lost
responses, save/history rendering, category selectors, and desktop/mobile forms.
Browser plugin not available; the existing Playwright/Chrome workflow was used
against localhost with isolated Auth/API fixtures.

The migration is applied to the local and configured hosted database. Hosted
checks verified forced RLS, restricted grants, and subscriptions for all existing
profiles. The hosted security advisor also reported the independent Auth setting
[leaked-password protection disabled](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

Next slices can add review filters and summaries, suggested check-in dates,
actual use counts for meaningful cost-per-use calculations, and subscription
billing intervals/renewal dates with keep/cancel reflections. Subscription
recurrence, automatic charges, reminders, and aggregate value scoring are not
implemented in this slice.
