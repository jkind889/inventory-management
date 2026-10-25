import type { Tag, TaggedItem } from "../../shared/tags";
import { sql } from "drizzle-orm";
import { bigint, boolean, date, integer, jsonb, pgSchema, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usageFrequencies, worthVerdicts } from "../../shared/reviews";
import type { Subscription } from "../../shared/subscriptions";
import type { Preferences, ImportResult, RestoreResult } from "../../shared/collection-tools";

// Query models only. supabase/migrations owns constraints, indexes, grants, and RLS.
export const appSchema = pgSchema("app");
export const itemState = appSchema.enum("item_state", ["wishlist", "owned", "sold", "returned", "donated"]);
const audit = () => ({
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});
export const profiles = appSchema.table("profiles", {
  userId: uuid("user_id").primaryKey(), displayName: text("display_name"),
  currency: text("currency").notNull().default("USD"), timezone: text("timezone").notNull().default("America/New_York"), ...audit(),
});
export const categories = appSchema.table("categories", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull(), name: text("name").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }), ...audit(),
});
export const items = appSchema.table("items", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull(), categoryId: uuid("category_id").notNull(),
  name: text("name").notNull(), description: text("description"), state: itemState("state").notNull().default("owned"),
  acquiredOn: date("acquired_on"), condition: text("condition"), productUrl: text("product_url"),
  targetAmountMinor: bigint("target_amount_minor", { mode: "number" }), priority: smallint("priority"),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }), ...audit(),
});
export const tags = appSchema.table("tags", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull(), name: text("name").notNull(),
});
export const itemTags = appSchema.table("item_tags", {
  userId: uuid("user_id").notNull(), itemId: uuid("item_id").notNull(), tagId: uuid("tag_id").notNull(), slot: smallint("slot").notNull(),
});
export const transactions = appSchema.table("transactions", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull(), categoryId: uuid("category_id").notNull(),
  itemId: uuid("item_id"), name: text("name"), kind: text("kind").notNull().default("expense"),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(), currency: text("currency").notNull(),
  occurredOn: date("occurred_on").notNull(), merchant: text("merchant"), note: text("note"), ...audit(),
});
export type PurchaseResult = { item: TaggedItem<typeof items.$inferSelect>; transaction: typeof transactions.$inferSelect };
export const itemReviews = appSchema.table("item_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(), itemId: uuid("item_id").notNull(),
  verdict: text("verdict", { enum: worthVerdicts }).notNull(),
  usageFrequency: text("usage_frequency", { enum: usageFrequencies }),
  wouldBuyAgain: boolean("would_buy_again"), note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});
export const itemPhotos = appSchema.table("item_photos", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull(), itemId: uuid("item_id").notNull(),
  storagePath: text("storage_path").notNull(), status: text("status").notNull().default("pending"),
  byteSize: integer("byte_size").notNull(), mimeType: text("mime_type").notNull(), checksum: text("checksum").notNull(),
  expectedCoverId: uuid("expected_cover_id"), width: integer("width"), height: integer("height"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now() + interval '24 hours'`),
  cleanupCheckedAt: timestamp("cleanup_checked_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});
export type OperationResults = {
  subscription_create: { subscription: Subscription };
  subscription_edit: { subscription: Subscription };
  subscription_advance: { subscription: Subscription };
  subscription_stop: { subscription: Subscription };
  reminder_preferences: { enabled: boolean; revision: number };
  item_edit: { item: typeof items.$inferSelect };
  bulk_edit: { updated: number };
  preferences: Preferences;
  collection_import: ImportResult;
  collection_restore: RestoreResult;
  photo_import: { upload: typeof itemPhotos.$inferSelect };
  photo_upload: { upload: typeof itemPhotos.$inferSelect };
  photo_complete: { photoId: string };
  photo_remove: { removedPhotoId: string };
  purchase: PurchaseResult;
  expense: { transaction: typeof transactions.$inferSelect };
  existing_item: { item: TaggedItem<typeof items.$inferSelect> };
  item_tags: { itemId: string; tags: Tag[] };
  item_review: { review: typeof itemReviews.$inferSelect };
};
export const collectionPreferences = appSchema.table("collection_preferences", {
  userId: uuid("user_id").primaryKey(),
  savedViews: jsonb("saved_views").$type<Preferences['savedViews']>().notNull().default([]),
  recentCategoryIds: jsonb("recent_category_ids").$type<string[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});
export const operations = appSchema.table("operations", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull(), idempotencyKey: uuid("idempotency_key").notNull(),
  operationType: text("operation_type").notNull(), requestHash: text("request_hash").notNull(),
  result: jsonb("result").$type<OperationResults[keyof OperationResults]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`),
});

export const subscriptions = appSchema.table("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull(), itemId: uuid("item_id").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(), currency: text("currency").notNull(),
  intervalUnit: text("interval_unit", { enum: ["month", "year"] }).notNull(), billingAnchorOn: date("billing_anchor_on").notNull(),
  nextPeriod: integer("next_period").notNull(), nextDueOn: date("next_due_on").notNull(), reminderDays: smallint("reminder_days"),
  serviceUrl: text("service_url"), emailEnabled: boolean("email_enabled").notNull().default(true),
  status: text("status", { enum: ["active", "ending", "stopped"] }).notNull().default("active"), endsOn: date("ends_on"),
  revision: integer("revision").notNull().default(1), ...audit(),
});
export const renewalResolutions = appSchema.table("renewal_resolutions", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull(), subscriptionId: uuid("subscription_id").notNull(),
  dueOn: date("due_on").notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});
export const reminderPreferences = appSchema.table("reminder_preferences", {
  userId: uuid("user_id").primaryKey(), enabled: boolean("enabled").notNull().default(false),
  blocked: boolean("blocked").notNull().default(false), revision: integer("revision").notNull().default(1),
  unsubscribeNonce: uuid("unsubscribe_nonce").notNull().defaultRandom(), ...audit(),
});
export type DigestPayload = { from: string; to: string[]; subject: string; html: string; text: string; headers: Record<string, string>; tags: { name: string; value: string }[] };
export type DigestEntry = { subscriptionId: string; dueOn: string; reminderDays: number; revision: number };
export const reminderDigests = appSchema.table("reminder_digests", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull(), localDate: date("local_date").notNull(),
  status: text("status", { enum: ["pending", "processing", "accepted", "delivered", "suppressed", "failed", "uncertain", "bounced", "complained"] }).notNull().default("pending"),
  recipient: text("recipient").notNull(), payload: jsonb("payload").$type<DigestPayload>(), entries: jsonb("entries").$type<DigestEntry[]>().notNull(),
  leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "string" }), firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true, mode: "string" }),
  retryAfter: timestamp("retry_after", { withTimezone: true, mode: "string" }), attempts: integer("attempts").notNull().default(0),
  providerId: text("provider_id"), lastError: text("last_error"), ...audit(),
});
export const reminderDeliveries = appSchema.table("reminder_deliveries", {
  userId: uuid("user_id").notNull(), subscriptionId: uuid("subscription_id").notNull(), dueOn: date("due_on").notNull(),
  reminderDays: smallint("reminder_days").notNull(), digestId: uuid("digest_id").notNull(),
});
