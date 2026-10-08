import { sql } from "drizzle-orm";
import { bigint, date, jsonb, pgSchema, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
export const transactions = appSchema.table("transactions", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull(), categoryId: uuid("category_id").notNull(),
  itemId: uuid("item_id"), kind: text("kind").notNull().default("expense"),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(), currency: text("currency").notNull(),
  occurredOn: date("occurred_on").notNull(), merchant: text("merchant"), note: text("note"), ...audit(),
});
export type PurchaseResult = { item: typeof items.$inferSelect; transaction: typeof transactions.$inferSelect };
export type OperationResults = {
  purchase: PurchaseResult;
  existing_item: { item: typeof items.$inferSelect };
};
export const operations = appSchema.table("operations", {
  id: uuid("id").primaryKey().defaultRandom(), userId: uuid("user_id").notNull(), idempotencyKey: uuid("idempotency_key").notNull(),
  operationType: text("operation_type").notNull(), requestHash: text("request_hash").notNull(),
  result: jsonb("result").$type<OperationResults[keyof OperationResults]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().default(sql`now()`),
});
