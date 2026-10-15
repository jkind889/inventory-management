import { z } from "zod";
import { calendarDate } from "./contracts";

export const reminderDays = [0, 1, 3, 7, 14, 30] as const;
export const scheduleInput = z.object({
  amountMinor: z.number().int().min(0).max(999999999999),
  intervalUnit: z.enum(["month", "year"]),
  billingAnchorOn: calendarDate,
  nextPeriod: z.number().int().min(0).max(10000),
  reminderDays: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(7), z.literal(14), z.literal(30)]).nullable(),
  serviceUrl: z.url().max(2048).refine(value => new URL(value).protocol === "https:", "Use an HTTPS link.").nullable(),
  emailEnabled: z.boolean(),
}).strict().refine(value => {
  try { renewalOn(value.billingAnchorOn, value.intervalUnit, value.nextPeriod); return true; } catch { return false; }
}, "The renewal date is outside the supported calendar.");
export const subscriptionCreateInput = z.object({
  itemId: z.uuid().optional(), name: z.string().trim().min(1).max(200).optional(),
  categoryId: z.uuid().optional(), schedule: scheduleInput,
}).strict().refine(value => value.itemId ? !value.name && !value.categoryId : !!value.name && !!value.categoryId, "Choose an existing item or supply a name and category.");
export const subscriptionEditInput = z.object({ revision: z.number().int().min(1), schedule: scheduleInput }).strict();
export const subscriptionAdvanceInput = z.object({ revision: z.number().int().min(1), dueOn: calendarDate }).strict();
export const subscriptionStopInput = z.object({ revision: z.number().int().min(1), endsOn: calendarDate.nullable() }).strict();
export const reminderPreferencesInput = z.object({ enabled: z.boolean(), revision: z.number().int().min(0) }).strict();
export type ScheduleInput = z.infer<typeof scheduleInput>;
export type Subscription = {
  id: string; userId: string; itemId: string; amountMinor: number; currency: string;
  intervalUnit: "month" | "year"; billingAnchorOn: string; nextPeriod: number;
  nextDueOn: string; reminderDays: number | null; serviceUrl: string | null;
  emailEnabled: boolean; status: "active" | "ending" | "stopped"; endsOn: string | null;
  revision: number; createdAt: string; updatedAt: string;
};
export type RenewalState = "off" | "upcoming" | "attention" | "today" | "overdue" | "stopped";
export type SubscriptionEntry = Subscription & { name: string; categoryId: string; state: RenewalState };
export type ReminderPreferences = { enabled: boolean; revision: number; blocked: boolean; emailAvailable: boolean; emailReason: string | null };
export type SubscriptionsResponse = { data: SubscriptionEntry[]; today: string; attentionCount: number; preferences: ReminderPreferences };

// Always calculate from the original anchor, never the last clamped date.
export function renewalOn(anchor: string, unit: "month" | "year", period: number): string {
  const [year, month, day] = anchor.split("-").map(Number);
  const total = year * 12 + month - 1 + period * (unit === "year" ? 12 : 1);
  const targetYear = Math.floor(total / 12), targetMonth = total % 12;
  if (!Number.isInteger(period) || period < 0 || targetYear < 1900 || targetYear > 9999) throw new Error("Unsupported renewal date.");
  const last = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}
export function calendarToday(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}
export function renewalState(subscription: Pick<Subscription, "status" | "endsOn" | "nextDueOn" | "reminderDays">, today: string): RenewalState {
  if (subscription.status === "stopped" || (subscription.endsOn !== null && subscription.nextDueOn > subscription.endsOn)) return "stopped";
  if (subscription.reminderDays === null) return "off";
  const days = calendarDaysBetween(today, subscription.nextDueOn);
  return days < 0 ? "overdue" : days === 0 ? "today" : days <= subscription.reminderDays ? "attention" : "upcoming";
}
export function isAttention(state: RenewalState) { return ["attention", "today", "overdue"].includes(state); }
export const renewalStateLabels: Record<RenewalState, string> = { off: "Reminders off", upcoming: "Upcoming", attention: "Coming up", today: "Due today", overdue: "Past due", stopped: "Tracking stopped" };
