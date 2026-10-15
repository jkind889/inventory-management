# Subscription reminders

Implemented October 11, 2026 for local use. Includes in-app reminders and an opt-in Resend digest around 9 a.m. in the account timezone. The local app currently uses the existing hosted Supabase project; its reminder migration has been applied. No app deployment or hosted scheduler was created.

## Use it

Open **Collections → Renewals**, or select the **Subscriptions** collection. Choose **Add subscription** to create an item and tracking together. An existing owned item's details also offer **Set up renewal tracking**.

Capture the expected price in the account currency, monthly/yearly schedule, billing anchor, next renewal, optional HTTPS manage link and lead time. Lead-time choices are renewal day, 1, 3, 7 (default), 14 or 30 days before, or off. Metadata is explicit; category names and purchase dates never create tracking automatically.

Upcoming renewals are sorted by date, with coming-up, due-today and past-due states. Home shows an attention alert. Off preserves the schedule while hiding attention reminders. App entry, focus, actions and a one-minute visible-tab check refresh eligibility.

**Advance to next renewal** explicitly resolves one period and moves to the next anchored date. It creates no Spending transaction. If several dates are overdue, advance one period at a time. Past due describes the tracked date, not whether a provider charged you. Edits must keep the next renewal after the latest resolved date, so later advancement cannot reintroduce resolved renewals.

**Stop tracking** stops immediately or uses an inclusive last renewal date. It only changes this app; cancel the service separately with its provider. The item, recorded purchases, value reviews and renewal resolutions remain. Reactivation is deferred.

An original January 31 anchor advances through February's last day and returns to March 31. A February 29 yearly anchor recovers February 29 in leap years. The form previews the computed next renewal and validates it against the selected date.

## Local email setup

The ignored `.env.local` is configured with the supplied Resend key (the existing `RESEND_API` name remains supported), `RESEND_TEST_RECIPIENT`, `REMINDER_FROM`, `APP_URL`, and independent random `REMINDER_WORKER_SECRET` and `REMINDER_SIGNING_SECRET` values. See `.env.example`. No credentials belong in source control, browser code, logs or command arguments.

The initial sender is `Inventory Reminders <onboarding@resend.dev>`. Only an opted-in app account whose verified email matches `RESEND_TEST_RECIPIENT` can receive reminders in this mode. Other accounts keep in-app reminders and see why email is unavailable. Their data is never redirected to the test address. This follows [Resend's test-domain restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

```sh
npm run dev
```

This starts Next.js and, when the key and worker secret exist, a local worker that polls every 15 minutes. The browser can be closed. Keep the terminal/server running and the computer awake; sleeping or stopped machines cannot send scheduled emails. A successful later run catches up while the renewal is still upcoming or due today. Past-due reminders remain in-app.

For a separately running server:

```sh
npm run reminders:watch
# One immediate processing pass:
npm run reminders:run
```

The standalone runner defaults to `APP_URL`; `REMINDER_WORKER_URL` can select another loopback port. `npm run dev -- --port 3001` automatically points its worker at port 3001; also set `APP_URL` to the origin recipients should open. The runner refuses non-loopback URLs. `npm run start` starts only the production server; run a worker separately when previewing production locally.

Email is off per account initially. In Renewals, choose **Enable email reminders**; each subscription also has an email checkbox. The digest contains only service name, expected amount, renewal date, a details link and unsubscribe controls. Notes, photos and reviews are excluded. Supabase Auth's sign-in/recovery email is separate.

There is at most one digest per account/local day and one reservation per subscription/renewal date. Changing lead time after notification does not repeat an email. Newly eligible entries after today's digest wait until the next morning. No empty digests or overdue email bursts are sent.

## Delivery and duplicate protection

Account-scoped advisory locks serialize schedule edits, email preferences and dispatch. UI writes retain one submission UUID after an ambiguous response; database changes and receipts commit atomically through the existing [submission retry contract](submission-retries.md). Same-key changed content or operation types return 409. Revision checks reject stale edits and different-key double advancement; a unique renewal resolution prevents resolving the same date twice.

Dispatch commits an immutable payload and `subscription-digest/<digest UUID>` provider key before calling Resend. A five-minute lease permits crash recovery; account locking and a final eligibility check prevent concurrent sends. Retries use the same payload/key, with exponential backoff on ambiguous/network failures, rate limits, server errors and provider in-flight duplicates. Definitive provider rejections stop retries. Resend retains [idempotency keys for 24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys); this worker stops automatic retries at 23 hours and records `uncertain`.

Opt-out, verified-recipient changes, archive/non-owned state, stop dates and schedule revisions are checked before dispatch. A possibly sent digest whose eligibility changed becomes uncertain and is not replaced automatically. Never-attempted suppressed reservations can be released; already attempted renewal reservations stay to avoid duplicate notification. Sent mail cannot be recalled.

The unsubscribe URL is signed with an account-bound nonce and purpose. GET displays confirmation so mail scanners cannot opt someone out; POST disables email without sign-in and preserves in-app reminders. Enabling email rotates the nonce. One-click mail-client POST is also supported.

The signed webhook verifies raw bytes, event ID and a five-minute timestamp tolerance, deduplicates event IDs, and records sent/delivered/failed/bounced/complained states. The digest tag can reconcile a lost API response. Older sent events cannot regress delivered/bounced/complained outcomes. Bounces and complaints disable and block email pending operator resolution.

Tables use forced RLS and owner constraints in private `app`. Runtime queries remain on `inventory_runtime`. Narrow, unexposed security-definer functions discover worker candidates, read only the current account's verified email and reconcile verified provider events. The webhook receipt table deliberately has no client policies or direct runtime grants.

## Operations and later deployment

Set `REMINDER_EMAIL_DISABLED=1` and restart the server to stop delivery. In-app tracking remains available. The worker returns accepted/failed counts only; provider errors are stored as redacted codes. Inspect `app.reminder_digests` for status, attempts, retry/lease times and provider ID. Avoid logging payloads or signed links. `accepted` means the provider accepted the request, not inbox delivery. Do not blindly requeue uncertain jobs or change their provider keys: reconcile them first in Resend.

Localhost cannot receive public Resend callbacks. Delivery feedback and bounce/complaint blocking are implemented and tested with signed fixtures, but live webhook reconciliation is deferred until a public URL or an explicitly configured tunnel exists. No `RESEND_WEBHOOK_SECRET` is configured locally yet.

When ready to deploy:

1. Deploy the app with the same server-only settings and an HTTPS `APP_URL`. Keep Auth URL/callback settings consistent with the deployed app.
2. Register `<APP_URL>/api/reminders/webhook` in Resend for `email.sent`, `email.delivered`, `email.failed`, `email.bounced` and `email.complained`. Store its signing secret as `RESEND_WEBHOOK_SECRET`. Verify a signed real event before relying on delivery feedback.
3. Configure [Supabase Cron](https://supabase.com/docs/guides/cron/quickstart) to POST every 15 minutes to `<APP_URL>/api/internal/reminders/run` with `Authorization: Bearer <REMINDER_WORKER_SECRET>`. Keep the secret in Vault/server configuration, not a checked-in SQL file. The endpoint does not accept a publishable key as worker authentication. Discovery uses pages of 50 accounts, advancing by account ID even when accounts are skipped or fail. Each run traverses the pages using one discovery timestamp; completed candidates disappearing cannot shift later pages. Choose a host/request timeout appropriate for all candidates, with provider calls bounded at 15 seconds each. At larger scale, split dispatch into smaller jobs.
4. Verify the owned sender domain in Resend, set `REMINDER_FROM` to an address there, and test delivery. The test-recipient gate applies to `resend.dev` senders; an owned verified sender permits opted-in verified recipients. Keep `RESEND_TEST_RECIPIENT` until the sender switch is verified.
5. Monitor job failures, uncertain digests and signed provider feedback before broader rollout. Resolve delivery blocks only after the underlying address/provider issue is fixed.

## Verification

- A clean local Supabase reset applied the full migration chain. `20261011202829_subscription_reminders.sql` matches the hosted migration version.
- 108 unit/API/real-database tests cover calendar/DST rules, recurrence constraints, sequential/concurrent retries, conflicts, rollback, account isolation, no phantom spending, digest grouping, local delivery hour, kill switch, verified/test recipients, immutable retries/expiry, eligibility changes, unsubscribe, webhook recovery/deduplication and bounce blocking. Review regressions reject edits at or before resolved renewals and verify that 50 skipped accounts cannot block 52 eligible recipients on later pages, including after sent candidates disappear.
- TypeScript, lint and production build passed. Existing collection/search browser regressions passed.
- Fixture-only Playwright checks at 1536×960 and 390×844 exercised create with a lost response and same-key retry, edit, anchored advance, inclusive stop, email opt-in/off, deep links and category navigation. Page identity/content, console health, absence of framework overlays and horizontal overflow were checked. Dark-theme contrast and checkbox sizing were repaired after screenshot inspection. Browser plugin was unavailable.
- Resend accepted one clearly labeled setup test through the production adapter. No real account subscription or payment was created. The configured key's delivery-status lookup returned 401, so inbox delivery remains unverified; public webhook delivery has not been configured.
- Hosted advisors show no new ownership/RLS warning on reminder domain tables. The no-policy info notice for the private webhook event ledger is intentional. Existing [leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) and earlier photo/review RLS performance advisories remain outside this feature; new indexes may appear unused until there is reminder traffic.

## Follow-ups

The October 13 pagination fix adds `20261013153443_reminder_account_pagination.sql`, now applied locally and to the hosted database with matching migration history. The original discovery signature remains available for older callers during rollout. Both signatures retain the fixed search path and allow execution only by the runtime role, excluding `anon` and `authenticated`. Hosted discovery queries and the restricted app connection are verified. Security advisors show no new issue; the existing Auth leaked-password warning and intentional no-policy webhook ledger notice remain.

Owned sender domain and hosted scheduling, browser push, confirmed subscription charges, custom cadence, snooze, pauses/reactivation, bulk overdue catch-up and subscription-specific keep/cancel reviews remain separate work. Expected fees must never create expenses automatically. This implements the reminder part of [reminders-and-photos.md](reminders-and-photos.md); confirmed-charge accounting in [build-plan.md](build-plan.md) stays deferred.
