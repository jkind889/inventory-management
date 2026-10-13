import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { calendarToday, renewalState, type SubscriptionEntry } from "../../shared/subscriptions";
import { formatDate, formatMoney } from "../../shared/collection";
import { withUser, type Database, type UserTransaction } from "../db/client";
import { profiles, reminderDeliveries, reminderDigests, reminderPreferences, type DigestPayload } from "../db/schema";
import { activeSubscriptions, emailAvailability, lockReminders, reminderIdentity } from "./subscriptions";

const RETRY_WINDOW = 23 * 60 * 60 * 1000;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function unsubscribeToken(userId: string, nonce: string, secret: string) {
  const value = `${userId}.${nonce}`;
  return `${value}.${createHmac("sha256", secret).update(`reminder-unsubscribe:${value}`).digest("base64url")}`;
}
export function parseUnsubscribeToken(token: string, secret: string) {
  const [userId, nonce, signature, extra] = token.split(".");
  if (extra || !signature || !z.uuid().safeParse(userId).success || !z.uuid().safeParse(nonce).success) return null;
  return safeEqual(token, unsubscribeToken(userId, nonce, secret)) ? { userId, nonce } : null;
}
export function renderDigest(entries: Pick<SubscriptionEntry, "name" | "amountMinor" | "currency" | "nextDueOn" | "itemId">[], origin: string, unsubscribe: string, from: string, recipient: string): DigestPayload {
  const rows = entries.map(entry => {
    const url = `${origin}/?item=${encodeURIComponent(entry.itemId)}`;
    return { ...entry, amount: formatMoney(entry.amountMinor, entry.currency), date: formatDate(entry.nextDueOn), url };
  });
  return {
    from, to: [recipient], subject: `${rows.length} upcoming subscription ${rows.length === 1 ? "renewal" : "renewals"}`,
    html: `<main style="font-family:Arial,sans-serif;max-width:600px;margin:32px auto;color:#292823"><h1>Upcoming renewals</h1><p>A little time to decide what you want to keep.</p>${rows.map(row => `<section style="padding:16px 0;border-top:1px solid #dedbd2"><h2 style="font-size:18px">${escapeHtml(row.name)}</h2><p>${escapeHtml(row.amount)} expected · Renews ${escapeHtml(row.date)}</p><a href="${escapeHtml(row.url)}">View subscription</a></section>`).join("")}<p>These are expected renewals. No payment has been recorded.</p><p><a href="${escapeHtml(unsubscribe)}">Unsubscribe from reminder emails</a></p></main>`,
    text: `Upcoming renewals\n\n${rows.map(row => `${row.name}\n${row.amount} expected · Renews ${row.date}\n${row.url}`).join("\n\n")}\n\nNo payment has been recorded.\nUnsubscribe: ${unsubscribe}`,
    headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, tags: [],
  };
}
export type EmailSender = (payload: DigestPayload, idempotencyKey: string) => Promise<{ id: string }>;
export class EmailSendError extends Error {
  constructor(public readonly retryable: boolean, public readonly code: string) { super("Email delivery request failed."); }
}
export const sendResendEmail: EmailSender = async (payload, key) => {
  const apiKey = process.env.RESEND_API_KEY || process.env.RESEND_API;
  if (!apiKey) throw new EmailSendError(false, "not_configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
  });
  // Never log or expose provider responses, addresses, payloads or credentials.
  if (!response.ok) {
    // Resend distinguishes an in-flight duplicate from a changed-content conflict.
    const conflict = response.status === 409 ? await response.json().catch(() => null) : null;
    const concurrent = z.object({ name: z.literal("concurrent_idempotent_requests") }).safeParse(conflict).success;
    throw new EmailSendError(concurrent || response.status === 429 || response.status >= 500, concurrent ? "provider_409_concurrent" : `provider_${response.status}`);
  }
  const body: unknown = await response.json();
  const parsed = z.object({ id: z.string().min(1) }).safeParse(body);
  if (!parsed.success) throw new EmailSendError(true, "invalid_response");
  return parsed.data;
};
async function context(tx: UserTransaction, userId: string, now: Date) {
  const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
  if (!profile) return null;
  const [prefs] = await tx.select().from(reminderPreferences).where(eq(reminderPreferences.userId, userId));
  const identity = await reminderIdentity(tx);
  const today = calendarToday(profile.timezone, now);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: profile.timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
  const reason = emailAvailability(identity);
  return { profile, prefs, identity, today, hour, eligible: !!prefs?.enabled && !prefs.blocked && !reason };
}
async function eligibleEntries(tx: UserTransaction, userId: string, today: string) {
  const rows = await activeSubscriptions(tx, userId);
  return rows.filter(row => row.subscription.emailEnabled && ["attention", "today"].includes(renewalState(row.subscription, today)));
}
export function createReminderEmailService(db: Database, send: EmailSender = sendResendEmail, clock = () => new Date()) {
  async function prepare(userId: string) {
    const now = clock();
    return withUser(db, userId, async tx => {
      await lockReminders(tx, userId);
      const ctx = await context(tx, userId, now);
      if (!ctx) return null;
      const queued = await tx.select().from(reminderDigests).where(and(eq(reminderDigests.userId, userId), inArray(reminderDigests.status, ["pending", "processing"])));
      let digest = queued.find(row => (!row.leaseUntil || Date.parse(row.leaseUntil) <= now.getTime()) && (!row.retryAfter || Date.parse(row.retryAfter) <= now.getTime()));
      if (!digest) {
        if (!ctx.eligible || ctx.hour < 9) return null;
        const [existing] = await tx.select({ id: reminderDigests.id }).from(reminderDigests).where(and(eq(reminderDigests.userId, userId), eq(reminderDigests.localDate, ctx.today)));
        if (existing) return null;
        const notified = await tx.select().from(reminderDeliveries).where(eq(reminderDeliveries.userId, userId));
        const candidates = (await eligibleEntries(tx, userId, ctx.today)).filter(row => !notified.some(entry => entry.subscriptionId === row.subscription.id && entry.dueOn === row.subscription.nextDueOn));
        if (!candidates.length) return null;
        [digest] = await tx.insert(reminderDigests).values({ userId, localDate: ctx.today, recipient: ctx.identity.email,
          entries: candidates.map(({ subscription: row }) => ({ subscriptionId: row.id, dueOn: row.nextDueOn, reminderDays: row.reminderDays!, revision: row.revision })) }).returning();
        for (const entry of digest.entries) await tx.insert(reminderDeliveries).values({ userId, ...entry, digestId: digest.id }).onConflictDoNothing();
      }
      if (digest.firstAttemptAt && now.getTime() - Date.parse(digest.firstAttemptAt) >= RETRY_WINDOW) {
        await tx.update(reminderDigests).set({ status: "uncertain", lastError: "retry_window_expired", leaseUntil: null }).where(eq(reminderDigests.id, digest.id));
        return null;
      }
      const candidates = await eligibleEntries(tx, userId, ctx.today);
      const matching = digest.entries.flatMap(entry => {
        const match = candidates.find(row => row.subscription.id === entry.subscriptionId && row.subscription.nextDueOn === entry.dueOn);
        return match ? [match] : [];
      });
      const intact = matching.length === digest.entries.length && matching.every(row => digest.entries.some(entry => entry.subscriptionId === row.subscription.id && entry.revision === row.subscription.revision));
      if (!ctx.eligible || ctx.identity.email !== digest.recipient || !matching.length || (digest.firstAttemptAt && !intact)) {
        await tx.update(reminderDigests).set({ status: digest.firstAttemptAt ? "uncertain" : "suppressed", lastError: "eligibility_changed", leaseUntil: null }).where(eq(reminderDigests.id, digest.id));
        if (!digest.firstAttemptAt) await tx.delete(reminderDeliveries).where(and(eq(reminderDeliveries.userId, userId), eq(reminderDeliveries.digestId, digest.id)));
        return null;
      }
      // Freeze payload before the provider call. A crash can only retry these exact bytes/key.
      let payload = digest.payload;
      let entries = digest.entries;
      if (!digest.firstAttemptAt) {
        const origin = new URL(process.env.APP_URL!).origin;
        const token = unsubscribeToken(userId, ctx.prefs!.unsubscribeNonce, process.env.REMINDER_SIGNING_SECRET!);
        payload = renderDigest(matching.map(row => ({ ...row.subscription, name: row.name })), origin,
          `${origin}/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`, process.env.REMINDER_FROM || "Inventory Reminders <onboarding@resend.dev>", digest.recipient);
        payload.tags = [{ name: "digest_id", value: digest.id }];
        entries = matching.map(({ subscription: row }) => ({ subscriptionId: row.id, dueOn: row.nextDueOn, reminderDays: row.reminderDays!, revision: row.revision }));
      }
      const [claimed] = await tx.update(reminderDigests).set({ payload, entries, status: "processing", firstAttemptAt: digest.firstAttemptAt ?? now.toISOString(),
        leaseUntil: new Date(now.getTime() + 5 * 60000).toISOString(), attempts: digest.attempts + 1 }).where(eq(reminderDigests.id, digest.id)).returning();
      return claimed;
    });
  }
  return {
    async run() {
      if (process.env.REMINDER_EMAIL_DISABLED === "1") return { disabled: true, accepted: 0, failed: 0 };
      const asOf = clock().toISOString();
      let afterUserId: string | null = null;
      let accepted = 0, failed = 0;
      while (process.env.REMINDER_EMAIL_DISABLED !== "1") {
        const accounts: { user_id: string }[] = await db.execute<{ user_id: string }>(sql`select * from app.reminder_accounts(${asOf}::timestamptz, ${afterUserId}::uuid)`);
        if (!accounts.length) break;
        // Advance even when accounts are skipped or fail; completed candidates
        // disappear, so an OFFSET would skip accounts on subsequent pages.
        afterUserId = accounts[accounts.length - 1].user_id;
        for (const account of accounts) {
          try {
            const digest = await prepare(account.user_id);
            if (!digest?.payload) continue;
            // Serialize with account edits/opt-out while performing the bounded provider call.
            await withUser(db, account.user_id, async tx => {
              await lockReminders(tx, account.user_id);
              const ctx = await context(tx, account.user_id, clock());
              const [current] = await tx.select().from(reminderDigests).where(eq(reminderDigests.id, digest.id));
              if (current.status !== "processing" || current.attempts !== digest.attempts) return;
              const candidates = ctx ? await eligibleEntries(tx, account.user_id, ctx.today) : [];
              const valid = ctx?.eligible && ctx.identity.email === digest.recipient && digest.entries.every(entry => candidates.some(row => row.subscription.id === entry.subscriptionId && row.subscription.nextDueOn === entry.dueOn && row.subscription.revision === entry.revision));
              if (!valid || process.env.REMINDER_EMAIL_DISABLED === "1") {
                await tx.update(reminderDigests).set({ status: "uncertain", lastError: "eligibility_changed", leaseUntil: null }).where(eq(reminderDigests.id, digest.id)); return;
              }
              try {
                const result = await send(digest.payload!, `subscription-digest/${digest.id}`);
                await tx.update(reminderDigests).set({ status: "accepted", providerId: result.id, leaseUntil: null, retryAfter: null, lastError: null }).where(eq(reminderDigests.id, digest.id));
                accepted++;
              } catch (error) {
                const retryable = !(error instanceof EmailSendError) || error.retryable;
                await tx.update(reminderDigests).set({ status: retryable ? "pending" : "failed", leaseUntil: null,
                  retryAfter: retryable ? new Date(clock().getTime() + Math.min(60, 2 ** Math.min(digest.attempts, 6)) * 60000).toISOString() : null,
                  lastError: error instanceof EmailSendError ? error.code : "ambiguous_provider_response" }).where(eq(reminderDigests.id, digest.id));
                failed++;
              }
            });
          } catch { failed++; }
        }
      }
      return { accepted, failed };
    },
    async unsubscribe(token: string) {
      const secret = process.env.REMINDER_SIGNING_SECRET;
      const parsed = secret ? parseUnsubscribeToken(token, secret) : null;
      if (!parsed) throw new HTTPException(400, { message: "This unsubscribe link is invalid." });
      await withUser(db, parsed.userId, async tx => {
        await lockReminders(tx, parsed.userId);
        const [prefs] = await tx.select().from(reminderPreferences).where(eq(reminderPreferences.userId, parsed.userId));
        if (!prefs || prefs.unsubscribeNonce !== parsed.nonce) throw new HTTPException(400, { message: "This unsubscribe link has expired. Use the latest email or your in-app settings." });
        if (prefs.enabled) await tx.update(reminderPreferences).set({ enabled: false, revision: prefs.revision + 1 }).where(eq(reminderPreferences.userId, parsed.userId));
      });
    },
    async webhook(eventId: string, event: { type: string; data: { email_id: string; tags?: Record<string, string> } }) {
      const digestTag = z.uuid().safeParse(event.data.tags?.digest_id);
      const [owner] = await db.execute<{ user_id: string | null }>(sql`select app.reminder_event_owner(${event.data.email_id},${digestTag.success ? digestTag.data : null}::uuid) as user_id`);
      // Other emails in the provider account are outside this feature.
      if (!owner?.user_id) return;
      await withUser(db, owner.user_id, async tx => {
        await lockReminders(tx, owner.user_id!);
        const [claimed] = await tx.execute<{ claimed: boolean }>(sql`select app.claim_reminder_webhook(${eventId}) as claimed`);
        if (!claimed.claimed) return;
        const [digest] = await tx.select().from(reminderDigests).where(digestTag.success ? eq(reminderDigests.id, digestTag.data) : eq(reminderDigests.providerId, event.data.email_id));
        if (!digest || (digest.providerId !== null && digest.providerId !== event.data.email_id)) return;
        const status = event.type === "email.complained" ? "complained" : event.type === "email.bounced" ? "bounced" : event.type === "email.delivered" ? "delivered" : event.type === "email.failed" ? "failed" : "accepted";
        if (!status) return;
        const keepTerminal = ["bounced", "complained"].includes(digest.status) || (digest.status === "delivered" && status === "accepted");
        if (!keepTerminal || status === "complained") await tx.update(reminderDigests).set({ status, providerId: event.data.email_id, leaseUntil: null, retryAfter: null }).where(eq(reminderDigests.id, digest.id));
        if (status === "bounced" || status === "complained") {
          const [prefs] = await tx.select().from(reminderPreferences).where(eq(reminderPreferences.userId, owner.user_id!));
          if (prefs) await tx.update(reminderPreferences).set({ enabled: false, blocked: true, revision: prefs.revision + 1 }).where(eq(reminderPreferences.userId, owner.user_id!));
        }
      });
    },
  };
}

export function verifyResendWebhook(body: string, headers: Headers, secret: string, now = Date.now()) {
  const id = headers.get("svix-id"), timestamp = headers.get("svix-timestamp"), signatures = headers.get("svix-signature");
  if (!id || id.length > 200 || !timestamp || !/^\d+$/.test(timestamp) || !signatures || Math.abs(now / 1000 - Number(timestamp)) > 300) return null;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return signatures.split(" ").some(value => value.startsWith("v1,") && safeEqual(value.slice(3), expected)) ? id : null;
}
