import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, withUser } from "../src/server/db/client";
import { items } from "../src/server/db/schema";
import * as schema from "../src/server/db/schema";
import { lockCollection } from "../src/server/services/collection-tools";
import { createInventoryService } from "../src/server/services/inventory";
import { createSubscriptionService } from "../src/server/services/subscriptions";

config({ path: ".env.test.local", override: true, quiet: true });
const enabled = !!process.env.DATABASE_ADMIN_URL;
if (!enabled && process.env.REQUIRE_DATABASE_TESTS === "1") throw new Error("Set up the local database first.");

describe.skipIf(!enabled)("collection mixed-operation locking", () => {
  const userId = randomUUID();
  const accounts = [userId];
  let admin: ReturnType<typeof postgres>;
  let connection: ReturnType<typeof createDatabase>;
  let service: ReturnType<typeof createInventoryService>;
  let categoryId: string;

  beforeAll(async () => {
    for (const value of [process.env.DATABASE_ADMIN_URL!, process.env.DATABASE_URL!]) {
      if (!["localhost", "127.0.0.1"].includes(new URL(value).hostname)) throw new Error("Local database only");
    }
    admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
    connection = createDatabase(process.env.DATABASE_URL!);
    service = createInventoryService(connection.db);
    await admin`insert into auth.users(id) values (${userId})`;
    await service.bootstrap(userId, { currency: "USD", timezone: "UTC" });
    categoryId = (await service.categories(userId))[0].id;
  });

  afterAll(async () => {
    if (admin) { for (const id of accounts) await admin`delete from auth.users where id=${id}`; await admin.end(); }
    if (connection) await connection.close();
  });

  async function waitForBlockedWriter(blockerPid: number, count = 1) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const blocked = await admin`with recursive blocked as (
        select pid from pg_stat_activity where ${blockerPid} = any(pg_blocking_pids(pid))
        union
        select activity.pid from pg_stat_activity activity join blocked
          on blocked.pid = any(pg_blocking_pids(activity.pid))
      ) select pid from blocked`;
      if (blocked.length >= count) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("The concurrent writer did not reach the expected lock barrier.");
  }

  it("lets an item edit acquire its item after a concurrent tag save starts waiting", async () => {
    const { item } = await service.existingItem(userId, randomUUID(), {
      name: "Lock barrier", categoryId, acquiredOn: null, description: null,
    });
    let tagSave: ReturnType<typeof service.setItemTags> | undefined;
    try {
      await withUser(connection.db, userId, async tx => {
        await tx.execute(sql`set local lock_timeout = '3s'`);
        await lockCollection(tx, userId);
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        // Pause at the exact profile -> item boundary used by editItem. The old
        // tag path held the item while waiting for this profile's FK lock.
        tagSave = service.setItemTags(userId, item.id, randomUUID(), ["new concurrent tag"]);
        void tagSave.catch(() => {});
        await waitForBlockedWriter(pid);
        const selected = await tx.select().from(items)
          .where(and(eq(items.userId, userId), eq(items.id, item.id))).for("update");
        expect(selected).toHaveLength(1);
      });
      expect((await tagSave)!.tags.map(tag => tag.name)).toEqual(["new concurrent tag"]);
    } finally {
      await tagSave?.catch(() => {});
    }
  });

  it("preserves both mixed saves and returns their original results on concurrent retries", async () => {
    const { item } = await service.existingItem(userId, randomUUID(), {
      name: "Before mixed save", categoryId, acquiredOn: "2026-10-01", description: "Keep notes",
    });
    const editKey = randomUUID(), tagKey = randomUUID();
    const changes = { name: "After mixed save" };
    const [edit, tagged] = await Promise.all([
      service.editItem(userId, item.id, editKey, changes),
      service.setItemTags(userId, item.id, tagKey, ["mixed save"]),
    ]);
    expect(edit.replayed).toBe(false);
    expect(tagged.replayed).toBe(false);
    const [editRetry, tagRetry] = await Promise.all([
      service.editItem(userId, item.id, editKey, changes),
      service.setItemTags(userId, item.id, tagKey, ["mixed save"]),
    ]);
    expect(editRetry).toEqual({ ...edit, replayed: true });
    expect(tagRetry).toEqual({ ...tagged, replayed: true });
    const detail = await service.itemDetail(userId, item.id);
    expect(detail.item).toMatchObject({ name: changes.name, description: "Keep notes", acquiredOn: "2026-10-01", categoryId });
    expect(detail.item.tags.map(tag => tag.name)).toEqual(["mixed save"]);
    expect(detail.transactions).toEqual([]);
  });

  it("allows item-first review writes to finish while the collection profile is locked", async () => {
    const { item } = await service.existingItem(userId, randomUUID(), {
      name: "Review compatibility", categoryId, acquiredOn: null, description: null,
    });
    const reviewKey = randomUUID();
    const input = { verdict: "worth_it" as const, usageFrequency: null, wouldBuyAgain: true, note: "Preserve review" };
    // A separate connection gives this writer a bounded lock timeout, so a
    // regression fails rather than waiting forever for this transaction.
    const reviewClient = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {}, connection: { lock_timeout: 2000 } });
    const reviewService = createInventoryService(drizzle(reviewClient, { schema }));
    try {
      const review = await withUser(connection.db, userId, async tx => {
        await lockCollection(tx, userId);
        return reviewService.addItemReview(userId, item.id, reviewKey, input);
      });
      expect(review.replayed).toBe(false);
      expect((await service.addItemReview(userId, item.id, reviewKey, input)).replayed).toBe(true);
      expect((await service.itemDetail(userId, item.id)).reviews.map(saved => saved.id)).toEqual([review.review.id]);
    } finally {
      await reviewClient.end();
    }
  });

  it.each(["restore", "subscription"] as const)("serializes %s first with a concurrent restore/subscription creation", async first => {
    const source = randomUUID(), destination = randomUUID();
    accounts.push(source, destination);
    await admin`insert into auth.users(id) values (${source}), (${destination})`;
    await service.bootstrap(source, { currency: "EUR", timezone: "Europe/Paris" });
    await service.bootstrap(destination, { currency: "USD", timezone: "UTC" });
    const sourceCategory = (await service.categories(source))[0];
    const destinationCategory = (await service.categories(destination)).find(category => category.name === sourceCategory.name)!;
    await service.purchase(source, randomUUID(), {
      name: "Restore lock specimen", categoryId: sourceCategory.id, amountMinor: 1250,
      currency: "EUR", occurredOn: "2026-10-01", merchant: null, note: null,
    });
    const { backup } = await service.backup(source);
    const subscriptions = createSubscriptionService(connection.db);
    const restoreKey = randomUUID(), subscriptionKey = randomUUID();
    const input = {
      name: "Concurrent subscription", categoryId: destinationCategory.id,
      schedule: { amountMinor: 500, intervalUnit: "month" as const, billingAnchorOn: "2026-10-20", nextPeriod: 0, reminderDays: null, serviceUrl: null, emailEnabled: false },
    };
    let restore: Promise<Awaited<ReturnType<typeof service.restoreCollection>> | { error: unknown }> | undefined;
    let subscription: ReturnType<typeof subscriptions.create> | undefined;
    function startRestore() { restore = service.restoreCollection(destination, restoreKey, backup).catch(error => ({ error })); }
    function startSubscription() {
      subscription = subscriptions.create(destination, subscriptionKey, input);
      void subscription.catch(() => {});
    }
    try {
      await withUser(connection.db, destination, async tx => {
        await lockCollection(tx, destination);
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        if (first === "restore") startRestore(); else startSubscription();
        await waitForBlockedWriter(pid);
        if (first === "restore") startSubscription(); else startRestore();
        await waitForBlockedWriter(pid, 2);
      });
      const [restored, created] = await Promise.all([restore!, subscription!]);
      const after = (await service.backup(destination)).backup;
      if (first === "restore") {
        expect(restored).toMatchObject({ replayed: false });
        expect(after.profile.currency).toBe("EUR");
        expect(created.subscription.currency).toBe("EUR");
        expect(after.items).toHaveLength(2);
        expect(after.transactions).toHaveLength(1);
        expect((await service.restoreCollection(destination, restoreKey, backup)).replayed).toBe(true);
      } else {
        expect(restored).toMatchObject({ error: { status: 409 } });
        expect(after.profile.currency).toBe("USD");
        expect(created.subscription.currency).toBe("USD");
        expect(after.items).toHaveLength(1);
        expect(after.transactions).toHaveLength(0);
      }
      expect((await subscriptions.create(destination, subscriptionKey, input)).replayed).toBe(true);
    } finally {
      await Promise.allSettled([restore, subscription].filter(promise => promise !== undefined));
    }
  });
});
