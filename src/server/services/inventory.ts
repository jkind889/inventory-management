import { and, asc, count, desc, eq, getTableColumns, gte, isNull, lte, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import type { Database } from "../db/client";
import { withUser } from "../db/client";
import { categories, itemReviews, items, profiles, transactions } from "../db/schema";
import { starterCategories } from "../../shared/collection";
import type { itemReviewInput } from "../../shared/contracts";
import { withIdempotency } from "./idempotency";
import type { PurchaseInput, bootstrapInput, existingItemInput, wantInput, wantsListInput, collectionInput, transactionListInput } from "../../shared/contracts";

export function createInventoryService(db: Database) {
  return {
    collectionOverview(userId: string) {
      return withUser(db, userId, async tx => {
        const active = await tx.select().from(categories).where(and(eq(categories.userId, userId), isNull(categories.archivedAt))).orderBy(categories.createdAt, categories.id);
        const totals = await tx.select({ categoryId: items.categoryId, total: count() }).from(items)
          .where(and(eq(items.userId, userId), eq(items.state, "owned"), isNull(items.archivedAt))).groupBy(items.categoryId);
        // Rank distinct purchased items per collection, across the complete
        // collection, using actual transaction dates rather than entry dates.
        const ranked = tx.select({ ...getTableColumns(items),
          recordedCostMinor: sql<string>`sum(${transactions.amountMinor})::text`.as("recorded_cost"),
          purchasedOn: sql<string>`max(${transactions.occurredOn})::text`.as("purchased_on"),
          rank: sql<number>`row_number() over (partition by ${items.categoryId} order by max(${transactions.occurredOn}) desc, ${items.createdAt} desc, ${items.id})`.as("purchase_rank"),
        }).from(items).innerJoin(transactions, and(eq(transactions.itemId, items.id), eq(transactions.userId, userId)))
          .where(and(eq(items.userId, userId), eq(items.state, "owned"), isNull(items.archivedAt))).groupBy(items.id).as("ranked");
        const latest = await tx.select().from(ranked).where(lte(ranked.rank, 2)).orderBy(ranked.categoryId, ranked.rank);
        const order = starterCategories;
        active.sort((a, b) => (order.indexOf(a.name) < 0 ? order.length : order.indexOf(a.name)) - (order.indexOf(b.name) < 0 ? order.length : order.indexOf(b.name)) || a.name.localeCompare(b.name));
        return { data: active.map(category => ({ category, total: totals.find(row => row.categoryId === category.id)?.total ?? 0,
          latest: latest.filter(item => item.categoryId === category.id),
        })) };
      });
    },
    wants(userId: string, input: z.infer<typeof wantsListInput>) {
      const { limit, offset } = input;
      return withUser(db, userId, async tx => {
        const where = and(eq(items.userId, userId), eq(items.state, "wishlist"), isNull(items.archivedAt),
          input.categoryId ? eq(items.categoryId, input.categoryId) : undefined,
          input.q ? sql`strpos(lower(${items.name}), lower(${input.q})) > 0` : undefined);
        const order = input.sort === "name" ? [asc(items.name)] : input.sort === "newest" ? [desc(items.createdAt)] : [sql`${items.priority} asc nulls last`, desc(items.createdAt)];
        const data = await tx.select().from(items).where(where).orderBy(...order, items.id).limit(limit).offset(offset);
        const [total] = await tx.select({ count: count() }).from(items).where(where);
        return { data, total: total.count, limit, offset };
      });
    },
    addWant(userId: string, key: string, input: z.infer<typeof wantInput>) {
      // The existing_item receipt represents item-only creation. Include state
      // in its hash so a key cannot be reused between owned and wishlist flows.
      const payload = { ...input, state: "wishlist" as const };
      return withIdempotency(db, userId, key, "existing_item", payload, async tx => {
        const [category] = await tx.select({ id: categories.id }).from(categories).where(and(eq(categories.userId, userId), eq(categories.id, input.categoryId), isNull(categories.archivedAt)));
        if (!category) throw new HTTPException(422, { message: "Choose an active category from your collection." });
        const [item] = await tx.insert(items).values({ userId, ...payload }).returning();
        return { item };
      });
    },
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
        const reviews = await tx.select().from(itemReviews).where(and(eq(itemReviews.userId, userId), eq(itemReviews.itemId, id))).orderBy(desc(itemReviews.createdAt), desc(itemReviews.id)).limit(20);
        return { item, transactions: expenses, reviews };
      });
    },
    addItemReview(userId: string, id: string, key: string, input: z.infer<typeof itemReviewInput>) {
      // Include the item in the receipt hash: a key cannot be reused for another item.
      return withIdempotency(db, userId, key, "item_review", { itemId: id, ...input }, async tx => {
        const [item] = await tx.select().from(items).where(and(eq(items.userId, userId), eq(items.id, id), isNull(items.archivedAt))).for("update");
        if (!item) throw new HTTPException(404, { message: "This item could not be found." });
        if (item.state === "wishlist") throw new HTTPException(422, { message: "Review an item after you have acquired it." });
        const [review] = await tx.insert(itemReviews).values({ userId, itemId: id, ...input }).returning();
        return { review };
      });
    },
    bootstrap(userId: string, input: z.infer<typeof bootstrapInput>) {
      return withUser(db, userId, async tx => {
        const [created] = await tx.insert(profiles).values({ userId, ...input }).onConflictDoNothing().returning();
        if (created) {
          await tx.insert(categories).values(starterCategories.map(name => ({ userId, name })));
        }
        // Also cover existing accounts; the owner/name index makes retries safe.
        await tx.insert(categories).values({ userId, name: "Subscriptions" }).onConflictDoNothing();
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
    existingItem(userId: string, key: string, input: z.infer<typeof existingItemInput>) {
      return withIdempotency(db, userId, key, "existing_item", input, async tx => {
        const [category] = await tx.select({ id: categories.id }).from(categories).where(and(eq(categories.userId, userId), eq(categories.id, input.categoryId), isNull(categories.archivedAt)));
        if (!category) throw new HTTPException(422, { message: "Choose an active category from your collection." });
        const [item] = await tx.insert(items).values({ userId, ...input }).returning();
        return { item };
      });
    },
    purchase(userId: string, key: string, input: PurchaseInput) {
      return withIdempotency(db, userId, key, "purchase", input, async tx => {
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
        return { item, transaction };
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
