import { createHash, randomUUID } from "node:crypto";
import { config } from "dotenv";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, withUser } from "../src/server/db/client";
import { createInventoryService } from "../src/server/services/inventory";
import { itemTags, items, operations, tags } from "../src/server/db/schema";
import { existingItemInput, wantInput, purchaseInput } from "../src/shared/contracts";
import { replaceTags } from "../src/server/services/tags";
import { withIdempotency } from "../src/server/services/idempotency";

config({ path: ".env.test.local", override: true, quiet: true });
const enabled = !!process.env.DATABASE_ADMIN_URL;
if (!enabled && process.env.REQUIRE_DATABASE_TESTS === "1") throw new Error("Set up the local database first.");
describe.skipIf(!enabled)("tags local database", () => {
  let admin: ReturnType<typeof postgres>;
  let connection: ReturnType<typeof createDatabase>;
  let service: ReturnType<typeof createInventoryService>;
  const a = randomUUID(), b = randomUUID();
  let categoryA: string, categoryA2: string, categoryB: string;
  const entry = (name: string, names: string[] = []) => existingItemInput.parse({ name, categoryId: categoryA, tags: names });
  const query = { q: "", sort: "name" as const, limit: 1, offset: 0 };
  beforeAll(async () => {
    const adminUrl = new URL(process.env.DATABASE_ADMIN_URL!);
    const runtimeUrl = new URL(process.env.DATABASE_URL!);
    if (![adminUrl, runtimeUrl].every(url => ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Local database only");
    admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
    connection = createDatabase(runtimeUrl.toString()); service = createInventoryService(connection.db);
    await admin`insert into auth.users(id) values (${a}), (${b})`;
    for (const id of [a, b]) await service.bootstrap(id, { currency: "USD", timezone: "America/New_York" });
    [categoryA, categoryA2] = (await service.categories(a)).map(row => row.id);
    categoryB = (await service.categories(b))[0].id;
  });
  afterAll(async () => {
    if (admin) { await admin`delete from auth.users where id in (${a}, ${b})`; await admin.end(); }
    if (connection) await connection.close();
  });
  it("reuses tags across collections and wants and creates purchase tags atomically", async () => {
    const first = await service.existingItem(a, randomUUID(), entry("Tent", [" CAMPING ", "seasonal"]));
    const second = await service.existingItem(a, randomUUID(), { ...entry("Bag", ["camping"]), categoryId: categoryA2 });
    const want = await service.addWant(a, randomUUID(), wantInput.parse({ name: "Wishlist stove", categoryId: categoryA, tags: ["Camping"] }));
    const purchased = await service.purchase(a, randomUUID(), purchaseInput.parse({ name: "New torch", categoryId: categoryA, amountMinor: 100, currency: "USD", occurredOn: "2026-10-09", tags: ["camping"] }));
    const id = first.item.tags.find(tag => tag.name === "camping")!.id;
    expect([second, want, purchased].map(result => result.item.tags[0].id)).toEqual([id, id, id]);
    expect((await service.itemDetail(a, first.item.id)).item.tags).toHaveLength(2);
  });
  it("matches all tags, tag-name search, category and pagination without duplicate rows", async () => {
    const catalog = await service.tags(a, { q: "", limit: 100, offset: 0 });
    const camping = catalog.data.find(tag => tag.name === "camping")!.id;
    const seasonal = catalog.data.find(tag => tag.name === "seasonal")!.id;
    const result = await service.collection(a, { ...query, q: "CAMP", tagId: [camping] });
    expect(result.total).toBe(3); expect(result.data).toHaveLength(1);
    const next = await service.collection(a, { ...query, tagId: [camping], offset: 1 });
    expect(next.data[0].id).not.toBe(result.data[0].id);
    expect((await service.collection(a, { ...query, tagId: [camping, seasonal] })).total).toBe(1);
    expect((await service.collection(a, { ...query, tagId: [camping], categoryId: categoryA2 })).total).toBe(1);
    expect((await service.wants(a, { ...query, tagId: [camping] })).total).toBe(1);
    expect((await service.collection(a, { ...query, q: "%" })).total).toBe(0);
  });
  it("isolates catalogs, item/tag links, ownership reassignment and foreign-item writes", async () => {
    expect((await service.tags(b, { q: "", limit: 100, offset: 0 })).total).toBe(0);
    expect(await connection.db.select().from(tags)).toHaveLength(0);
    expect(await withUser(connection.db, b, tx => tx.select().from(itemTags))).toHaveLength(0);
    const owned = (await service.collection(a, { ...query, limit: 100 })).data[0];
    const other = await service.existingItem(b, randomUUID(), { ...entry("Other"), categoryId: categoryB });
    await expect(service.setItemTags(b, owned.id, randomUUID(), ["hidden"])).rejects.toMatchObject({ status: 404 });
    await expect(withUser(connection.db, b, tx => tx.insert(itemTags).values({ userId: b, itemId: other.item.id, tagId: owned.tags[0].id, slot: 1 }))).rejects.toBeDefined();
    await expect(withUser(connection.db, a, tx => tx.update(tags).set({ userId: b }).where(eq(tags.id, owned.tags[0].id)))).rejects.toBeDefined();
    expect((await service.collection(b, { ...query, tagId: [owned.tags[0].id] })).total).toBe(0);
  });
  it("enforces SQL name rules, Unicode length, slots, duplicates and five assignments", async () => {
    for (const name of ["", "UPPER", " a", "a  b", "a\u00a0b", "a\nb", "a\u0085b", "😀".repeat(31)]) {
      await expect(withUser(connection.db, a, tx => tx.insert(tags).values({ userId: a, name }))).rejects.toBeDefined();
    }
    const unicode = await service.existingItem(a, randomUUID(), entry("Unicode", ["😀".repeat(30)]));
    expect(unicode.item.tags[0].name).toBe("😀".repeat(30));
    const item = await service.existingItem(a, randomUUID(), entry("Full", ["one", "two", "three", "four", "five"]));
    await expect(service.setItemTags(a, item.item.id, randomUUID(), ["one", "two", "three", "four", "five", "six"])).rejects.toBeDefined();
    const [extra] = await withUser(connection.db, a, tx => tx.insert(tags).values({ userId: a, name: "extra" }).returning());
    for (const slot of [0, 1, 6]) await expect(withUser(connection.db, a, tx => tx.insert(itemTags).values({ userId: a, itemId: item.item.id, tagId: extra.id, slot }))).rejects.toBeDefined();
    await expect(withUser(connection.db, a, tx => tx.insert(itemTags).values({ userId: a, itemId: item.item.id, tagId: item.item.tags[0].id, slot: 2 }))).rejects.toBeDefined();
  });
  it("replays concurrent saves, rejects key conflicts, and does not reapply an older receipt", async () => {
    const item = await service.existingItem(a, randomUUID(), entry("Retry"));
    const key = randomUUID();
    const results = await Promise.all([service.setItemTags(a, item.item.id, key, ["z", "a"]), service.setItemTags(a, item.item.id, key, ["a", "z"])]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(results[0].tags).toEqual(results[1].tags);
    await expect(service.setItemTags(a, item.item.id, key, ["changed"])).rejects.toMatchObject({ status: 409 });
    await expect(service.existingItem(a, key, entry("Conflict"))).rejects.toMatchObject({ status: 409 });
    await expect(service.setItemTags(a, results[0].tags[0].id, key, ["a", "z"])).rejects.toMatchObject({ status: 409 });
    await service.setItemTags(a, item.item.id, randomUUID(), []);
    expect((await service.setItemTags(a, item.item.id, key, ["z", "a"])).replayed).toBe(true);
    expect((await service.itemDetail(a, item.item.id)).item.tags).toEqual([]);
    expect((await service.tags(a, { q: "z", limit: 100, offset: 0 })).data.some(tag => tag.name === "z")).toBe(true);
  });
  it("serializes distinct saves without mixing assignments", async () => {
    const item = await service.existingItem(a, randomUUID(), entry("Concurrent"));
    const lists = [["alpha", "beta", "gamma", "delta", "epsilon"], ["alpha", "beta", "gamma", "delta", "zeta"]];
    await Promise.all(lists.map(list => service.setItemTags(a, item.item.id, randomUUID(), list)));
    const final = (await service.itemDetail(a, item.item.id)).item.tags.map(tag => tag.name).sort();
    expect(lists.map(list => [...list].sort())).toContainEqual(final);
  });
  it("rolls back tag creation, replacement and receipt together", async () => {
    const item = await service.existingItem(a, randomUUID(), entry("Rollback", ["original"]));
    const key = randomUUID();
    await expect(withIdempotency(connection.db, a, key, "item_tags", { itemId: item.item.id, tags: ["rollback-only"] }, async tx => {
      await replaceTags(tx, a, item.item.id, ["rollback-only"]);
      throw new Error("Injected failure");
    })).rejects.toThrow("Injected failure");
    expect((await service.itemDetail(a, item.item.id)).item.tags.map(tag => tag.name)).toEqual(["original"]);
    expect((await service.tags(a, { q: "rollback-only", limit: 100, offset: 0 })).total).toBe(0);
    expect(await withUser(connection.db, a, tx => tx.select().from(operations).where(eq(operations.idempotencyKey, key)))).toHaveLength(0);
    expect((await service.setItemTags(a, item.item.id, key, ["rollback-only"])).replayed).toBe(false);
  });
  it("preserves historical creation hashes and supplies tags for old receipts", async () => {
    const payload = existingItemInput.parse({ name: "Legacy", categoryId: categoryA });
    const [item] = await withUser(connection.db, a, tx => tx.insert(items).values({ userId: a, ...payload }).returning());
    const key = randomUUID();
    await withUser(connection.db, a, tx => tx.insert(operations).values({ userId: a, idempotencyKey: key, operationType: "existing_item", requestHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), result: { item } as never }));
    const result = await service.existingItem(a, key, { ...payload, tags: [] });
    expect(result.replayed).toBe(true); expect(result.item.id).toBe(item.id); expect(result.item.tags).toEqual([]);
  });
  it("replays historical purchase and wishlist receipts with omitted or empty tags", async () => {
    const purchase = purchaseInput.parse({ name: "Legacy purchase", categoryId: categoryA, amountMinor: 12, currency: "USD", occurredOn: "2026-10-09" });
    const want = wantInput.parse({ name: "Legacy want", categoryId: categoryA });
    for (const type of ["purchase", "want"] as const) {
      const key = randomUUID();
      const created = type === "purchase" ? await service.purchase(a, key, purchase) : await service.addWant(a, key, want);
      const hashInput = type === "purchase" ? purchase : { ...want, state: "wishlist" };
      const [receipt] = await admin`select request_hash from app.operations where user_id = ${a} and idempotency_key = ${key}`;
      expect(receipt.request_hash).toBe(createHash("sha256").update(JSON.stringify(hashInput)).digest("hex"));
      await admin`update app.operations set result = result #- '{item,tags}' where user_id = ${a} and idempotency_key = ${key}`;
      const replay = type === "purchase" ? await service.purchase(a, key, { ...purchase, tags: [] }) : await service.addWant(a, key, { ...want, tags: [] });
      expect(replay.replayed).toBe(true); expect(replay.item.id).toBe(created.item.id); expect(replay.item.tags).toEqual([]);
    }
  });
  it("paginates the full tag catalog with stable ordering and literal searches", async () => {
    const full = await service.tags(a, { q: "", limit: 100, offset: 0 });
    const first = await service.tags(a, { q: "", limit: 3, offset: 0 });
    const second = await service.tags(a, { q: "", limit: 3, offset: 3 });
    expect(first.total).toBe(full.total); expect(second.total).toBe(full.total);
    expect([...first.data, ...second.data]).toEqual(full.data.slice(0, 6));
    expect((await service.tags(a, { q: "%", limit: 100, offset: 0 })).total).toBe(0);
    expect((await service.tags(a, { q: "CAMP", limit: 100, offset: 0 })).data.map(tag => tag.name)).toEqual(["camping"]);
  });
  it("creates once with tagged submissions and scopes identical keys to their accounts", async () => {
    const key = randomUUID();
    const input = entry("Tagged retry", ["reused"]);
    const [first, replay] = await Promise.all([service.existingItem(a, key, input), service.existingItem(a, key, input)]);
    expect(first.item.id).toBe(replay.item.id);
    expect(first.item.tags).toEqual(replay.item.tags);
    const other = await service.existingItem(b, key, { ...input, categoryId: categoryB });
    expect(other.item.tags[0].id).not.toBe(first.item.tags[0].id);
    await expect(service.existingItem(a, key, { ...input, tags: ["different"] })).rejects.toMatchObject({ status: 409 });
  });
});
