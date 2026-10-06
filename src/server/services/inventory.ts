import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, getTableColumns, gte, isNull, lte, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { Database } from "../db/client";
import { withUser } from "../db/client";
import { categories, items, operations, profiles, transactions } from "../db/schema";
import type { PurchaseInput, bootstrapInput, existingItemInput, collectionInput, transactionListInput } from "../../shared/contracts";

export function createInventoryService(db: Database) {
  return {
    collection(userId: string, input: z.infer<typeof collectionInput>) {
      return withUser(db, userId, async tx => {
        const where = and(eq(items.userId, userId), eq(items.state, "owned"), isNull(items.archivedAt),
          input.categoryId ? eq(items.categoryId, input.categoryId) : undefined,
          input.q ? sql`strpos(lower(${items.name}), lower(${input.q})) > 0` : undefined);
        const order = input.sort === "name" ? asc(items.name) : input.sort === "purchased" ? sql`${items.acquiredOn} desc nulls last` : desc(items.createdAt);
        const data = await tx.select({ ...getTableColumns(items),
          recordedCostMinor: sql<string | null>`(select sum(t.amount_minor)::text from app.transactions t where t.user_id = ${userId} and t.item_id = "items"."id")`,
        }).from(items).where(where).orderBy(order, items.id).limit(input.limit).offset(input.offset);
        const [total] = await tx.select({ count: count() }).from(items).where(where);
        return { data, total: total.count, limit: input.limit, offset: input.offset };
      });
    },
    itemDetail(userId: string, id: string) {
      return withUser(db, userId, async tx => {
        const [item] = await tx.select().from(items).where(and(eq(items.userId, userId), eq(items.id, id), isNull(items.archivedAt)));
        if (!item) throw new HTTPException(404, { message: "This item could not be found." });
        const expenses = await tx.select().from(transactions).where(and(eq(transactions.userId, userId), eq(transactions.itemId, id))).orderBy(desc(transactions.occurredOn), transactions.id);
        return { item, transactions: expenses };
      });
    },
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
    transactionHistory(userId: string, input: z.infer<typeof transactionListInput>) {
      return withUser(db, userId, async tx => {
        const where = and(eq(transactions.userId, userId),
          input.from ? gte(transactions.occurredOn, input.from) : undefined,
          input.to ? lte(transactions.occurredOn, input.to) : undefined);
        const data = await tx.select({ ...getTableColumns(transactions), itemName: items.name,
          categoryName: categories.name, itemArchivedAt: items.archivedAt,
        }).from(transactions)
          .leftJoin(items, and(eq(items.id, transactions.itemId), eq(items.userId, userId)))
          .innerJoin(categories, and(eq(categories.id, transactions.categoryId), eq(categories.userId, userId)))
          .where(where).orderBy(desc(transactions.occurredOn), transactions.id)
          .limit(input.limit).offset(input.offset);
        const [total] = await tx.select({ count: count() }).from(transactions).where(where);
        return { data, total: total.count, limit: input.limit, offset: input.offset };
      });
    },
    transactions(userId: string, limit: number, offset: number) {
      return withUser(db, userId, tx => tx.select().from(transactions).where(eq(transactions.userId, userId)).orderBy(desc(transactions.occurredOn), transactions.id).limit(limit).offset(offset));
    },
    spending(userId: string, from: string, to: string) {
      return withUser(db, userId, async tx => {
        const [profile] = await tx.select({ currency: profiles.currency }).from(profiles).where(eq(profiles.userId, userId));
        if (!profile) throw new HTTPException(409, { message: "Set up your profile first." });
        const breakdown = await tx.select({ categoryId: transactions.categoryId, categoryName: categories.name, amountMinor: sql<string>`sum(${transactions.amountMinor})::text` }).from(transactions)
          .innerJoin(categories, and(eq(categories.id, transactions.categoryId), eq(categories.userId, userId)))
          .where(and(eq(transactions.userId, userId), gte(transactions.occurredOn, from), lte(transactions.occurredOn, to))).groupBy(transactions.categoryId, categories.name);
        // Aggregates are decimal integer strings: never lose precision in large totals.
        const total = breakdown.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n).toString();
        return { currency: profile.currency, from, to, grossSpendingMinor: total, breakdown };
      });
    },
  };
}
export type InventoryService = ReturnType<typeof createInventoryService>;
