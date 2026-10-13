import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { calendarToday, isAttention, renewalOn, renewalState, type ScheduleInput, type Subscription, type SubscriptionsResponse,
  type subscriptionCreateInput, type subscriptionEditInput, type subscriptionAdvanceInput, type subscriptionStopInput, type reminderPreferencesInput } from "../../shared/subscriptions";
import { withUser, type Database, type UserTransaction } from "../db/client";
import { categories, items, profiles, reminderPreferences, renewalResolutions, subscriptions } from "../db/schema";
import { withIdempotency } from "./idempotency";

export async function lockReminders(tx: UserTransaction, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`reminders:${userId}`},0))`);
}
export async function reminderIdentity(tx: UserTransaction) {
  const [identity] = await tx.execute<{ email: string; verified: boolean }>(sql`select * from app.reminder_identity()`);
  return identity;
}
export function emailAvailability(identity?: { email: string; verified: boolean }) {
  if (!identity?.verified) return "Verify your account email before enabling reminder emails.";
  if (!(process.env.RESEND_API_KEY || process.env.RESEND_API)) return "Reminder email is not configured yet.";
  if (!process.env.REMINDER_SIGNING_SECRET || !process.env.APP_URL) return "Reminder email setup is incomplete.";
  const sender = process.env.REMINDER_FROM || "onboarding@resend.dev";
  if (sender.toLowerCase().includes("@resend.dev") && identity.email.toLowerCase() !== process.env.RESEND_TEST_RECIPIENT?.toLowerCase()) {
    return "Email testing is available only for the Resend account email. In-app reminders are available here.";
  }
  return null;
}
export async function activeSubscriptions(tx: UserTransaction, userId: string) {
  return tx.select({ subscription: subscriptions, name: items.name, categoryId: items.categoryId }).from(subscriptions)
    .innerJoin(items, and(eq(items.id, subscriptions.itemId), eq(items.userId, subscriptions.userId)))
    .innerJoin(categories, and(eq(categories.id, items.categoryId), eq(categories.userId, items.userId)))
    .where(and(eq(subscriptions.userId, userId), eq(items.state, "owned"), isNull(items.archivedAt), isNull(categories.archivedAt)))
    .orderBy(asc(subscriptions.nextDueOn), asc(subscriptions.id));
}
function stale() { return new HTTPException(409, { message: "This subscription changed. Reload its details before trying again." }); }
async function current(tx: UserTransaction, userId: string, id: string, revision: number) {
  const [record] = await tx.select().from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.id, id))).for("update");
  if (!record) throw new HTTPException(404, { message: "Subscription not found." });
  if (record.revision !== revision) throw stale();
  return record;
}
function scheduleValues(input: ScheduleInput) {
  return { ...input, nextDueOn: renewalOn(input.billingAnchorOn, input.intervalUnit, input.nextPeriod) };
}
export function createSubscriptionService(db: Database, now = () => new Date()) {
  return {
    async list(userId: string): Promise<SubscriptionsResponse> {
      return withUser(db, userId, async tx => {
        const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
        if (!profile) throw new HTTPException(422, { message: "Open your collection before setting up reminders." });
        const [rows, prefs, identity] = await Promise.all([activeSubscriptions(tx, userId), tx.select().from(reminderPreferences).where(eq(reminderPreferences.userId, userId)), reminderIdentity(tx)]);
        const today = calendarToday(profile.timezone, now());
        const data = rows.map(row => ({ ...row.subscription, name: row.name, categoryId: row.categoryId, state: renewalState(row.subscription, today) }));
        const emailReason = emailAvailability(identity);
        return { data, today, attentionCount: data.filter(row => isAttention(row.state)).length,
          preferences: { enabled: prefs[0]?.enabled ?? false, revision: prefs[0]?.revision ?? 0, blocked: prefs[0]?.blocked ?? false, emailAvailable: emailReason === null, emailReason } };
      });
    },
    create(userId: string, key: string, input: z.infer<typeof subscriptionCreateInput>) {
      return withIdempotency(db, userId, key, "subscription_create", input, async tx => {
        await lockReminders(tx, userId);
        const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
        if (!profile) throw new HTTPException(422, { message: "Open your collection first." });
        let itemId = input.itemId;
        if (itemId) {
          const [item] = await tx.select({ id: items.id }).from(items).innerJoin(categories, and(eq(items.categoryId, categories.id), eq(items.userId, categories.userId)))
            .where(and(eq(items.id, itemId), eq(items.userId, userId), eq(items.state, "owned"), isNull(items.archivedAt), isNull(categories.archivedAt)));
          if (!item) throw new HTTPException(422, { message: "Choose an active owned item from your collection." });
          const [existing] = await tx.select({ id: subscriptions.id }).from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.itemId, itemId)));
          if (existing) throw new HTTPException(409, { message: "This item already has subscription tracking. Open its details to edit it." });
        } else {
          const [category] = await tx.select().from(categories).where(and(eq(categories.userId, userId), eq(categories.id, input.categoryId!), isNull(categories.archivedAt)));
          if (!category) throw new HTTPException(422, { message: "Choose an active collection." });
          const [item] = await tx.insert(items).values({ userId, categoryId: category.id, name: input.name! }).returning();
          itemId = item.id;
        }
        const [subscription] = await tx.insert(subscriptions).values({ userId, itemId, currency: profile.currency, ...scheduleValues(input.schedule) }).returning();
        return { subscription };
      });
    },
    edit(userId: string, key: string, id: string, input: z.infer<typeof subscriptionEditInput>) {
      return withIdempotency(db, userId, key, "subscription_edit", { id, ...input }, async tx => {
        await lockReminders(tx, userId);
        const record = await current(tx, userId, id, input.revision);
        if (record.status === "stopped") throw new HTTPException(409, { message: "Tracking has stopped for this subscription." });
        const schedule = scheduleValues(input.schedule);
        // Rewinding before a resolved date would advance back into it later.
        const [resolved] = await tx.select({ id: renewalResolutions.id }).from(renewalResolutions).where(and(eq(renewalResolutions.userId, userId), eq(renewalResolutions.subscriptionId, id), gte(renewalResolutions.dueOn, schedule.nextDueOn))).limit(1);
        if (resolved) throw new HTTPException(422, { message: "Choose a renewal date after the latest resolved renewal." });
        const [subscription] = await tx.update(subscriptions).set({ ...schedule, revision: record.revision + 1 })
          .where(and(eq(subscriptions.userId, userId), eq(subscriptions.id, id))).returning();
        return { subscription };
      });
    },
    advance(userId: string, key: string, id: string, input: z.infer<typeof subscriptionAdvanceInput>) {
      return withIdempotency(db, userId, key, "subscription_advance", { id, ...input }, async tx => {
        await lockReminders(tx, userId);
        const record = await current(tx, userId, id, input.revision);
        if (record.nextDueOn !== input.dueOn || record.status === "stopped" || (record.endsOn && record.nextDueOn > record.endsOn)) throw stale();
        const [resolution] = await tx.insert(renewalResolutions).values({ userId, subscriptionId: id, dueOn: input.dueOn }).onConflictDoNothing().returning();
        if (!resolution) throw stale();
        const [subscription] = await tx.update(subscriptions).set({ nextPeriod: record.nextPeriod + 1,
          nextDueOn: renewalOn(record.billingAnchorOn, record.intervalUnit, record.nextPeriod + 1), revision: record.revision + 1 })
          .where(and(eq(subscriptions.userId, userId), eq(subscriptions.id, id))).returning();
        return { subscription };
      });
    },
    stop(userId: string, key: string, id: string, input: z.infer<typeof subscriptionStopInput>) {
      return withIdempotency(db, userId, key, "subscription_stop", { id, ...input }, async tx => {
        await lockReminders(tx, userId);
        const record = await current(tx, userId, id, input.revision);
        if (record.status === "stopped") throw new HTTPException(409, { message: "Tracking has already stopped for this subscription." });
        const [subscription] = await tx.update(subscriptions).set({ status: input.endsOn ? "ending" : "stopped", endsOn: input.endsOn, revision: record.revision + 1 })
          .where(and(eq(subscriptions.userId, userId), eq(subscriptions.id, id))).returning();
        return { subscription };
      });
    },
    preferences(userId: string, key: string, input: z.infer<typeof reminderPreferencesInput>) {
      return withIdempotency(db, userId, key, "reminder_preferences", input, async tx => {
        await lockReminders(tx, userId);
        const [record] = await tx.select().from(reminderPreferences).where(eq(reminderPreferences.userId, userId));
        if ((record?.revision ?? 0) !== input.revision) throw new HTTPException(409, { message: "Email settings changed. Reload before trying again." });
        if (input.enabled) {
          const reason = emailAvailability(await reminderIdentity(tx));
          if (reason) throw new HTTPException(422, { message: reason });
          if (record?.blocked) throw new HTTPException(422, { message: "Email is paused after a delivery problem. Resolve it before enabling email again." });
        }
        const values = { enabled: input.enabled, revision: input.revision + 1, unsubscribeNonce: input.enabled ? randomUUID() : record?.unsubscribeNonce ?? randomUUID() };
        await tx.insert(reminderPreferences).values({ userId, ...values }).onConflictDoUpdate({ target: reminderPreferences.userId, set: values });
        return { enabled: values.enabled, revision: values.revision };
      });
    },
    async forItem(userId: string, itemId: string): Promise<Subscription | null> {
      return withUser(db, userId, async tx => (await tx.select().from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.itemId, itemId))))[0] ?? null);
    },
  };
}
export type SubscriptionService = ReturnType<typeof createSubscriptionService>;
