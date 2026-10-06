import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDatabase, withUser } from "../src/server/db/client";
import { createInventoryService } from "../src/server/services/inventory";
import { categories, items, profiles, transactions } from "../src/server/db/schema";
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
    await service.existingItem(userA, { name: "Old chair", categoryId: categoryA, acquiredOn: null, description: null });
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
    await auth.auth.signOut();
  });
});
