import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { Database } from "../db/client";
import { withUser } from "../db/client";
import { categories, items, operations, profiles, transactions } from "../db/schema";
import type { PurchaseInput, bootstrapInput, existingItemInput } from "../../shared/contracts";

export function createInventoryService(db: Database) {
  return {
    bootstrap(userId: string, input: z.infer<typeof bootstrapInput>) {
      return withUser(db, userId, async tx => {
        const [created] = await tx.insert(profiles).values({ userId, ...input }).onConflictDoNothing().returning();
        if (created) {
          await tx.insert(categories).values(["Tech", "Clothes", "Hobbies", "Furniture", "Groceries", "Other"].map(name => ({ userId, name })));
        }
        const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
        return { profile };
      });
    },
    categories(userId: string) {
      return withUser(db, userId, tx => tx.select().from(categories).where(and(eq(categories.userId, userId), isNull(categories.archivedAt))).orderBy(categories.name));
    },
    items(userId: string, limit: number, offset: number) {
      return withUser(db, userId, tx => tx.select().from(items).where(and(eq(items.userId, userId), eq(items.state, "owned"), isNull(items.archivedAt))).orderBy(desc(items.createdAt), items.id).limit(limit).offset(offset));
    },
    existingItem(userId: string, input: z.infer<typeof existingItemInput>) {
      return withUser(db, userId, async tx => {
        const [category] = await tx.select({ id: categories.id }).from(categories).where(and(eq(categories.userId, userId), eq(categories.id, input.categoryId), isNull(categories.archivedAt)));
        if (!category) throw new HTTPException(422, { message: "Choose an active category from your collection." });
        const [item] = await tx.insert(items).values({ userId, ...input }).returning();
        return item;
      });
    },
    purchase(userId: string, key: string, input: PurchaseInput) {
      return withUser(db, userId, async tx => {
        // Serialize retries for this user/key; the lock ends with the transaction.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`}, 0))`);
        const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        const [previous] = await tx.select().from(operations).where(and(eq(operations.userId, userId), eq(operations.idempotencyKey, key)));
        if (previous) {
          if (previous.requestHash !== hash) throw new HTTPException(409, { message: "That request key was already used for a different purchase." });
          return { ...previous.result, replayed: true };
        }
        const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
        if (!profile) throw new HTTPException(409, { message: "Set up your profile first." });
        if (profile.currency !== input.currency) throw new HTTPException(422, { message: "Use your profile's reporting currency." });
        const [category] = await tx.select({ id: categories.id }).from(categories).where(and(eq(categories.userId, userId), eq(categories.id, input.categoryId), isNull(categories.archivedAt)));
        if (!category) throw new HTTPException(422, { message: "Choose an active category from your collection." });
        const [item] = await tx.insert(items).values({ userId, name: input.name, categoryId: input.categoryId, acquiredOn: input.occurredOn }).returning();
        const [transaction] = await tx.insert(transactions).values({
          userId, itemId: item.id, categoryId: input.categoryId, amountMinor: input.amountMinor,
          currency: input.currency, occurredOn: input.occurredOn, merchant: input.merchant, note: input.note,
        }).returning();
        const result = { item, transaction };
        await tx.insert(operations).values({ userId, idempotencyKey: key, operationType: "purchase", requestHash: hash, result });
        return { ...result, replayed: false };
      });
    },
    transactions(userId: string, limit: number, offset: number) {
      return withUser(db, userId, tx => tx.select().from(transactions).where(eq(transactions.userId, userId)).orderBy(desc(transactions.occurredOn), transactions.id).limit(limit).offset(offset));
    },
    spending(userId: string, from: string, to: string) {
      return withUser(db, userId, async tx => {
        const [profile] = await tx.select({ currency: profiles.currency }).from(profiles).where(eq(profiles.userId, userId));
        if (!profile) throw new HTTPException(409, { message: "Set up your profile first." });
        const breakdown = await tx.select({ categoryId: transactions.categoryId, amountMinor: sql<string>`sum(${transactions.amountMinor})::text` }).from(transactions)
          .where(and(eq(transactions.userId, userId), gte(transactions.occurredOn, from), lte(transactions.occurredOn, to))).groupBy(transactions.categoryId);
        // Aggregates are decimal integer strings: never lose precision in large totals.
        const total = breakdown.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n).toString();
        return { currency: profile.currency, from, to, grossSpendingMinor: total, breakdown };
      });
    },
  };
}
export type InventoryService = ReturnType<typeof createInventoryService>;
