import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDatabase, withUser } from "../src/server/db/client";
import { createInventoryService } from "../src/server/services/inventory";
import { categories, items, operations, profiles, transactions } from "../src/server/db/schema";
import { createApi } from "../src/server/api/app";
import { verifyToken } from "../src/server/api/auth";

config({ path: ".env.test.local", override: true, quiet: true });
const enabled = !!process.env.DATABASE_ADMIN_URL;
if (!enabled && process.env.REQUIRE_DATABASE_TESTS === "1") throw new Error("Run npm run db:setup:local before database tests.");
describe.skipIf(!enabled)("local Postgres integration", () => {
  let admin: ReturnType<typeof postgres>;
  let connection: ReturnType<typeof createDatabase>;
  let service: ReturnType<typeof createInventoryService>;
  const userA = randomUUID(), userB = randomUUID();
  let categoryA: string, categoryB: string;
  let authUserId: string | undefined;
  const purchase = () => ({ name: "Headphones", categoryId: categoryA, amountMinor: 19999, currency: "USD" as const, occurredOn: "2026-10-01", merchant: null, note: null });
  beforeAll(async () => {
    const adminUrl = new URL(process.env.DATABASE_ADMIN_URL!);
    const runtimeUrl = new URL(process.env.DATABASE_URL!);
    if (![adminUrl, runtimeUrl].every(url => ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Integration tests only run against local databases.");
    admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
    connection = createDatabase(runtimeUrl.toString()); service = createInventoryService(connection.db);
    await admin`insert into auth.users(id) values (${userA}), (${userB})`;
    for (const userId of [userA, userB]) await service.bootstrap(userId, { currency: "USD", timezone: "America/New_York" });
    categoryA = (await service.categories(userA))[0].id; categoryB = (await service.categories(userB))[0].id;
  });
  afterAll(async () => {
    if (admin) {
      await admin`delete from auth.users where id in (${userA}, ${userB}, ${authUserId ?? userA})`;
      await admin.end();
    }
    if (connection) await connection.close();
  });
  it("bootstraps one profile and six categories without resetting preferences", async () => {
    await service.bootstrap(userA, { currency: "EUR", timezone: "UTC" });
    expect(await service.categories(userA)).toHaveLength(6);
    const result = await withUser(connection.db, userA, tx => tx.select().from(profiles));
    expect(result).toHaveLength(1); expect(result[0].currency).toBe("USD");
  });
  it("adds an existing possession without creating spending", async () => {
    await service.existingItem(userA, randomUUID(), { name: "Old chair", categoryId: categoryA, acquiredOn: null, description: null });
    expect(await service.transactions(userA, 100, 0)).toHaveLength(0);
  });
  it("records a purchase once even for simultaneous retries", async () => {
    const key = randomUUID();
    const results = await Promise.all([service.purchase(userA, key, purchase()), service.purchase(userA, key, purchase())]);
    expect(results[0].item.id).toBe(results[1].item.id);
    expect(results.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(await service.transactions(userA, 100, 0)).toHaveLength(1);
    await expect(service.purchase(userA, key, { ...purchase(), amountMinor: 1 })).rejects.toMatchObject({ status: 409 });
  });
  it("rolls back the item if the expense violates a database constraint", async () => {
    const before = (await service.items(userA, 100, 0)).length;
    await expect(service.purchase(userA, randomUUID(), { ...purchase(), amountMinor: -1 })).rejects.toBeDefined();
    expect(await service.items(userA, 100, 0)).toHaveLength(before);
  });
  it("isolates users even when a query omits its owner filter", async () => {
    const a = await withUser(connection.db, userA, tx => tx.select().from(items));
    const b = await withUser(connection.db, userB, tx => tx.select().from(items));
    expect(a.length).toBeGreaterThan(0); expect(b).toHaveLength(0);
    expect(await connection.db.select().from(items)).toHaveLength(0);
  });
  it("rejects cross-owner links and ownership reassignment", async () => {
    await expect(withUser(connection.db, userA, tx => tx.insert(items).values({ userId: userA, categoryId: categoryB, name: "Wrong owner" }))).rejects.toBeDefined();
    await expect(withUser(connection.db, userA, tx => tx.update(categories).set({ userId: userB }).where(eq(categories.id, categoryA)))).rejects.toBeDefined();
    await expect(service.purchase(userA, randomUUID(), { ...purchase(), categoryId: categoryB })).rejects.toMatchObject({ status: 422 });
  });
  it("rejects fractional/negative amounts and mismatched currencies in SQL", async () => {
    await expect(withUser(connection.db, userA, tx => tx.insert(transactions).values({ userId: userA, categoryId: categoryA, amountMinor: 0, currency: "USD", occurredOn: "2026-10-01" }))).rejects.toBeDefined();
    await expect(withUser(connection.db, userA, tx => tx.insert(transactions).values({ userId: userA, categoryId: categoryA, amountMinor: 100, currency: "EUR", occurredOn: "2026-10-01" }))).rejects.toBeDefined();
    await expect(withUser(connection.db, userA, tx => tx.update(profiles).set({ currency: "EUR" }).where(eq(profiles.userId, userA)))).rejects.toBeDefined();
  });
  it("uses actual dates and preserves exact spending totals", async () => {
    expect((await service.spending(userA, "2026-10-01", "2026-10-31")).grossSpendingMinor).toBe("19999");
    expect((await service.spending(userA, "2026-09-01", "2026-09-30")).grossSpendingMinor).toBe("0");
  });
  it("filters collections and protects item details across users", async () => {
    const query = { q: "HEAD", sort: "name" as const, limit: 12, offset: 0 };
    const result = await service.collection(userA, query);
    expect(result.total).toBe(1);
    expect(result.data[0].recordedCostMinor).toBe("19999");
    expect((await service.collection(userA, { ...query, offset: 12 })).data).toHaveLength(0);
    expect((await service.collection(userA, { ...query, categoryId: categoryB })).total).toBe(0);
    expect((await service.collection(userA, { ...query, q: "%" })).total).toBe(0);
    expect((await service.collection(userB, { ...query, q: "" })).total).toBe(0);
    const existing = await service.collection(userA, { ...query, q: "Old chair" });
    expect(existing.data[0].recordedCostMinor).toBeNull();
    expect((await service.itemDetail(userA, result.data[0].id)).transactions).toHaveLength(1);
    await expect(service.itemDetail(userB, result.data[0].id)).rejects.toMatchObject({ status: 404 });
  });
  it("keeps monthly history, totals, pagination, and ownership aligned", async () => {
    const input = { from: "2026-10-01", to: "2026-10-31", limit: 1, offset: 0 };
    const history = await service.transactionHistory(userA, input);
    expect(history.total).toBe(1);
    expect(history.data[0]).toMatchObject({ itemName: "Headphones", amountMinor: 19999, occurredOn: "2026-10-01" });
    expect((await service.transactionHistory(userA, { ...input, offset: 1 })).data).toHaveLength(0);
    expect((await service.transactionHistory(userA, { ...input, from: "2026-09-01", to: "2026-09-30" })).total).toBe(0);
    expect((await service.transactionHistory(userB, input)).total).toBe(0);
    // History survives archiving its collection item.
    await withUser(connection.db, userA, tx => tx.update(items).set({ archivedAt: new Date().toISOString() }).where(eq(items.id, history.data[0].itemId!)));
    expect((await service.transactionHistory(userA, input)).data[0].itemArchivedAt).not.toBeNull();
    expect((await service.spending(userA, input.from, input.to)).grossSpendingMinor).toBe("19999");
  });
  it("uses a role without elevated privileges and denies the Data API schema access", async () => {
    const [role] = await connection.db.execute(sql`select rolbypassrls, rolsuper, rolcreaterole from pg_roles where rolname = current_user`);
    expect(role).toMatchObject({ rolbypassrls: false, rolsuper: false, rolcreaterole: false });
    const [grants] = await admin`select has_schema_privilege('anon', 'app', 'usage') as anon, has_schema_privilege('authenticated', 'app', 'usage') as authenticated`;
    expect(grants).toEqual({ anon: false, authenticated: false });
  });
  it("replays an existing-item submission after a lost response and simultaneous retries", async () => {
    const key = randomUUID();
    const input = { name: "Retry chair", categoryId: categoryA, acquiredOn: null, description: null };
    const api = createApi({ verifyToken: async () => userA, service: () => service });
    const request = () => api.request("/api/items", { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(input) });
    const before = (await service.items(userA, 100, 0)).length;
    const spendingBefore = await service.spending(userA, "2026-10-01", "2026-10-31");
    // The server commits, but the browser never receives/uses this response.
    const first = await request();
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const responses = await Promise.all([request(), request()]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...firstBody, replayed: true });
    }
    expect((await service.items(userA, 100, 0)).length).toBe(before + 1);
    expect(await service.spending(userA, "2026-10-01", "2026-10-31")).toEqual(spendingBefore);
    const freshKey = randomUUID();
    const concurrent = await Promise.all([service.existingItem(userA, freshKey, input), service.existingItem(userA, freshKey, input)]);
    expect(concurrent[0].item.id).toBe(concurrent[1].item.id);
    expect(concurrent.map(result => result.replayed).sort()).toEqual([false, true]);
    expect((await service.items(userA, 100, 0)).length).toBe(before + 2);
    expect(concurrent[0].item.id).not.toBe(firstBody.item.id);
    await expect(service.existingItem(userA, key, { ...input, name: "Changed" })).rejects.toMatchObject({ status: 409 });
    await expect(service.purchase(userA, key, purchase())).rejects.toMatchObject({ status: 409 });
    const originalPurchase = (await withUser(connection.db, userA, tx => tx.select().from(operations))).find(operation => operation.operationType === "purchase")!;
    await expect(service.existingItem(userA, originalPurchase.idempotencyKey, input)).rejects.toMatchObject({ status: 409 });
  });
  it("rolls back failed existing-item submissions and can retry the same key", async () => {
    const key = randomUUID();
    const input = { name: "", categoryId: categoryA, acquiredOn: null, description: null };
    const before = (await service.items(userA, 100, 0)).length;
    await expect(service.existingItem(userA, key, input)).rejects.toBeDefined();
    const receipts = await withUser(connection.db, userA, tx => tx.select().from(operations).where(eq(operations.idempotencyKey, key)));
    expect(receipts).toHaveLength(0);
    expect((await service.items(userA, 100, 0)).length).toBe(before);
    expect((await service.existingItem(userA, key, { ...input, name: "Valid chair" })).replayed).toBe(false);
  });
  it("scopes submission keys and receipts to their account", async () => {
    const key = randomUUID();
    const input = { name: "Same key", categoryId: categoryA, acquiredOn: null, description: null };
    const a = await service.existingItem(userA, key, input);
    const b = await service.existingItem(userB, key, { ...input, categoryId: categoryB });
    expect(a.item.id).not.toBe(b.item.id);
    const receipts = await withUser(connection.db, userB, tx => tx.select().from(operations).where(eq(operations.idempotencyKey, key)));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].userId).toBe(userB);
  });
  it("ranks the two latest distinct purchases per collection across all records", async () => {
    const [category] = await withUser(connection.db, userA, tx => tx.insert(categories).values({ userId: userA, name: "Overview fixtures" }).returning());
    const old = await service.purchase(userA, randomUUID(), { ...purchase(), categoryId: category.id, occurredOn: "2020-01-01" });
    const recent = await service.purchase(userA, randomUUID(), { ...purchase(), categoryId: category.id, occurredOn: "2026-10-10" });
    const second = await service.purchase(userA, randomUUID(), { ...purchase(), categoryId: category.id, occurredOn: "2026-10-05" });
    await service.purchase(userA, randomUUID(), { ...purchase(), categoryId: category.id, occurredOn: "2026-10-01" });
    // A later entry/acquisition date without spending is never a recent purchase.
    await service.existingItem(userA, randomUUID(), { name: "Existing possession", categoryId: category.id, acquiredOn: "2030-01-01", description: null });
    // Backfilled records beyond a normal browse page must not truncate previews.
    for (let index = 0; index < 13; index++) await service.purchase(userA, randomUUID(), { ...purchase(), categoryId: category.id, occurredOn: "2026-09-01" });
    await withUser(connection.db, userA, async tx => {
      await tx.update(items).set({ acquiredOn: "1999-01-01" }).where(eq(items.id, recent.item.id));
      await tx.insert(transactions).values({ userId: userA, categoryId: category.id, itemId: recent.item.id, amountMinor: 100, currency: "USD", occurredOn: "2026-10-10" });
    });
    const block = (await service.collectionOverview(userA)).data.find(row => row.category.id === category.id)!;
    expect(block.total).toBe(18);
    expect(block.latest.map(item => item.id)).toEqual([recent.item.id, second.item.id]);
    expect(block.latest[0]).toMatchObject({ purchasedOn: "2026-10-10", recordedCostMinor: "20099" });
    expect((await service.collectionOverview(userB)).data.some(row => row.category.id === category.id)).toBe(false);
    const [sparseCategory, emptyCategory] = await withUser(connection.db, userA, tx => tx.insert(categories).values([{ userId: userA, name: "Sparse fixtures" }, { userId: userA, name: "Empty fixtures" }]).returning());
    const single = await service.purchase(userA, randomUUID(), { ...purchase(), categoryId: sparseCategory.id });
    const sparseOverview = (await service.collectionOverview(userA)).data;
    expect(sparseOverview.find(row => row.category.id === sparseCategory.id)).toMatchObject({ total: 1, latest: [{ id: single.item.id }] });
    expect(sparseOverview.find(row => row.category.id === emptyCategory.id)).toMatchObject({ total: 0, latest: [] });
    const empty = (await service.collectionOverview(userA)).data.find(row => row.category.id === categoryA)!;
    expect(empty.latest.length).toBeLessThanOrEqual(2);
    await withUser(connection.db, userA, tx => tx.update(items).set({ archivedAt: new Date().toISOString() }).where(eq(items.id, recent.item.id)));
    expect((await service.collectionOverview(userA)).data.find(row => row.category.id === category.id)!.latest.map(item => item.id)).not.toContain(recent.item.id);
    // Archived collection categories are not shown on the home screen.
    await withUser(connection.db, userA, tx => tx.update(categories).set({ archivedAt: new Date().toISOString() }).where(eq(categories.id, category.id)));
    expect((await service.collectionOverview(userA)).data.some(row => row.category.id === category.id)).toBe(false);
    expect((await service.itemDetail(userA, old.item.id)).transactions).toHaveLength(1);
  });
  it("saves and replays wishlist entries without changing owned items or spending", async () => {
    const input = { name: "Future headphones", categoryId: categoryA, description: "Consider later", productUrl: "https://example.com/headphones", targetAmountMinor: 15000, priority: 1 };
    const before = await service.spending(userA, "2026-01-01", "2026-12-31");
    const owned = (await service.collection(userA, { q: "", sort: "newest", limit: 100, offset: 0 })).total;
    const key = randomUUID();
    const first = await service.addWant(userA, key, input);
    const retries = await Promise.all([service.addWant(userA, key, input), service.addWant(userA, key, input)]);
    expect(retries.every(row => row.replayed && row.item.id === first.item.id)).toBe(true);
    expect((await service.wants(userA, 12, 0)).data).toHaveLength(1);
    expect(first.item).toMatchObject({ state: "wishlist", targetAmountMinor: 15000, productUrl: input.productUrl, priority: 1, acquiredOn: null });
    expect((await service.itemDetail(userA, first.item.id)).transactions).toHaveLength(0);
    expect((await service.spending(userA, "2026-01-01", "2026-12-31")).grossSpendingMinor).toBe(before.grossSpendingMinor);
    expect((await service.collection(userA, { q: "", sort: "newest", limit: 100, offset: 0 })).total).toBe(owned);
    expect((await service.wants(userA, 12, 1)).data).toHaveLength(0);
    expect((await service.wants(userB, 12, 0)).total).toBe(0);
    await expect(service.itemDetail(userB, first.item.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.addWant(userA, key, { ...input, priority: 2 })).rejects.toMatchObject({ status: 409 });
    await expect(service.existingItem(userA, key, { name: input.name, categoryId: categoryA, description: null, acquiredOn: null })).rejects.toMatchObject({ status: 409 });
    await expect(service.purchase(userA, key, purchase())).rejects.toMatchObject({ status: 409 });
  });
  it("serializes first wishlist submissions, rolls back failures, and isolates keys", async () => {
    const input = { name: "Future lamp", categoryId: categoryA, description: null, productUrl: null, targetAmountMinor: null, priority: 3 };
    const key = randomUUID();
    const simultaneous = await Promise.all([service.addWant(userA, key, input), service.addWant(userA, key, input)]);
    expect(simultaneous[0].item.id).toBe(simultaneous[1].item.id);
    expect(simultaneous.map(row => row.replayed).sort()).toEqual([false, true]);
    const failedKey = randomUUID();
    const total = (await service.wants(userA, 100, 0)).total;
    await expect(service.addWant(userA, failedKey, { ...input, name: " " })).rejects.toBeDefined();
    expect((await service.wants(userA, 100, 0)).total).toBe(total);
    expect(await withUser(connection.db, userA, tx => tx.select().from(operations).where(eq(operations.idempotencyKey, failedKey)))).toHaveLength(0);
    expect((await service.addWant(userA, failedKey, input)).replayed).toBe(false);
    await expect(service.addWant(userA, randomUUID(), { ...input, categoryId: categoryB })).rejects.toMatchObject({ status: 422 });
    const b = await service.addWant(userB, key, { ...input, categoryId: categoryB });
    expect(b.item.id).not.toBe(simultaneous[0].item.id);
    const ordered = (await service.wants(userA, 100, 0)).data;
    expect(ordered[0].priority).toBe(1);
    expect(ordered.at(-1)!.priority).toBe(3);
  });
  it("verifies a real Supabase Auth session through Hono and Drizzle", async () => {
    const authUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    if (!['localhost', '127.0.0.1'].includes(new URL(authUrl).hostname)) throw new Error("Auth integration must stay local.");
    const auth = createClient(authUrl, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await auth.auth.signUp({ email: `inventory-test-${randomUUID()}@example.com`, password: randomUUID() + "aA!1" });
    expect(error).toBeNull(); authUserId = data.user!.id;
    expect(data.session).not.toBeNull();
    const api = createApi({ verifyToken, service: () => service });
    const headers = { Authorization: `Bearer ${data.session!.access_token}`, "Content-Type": "application/json" };
    expect((await api.request("/api/profile/bootstrap", { method: "POST", headers, body: "{}" })).status).toBe(200);
    const categoryResponse = await api.request("/api/categories", { headers });
    const category = (await categoryResponse.json()).data[0].id;
    const result = await api.request("/api/purchases", { method: "POST", headers: { ...headers, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ ...purchase(), categoryId: category }) });
    expect(result.status).toBe(201);
    const spending = await api.request("/api/spending/summary?from=2026-10-01&to=2026-10-31", { headers });
    expect((await spending.json()).grossSpendingMinor).toBe("19999");
    const overview = await api.request("/api/collections/overview", { headers });
    expect((await overview.json()).data.find((row: { category: { id: string } }) => row.category.id === category).latest).toHaveLength(1);
    const wantRequest = { method: "POST", headers: { ...headers, "Idempotency-Key": randomUUID() }, body: JSON.stringify({ name: "Future lamp", categoryId: category, targetAmountMinor: 2500 }) };
    expect((await api.request("/api/wants", wantRequest)).status).toBe(201);
    expect((await api.request("/api/wants", wantRequest)).status).toBe(200);
    expect((await (await api.request("/api/wants", { headers })).json()).total).toBe(1);
    expect((await (await api.request("/api/spending/summary?from=2026-10-01&to=2026-10-31", { headers })).json()).grossSpendingMinor).toBe("19999");
    await auth.auth.signOut();
  });
});
