import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, withUser } from "../src/server/db/client";
import { createInventoryService } from "../src/server/services/inventory";
import { createApi } from "../src/server/api/app";
import { categories, operations, transactions } from "../src/server/db/schema";
import { backupInput, backupTransaction } from "../src/shared/collection-tools";
import { collectionInput } from "../src/shared/contracts";

config({ path: ".env.test.local", override: true, quiet: true });
const enabled = !!process.env.DATABASE_ADMIN_URL;
if (!enabled && process.env.REQUIRE_DATABASE_TESTS === "1") throw new Error("Run npm run db:setup:local before database tests.");

describe.skipIf(!enabled)("standalone purchases in local Postgres", () => {
  let admin: ReturnType<typeof postgres>;
  let connection: ReturnType<typeof createDatabase>;
  let service: ReturnType<typeof createInventoryService>;
  let a: string, b: string, c: string, categoryA: string, categoryB: string;
  const input = () => ({ name: "Weekly groceries", categoryId: categoryA, amountMinor: 4895, currency: "USD" as const, occurredOn: "2026-10-18", merchant: "Market", note: "Fruit and vegetables" });
  beforeEach(async () => {
    for (const variable of ["DATABASE_ADMIN_URL", "DATABASE_URL"]) {
      if (!["localhost", "127.0.0.1"].includes(new URL(process.env[variable]!).hostname)) throw new Error("Local tests only.");
    }
    admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
    connection = createDatabase(process.env.DATABASE_URL!);
    service = createInventoryService(connection.db);
    a = randomUUID(); b = randomUUID(); c = randomUUID();
    await admin`insert into auth.users(id) values (${a}), (${b}), (${c})`;
    for (const user of [a, b, c]) await service.bootstrap(user, { currency: "USD", timezone: "America/New_York" });
    categoryA = (await service.categories(a))[0].id;
    categoryB = (await service.categories(b))[0].id;
  });
  afterEach(async () => {
    if (admin) { await admin`delete from auth.users where id in (${a}, ${b}, ${c})`; await admin.end(); }
    if (connection) await connection.close();
  });
  it("replays a lost response and simultaneous retries with one expense and no item", async () => {
    const api = createApi({ verifyToken: async () => a, service: () => service });
    const key = randomUUID();
    const request = () => api.request("/api/expenses", { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(input()) });
    const first = await request();
    expect(first.status).toBe(201);
    const original = await first.json();
    expect(original.transaction).toMatchObject({ name: "Weekly groceries", itemId: null, amountMinor: 4895 });
    expect(original).not.toHaveProperty("item");
    for (const retry of await Promise.all([request(), request()])) {
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ ...original, replayed: true });
    }
    // Race a fresh key too: two first submissions must serialize before either receipt exists.
    const nextKey = randomUUID();
    const concurrent = await Promise.all([service.expense(a, nextKey, input()), service.expense(a, nextKey, input())]);
    expect(concurrent.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(concurrent[0].transaction).toEqual(concurrent[1].transaction);
    expect(await service.transactions(a, 100, 0)).toHaveLength(2);
    expect(await service.items(a, 100, 0)).toHaveLength(0);
    expect(await withUser(connection.db, a, tx => tx.select().from(operations))).toHaveLength(2);
  });
  it("rejects changed content and cross-operation key reuse in both directions", async () => {
    const key = randomUUID();
    await service.expense(a, key, input());
    for (const change of [{ name: "Dinner" }, { amountMinor: 1 }, { merchant: "Other" }, { occurredOn: "2026-10-17" }, { note: null }]) {
      await expect(service.expense(a, key, { ...input(), ...change })).rejects.toMatchObject({ status: 409 });
    }
    await expect(service.purchase(a, key, input())).rejects.toMatchObject({ status: 409 });
    const itemKey = randomUUID();
    await service.purchase(a, itemKey, input());
    await expect(service.expense(a, itemKey, input())).rejects.toMatchObject({ status: 409 });
    expect(await service.items(a, 100, 0)).toHaveLength(1);
    expect(await service.transactions(a, 100, 0)).toHaveLength(2);
  });
  it("rolls back failed expenses and receipts and permits a valid retry", async () => {
    const key = randomUUID();
    await expect(service.expense(a, key, { ...input(), amountMinor: -1 })).rejects.toBeDefined();
    expect(await service.transactions(a, 100, 0)).toEqual([]);
    expect(await withUser(connection.db, a, tx => tx.select().from(operations).where(eq(operations.idempotencyKey, key)))).toEqual([]);
    expect(await service.expense(a, key, input())).toMatchObject({ replayed: false });
    expect(await service.items(a, 100, 0)).toEqual([]);
    for (const name of ["", " ", " not trimmed ", "x".repeat(201)]) {
      await expect(withUser(connection.db, a, tx => tx.insert(transactions).values({ userId: a, ...input(), name }))).rejects.toBeDefined();
    }
    expect(await service.transactions(a, 100, 0)).toHaveLength(1);
  });
  it("isolates receipts, transactions, and categories by account", async () => {
    const key = randomUUID();
    const [first, second] = await Promise.all([service.expense(a, key, input()), service.expense(b, key, { ...input(), categoryId: categoryB })]);
    expect(first.transaction.id).not.toBe(second.transaction.id);
    expect(first.replayed).toBe(false); expect(second.replayed).toBe(false);
    expect(await withUser(connection.db, a, tx => tx.select().from(transactions))).toHaveLength(1);
    expect((await withUser(connection.db, b, tx => tx.select().from(transactions)))[0].id).toBe(second.transaction.id);
    expect(await connection.db.select().from(transactions)).toEqual([]);
    await expect(service.expense(a, randomUUID(), { ...input(), categoryId: categoryB })).rejects.toMatchObject({ status: 422 });
    await expect(service.expense(a, randomUUID(), { ...input(), currency: "EUR" })).rejects.toMatchObject({ status: 422 });
    await withUser(connection.db, a, tx => tx.update(categories).set({ archivedAt: new Date().toISOString() }).where(eq(categories.id, categoryA)));
    await expect(service.expense(a, randomUUID(), input())).rejects.toMatchObject({ status: 422 });
    expect(await service.expense(a, key, input())).toMatchObject({ replayed: true });
  });
  it("includes named expenses in monthly history and totals without populating collection views", async () => {
    await service.expense(a, randomUUID(), input());
    await service.expense(a, randomUUID(), { ...input(), name: "Last month", occurredOn: "2026-09-30", amountMinor: 100 });
    const query = { from: "2026-10-01", to: "2026-10-31", limit: 1, offset: 0 };
    expect(await service.transactionHistory(a, query)).toMatchObject({ total: 1, data: [{ name: "Weekly groceries", itemId: null, itemName: null, amountMinor: 4895 }] });
    expect((await service.transactionHistory(a, { ...query, offset: 1 })).data).toEqual([]);
    expect((await service.spending(a, query.from, query.to)).grossSpendingMinor).toBe("4895");
    expect((await service.spending(b, query.from, query.to)).grossSpendingMinor).toBe("0");
    expect((await service.collection(a, collectionInput.parse({ state: "all" }))).total).toBe(0);
    expect((await service.collectionOverview(a)).data.every(row => row.total === 0 && row.latest.length === 0)).toBe(true);
  });
  it("round-trips named standalone spending and accepts legacy backups without name", async () => {
    const expense = await service.expense(a, randomUUID(), input());
    const { backup } = await service.backup(a);
    expect(backup.items).toEqual([]);
    expect(backup.transactions[0]).toMatchObject({ name: "Weekly groceries", itemId: null });
    const restoreKey = randomUUID();
    await service.restoreCollection(b, restoreKey, backupInput.parse(backup));
    expect(await service.restoreCollection(b, restoreKey, backupInput.parse(backup))).toMatchObject({ replayed: true });
    const restored = (await service.backup(b)).backup;
    expect(restored.items).toEqual([]);
    expect(restored.transactions[0]).toMatchObject({ name: "Weekly groceries", itemId: null, amountMinor: 4895, merchant: "Market", note: "Fruit and vegetables" });
    expect(restored.transactions[0].id).not.toBe(expense.transaction.id);
    const legacy = structuredClone(backup);
    delete legacy.transactions[0].name;
    const parsed = backupInput.parse(legacy);
    expect(parsed.transactions[0]).not.toHaveProperty("name");
    expect(backupTransaction.parse(legacy.transactions[0])).not.toHaveProperty("name");
    await service.restoreCollection(c, randomUUID(), parsed);
    expect((await service.backup(c)).backup.transactions[0]).toMatchObject({ name: null, itemId: null, amountMinor: 4895 });
  });
});
