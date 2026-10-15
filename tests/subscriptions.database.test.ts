import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDatabase, withUser } from "../src/server/db/client";
import { createInventoryService } from "../src/server/services/inventory";
import { createSubscriptionService } from "../src/server/services/subscriptions";
import { createReminderEmailService, EmailSendError, unsubscribeToken, type EmailSender } from "../src/server/services/reminder-email";
import { items, operations, reminderDigests, reminderPreferences, renewalResolutions, subscriptions, transactions, type DigestPayload } from "../src/server/db/schema";
import { createApi } from "../src/server/api/app";
import type { ScheduleInput } from "../src/shared/subscriptions";

config({ path: ".env.test.local", override: true, quiet: true });
const enabled = !!process.env.DATABASE_ADMIN_URL;
if (!enabled && process.env.REQUIRE_DATABASE_TESTS === "1") throw new Error("Local database tests are required.");
describe.skipIf(!enabled)("subscription persistence and reminder delivery", () => {
  let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof createDatabase>;
  let inventory: ReturnType<typeof createInventoryService>, service: ReturnType<typeof createSubscriptionService>;
  const userA = randomUUID(), userB = randomUUID();
  let categoryA: string, categoryB: string;
  let now = new Date("2026-10-13T13:00:00Z");
  const schedule: ScheduleInput = { amountMinor: 1500, intervalUnit: "month", billingAnchorOn: "2026-10-20", nextPeriod: 0, reminderDays: 7, serviceUrl: "https://example.com/manage", emailEnabled: true };
  const create = (name: string, overrides: Partial<ScheduleInput> = {}) => service.create(userA, randomUUID(), { name, categoryId: categoryA, schedule: { ...schedule, ...overrides } });
  beforeAll(async () => {
    const adminUrl = new URL(process.env.DATABASE_ADMIN_URL!);
    if (!["127.0.0.1", "localhost"].includes(adminUrl.hostname)) throw new Error("Local database only.");
    admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
    connection = createDatabase(process.env.DATABASE_URL!); inventory = createInventoryService(connection.db); service = createSubscriptionService(connection.db, () => now);
    vi.stubEnv("RESEND_API_KEY", "fixture-key"); vi.stubEnv("REMINDER_SIGNING_SECRET", "fixture-signing-secret"); vi.stubEnv("APP_URL", "https://example.com");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "subscription-fixture@example.com"); vi.stubEnv("REMINDER_FROM", "onboarding@resend.dev"); vi.stubEnv("REMINDER_EMAIL_DISABLED", "0");
    await admin`insert into auth.users(id,email,email_confirmed_at,is_anonymous) values (${userA},'subscription-fixture@example.com',now(),false),(${userB},'other-fixture@example.com',now(),false)`;
    for (const userId of [userA,userB]) await inventory.bootstrap(userId, { currency: "USD", timezone: "America/New_York" });
    categoryA = (await inventory.categories(userA)).find(row => row.name === "Subscriptions")!.id;
    categoryB = (await inventory.categories(userB)).find(row => row.name === "Subscriptions")!.id;
  });
  afterAll(async () => {
    if (admin) { await admin`delete from auth.users where id in (${userA},${userB})`; await admin.end(); }
    if (connection) await connection.close(); vi.unstubAllEnvs();
  });
  it("creates an item and schedule atomically, replays sequential/concurrent retries and rejects conflicting keys", async () => {
    const key = randomUUID(), input = { name: "Music", categoryId: categoryA, schedule };
    const [first, second] = await Promise.all([service.create(userA,key,input), service.create(userA,key,input)]);
    expect(first.subscription.id).toBe(second.subscription.id); expect([first.replayed,second.replayed].sort()).toEqual([false,true]);
    expect((await service.create(userA,key,input)).replayed).toBe(true);
    await expect(service.create(userA,key,{ ...input,name:"Changed" })).rejects.toMatchObject({ status:409 });
    const other = await service.create(userB,key,{ ...input,categoryId:categoryB }); expect(other.subscription.id).not.toBe(first.subscription.id);
    await expect(inventory.existingItem(userA,key,{ name:"Other",categoryId:categoryA,acquiredOn:null,description:null })).rejects.toMatchObject({ status:409 });
    expect((await service.list(userA)).data[0]).toMatchObject({ name:"Music",nextDueOn:"2026-10-20",state:"attention" });
    expect(await withUser(connection.db,userA,tx=>tx.select().from(transactions))).toHaveLength(0);
  });
  it("rolls back invalid schedules and supports same-key retry after a failed transaction", async () => {
    const key=randomUUID(), input={ name:"Rollback",categoryId:categoryA,schedule:{...schedule,amountMinor:-1} };
    const before=await withUser(connection.db,userA,tx=>tx.select().from(items));
    await expect(service.create(userA,key,input)).rejects.toBeDefined();
    expect(await withUser(connection.db,userA,tx=>tx.select().from(items))).toHaveLength(before.length);
    expect(await withUser(connection.db,userA,tx=>tx.select().from(operations).where(eq(operations.idempotencyKey,key)))).toHaveLength(0);
    expect((await service.create(userA,key,{...input,schedule})).replayed).toBe(false);
  });
  it("enforces same-owner item links, one subscription per item, RLS and SQL recurrence constraints", async () => {
    const row=(await service.list(userA)).data[0];
    await expect(service.create(userB,randomUUID(),{itemId:row.itemId,schedule})).rejects.toMatchObject({status:422});
    await expect(service.create(userA,randomUUID(),{itemId:row.itemId,schedule})).rejects.toMatchObject({status:409});
    expect(await service.forItem(userB,row.itemId)).toBeNull();
    expect(await connection.db.select().from(subscriptions)).toHaveLength(0);
    expect(await withUser(connection.db,userB,tx=>tx.select().from(subscriptions))).toHaveLength(1);
    await expect(withUser(connection.db,userA,tx=>tx.update(subscriptions).set({nextDueOn:"2026-10-21"}).where(eq(subscriptions.id,row.id)))).rejects.toBeDefined();
    const [identity]=await connection.db.execute(sql`select * from app.reminder_identity()`); expect(identity).toBeUndefined();
  });
  it("advances exactly one period, rejects different-key stale/concurrent actions and preserves Spending", async () => {
    const {subscription:row}=await create("Month end",{billingAnchorOn:"2026-01-31",nextPeriod:1});
    const key=randomUUID(), input={revision:row.revision,dueOn:row.nextDueOn};
    const [a,b]=await Promise.all([service.advance(userA,key,row.id,input),service.advance(userA,key,row.id,input)]);
    expect(a.subscription.nextDueOn).toBe("2026-03-31"); expect(a.subscription.id).toBe(b.subscription.id);
    await expect(service.advance(userA,randomUUID(),row.id,input)).rejects.toMatchObject({status:409});
    const next={revision:a.subscription.revision,dueOn:a.subscription.nextDueOn};
    const results=await Promise.allSettled([service.advance(userA,randomUUID(),row.id,next),service.advance(userA,randomUUID(),row.id,next)]);
    expect(results.filter(row=>row.status==="fulfilled")).toHaveLength(1);
    expect(await withUser(connection.db,userA,tx=>tx.select().from(renewalResolutions).where(eq(renewalResolutions.subscriptionId,row.id)))).toHaveLength(2);
    expect(await withUser(connection.db,userA,tx=>tx.select().from(transactions))).toHaveLength(0);
  });
  it("edits future expectations with revision conflicts and honors inclusive stop dates", async () => {
    const {subscription:row}=await create("Editing");
    const edited=await service.edit(userA,randomUUID(),row.id,{revision:row.revision,schedule:{...schedule,amountMinor:1900}});
    await expect(service.edit(userA,randomUUID(),row.id,{revision:row.revision,schedule})).rejects.toMatchObject({status:409});
    const stopped=await service.stop(userA,randomUUID(),row.id,{revision:edited.subscription.revision,endsOn:row.nextDueOn});
    expect((await service.list(userA)).data.find(value=>value.id===row.id)?.state).toBe("attention");
    await service.advance(userA,randomUUID(),row.id,{revision:stopped.subscription.revision,dueOn:row.nextDueOn});
    expect((await service.list(userA)).data.find(value=>value.id===row.id)?.state).toBe("stopped");
  });
  it("rejects edits at or before the latest resolved date without consuming the request key", async () => {
    const original = { ...schedule, billingAnchorOn: "2026-01-31", nextPeriod: 1 };
    const { subscription: row } = await create("Resolved date regression", original);
    const { subscription: advanced } = await service.advance(userA, randomUUID(), row.id, { revision: row.revision, dueOn: row.nextDueOn });
    const key = randomUUID();
    for (const nextPeriod of [0, 1]) {
      await expect(service.edit(userA, key, row.id, { revision: advanced.revision, schedule: { ...original, nextPeriod } })).rejects.toMatchObject({ status: 422 });
      expect(await service.forItem(userA, row.itemId)).toMatchObject({ nextDueOn: "2026-03-31", revision: advanced.revision });
    }
    expect(await withUser(connection.db, userA, tx => tx.select().from(operations).where(eq(operations.idempotencyKey, key)))).toHaveLength(0);
    const corrected = { revision: advanced.revision, schedule: { ...original, nextPeriod: 2, amountMinor: 2000 } };
    const edited = await service.edit(userA, key, row.id, corrected);
    expect((await service.edit(userA, key, row.id, corrected)).replayed).toBe(true);
    const next = await service.advance(userA, randomUUID(), row.id, { revision: edited.subscription.revision, dueOn: edited.subscription.nextDueOn });
    expect(next.subscription.nextDueOn).toBe("2026-04-30");
  });
  it("validates authenticated API submissions and rejects unavailable test recipients", async () => {
    const app=createApi({verifyToken:async()=>userA,service:()=>inventory,subscriptions:()=>service});
    expect((await app.request('/api/subscriptions',{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:JSON.stringify({name:'Missing key',categoryId:categoryA,schedule})})).status).toBe(400);
    const key=randomUUID(), input={enabled:true,revision:0};
    const enabled=await service.preferences(userA,key,input); expect(enabled.enabled).toBe(true);
    expect((await service.preferences(userA,key,input)).replayed).toBe(true);
    await expect(service.preferences(userB,randomUUID(),input)).rejects.toMatchObject({status:422});
  });
  it("groups eligible renewals once, excludes past-due/off/cancelled records, and serializes workers", async () => {
    await create("No reminders",{reminderDays:null});
    await create("Already past",{billingAnchorOn:"2026-10-12"});
    const {subscription:cancelled}=await create("Cancelled"); await service.stop(userA,randomUUID(),cancelled.id,{revision:1,endsOn:null});
    const send=vi.fn(async(payload: DigestPayload, key: string)=>{ expect(payload.to).toHaveLength(1); expect(key).toContain("subscription-digest/"); return {id:randomUUID()}; }); const email=createReminderEmailService(connection.db,send,()=>now);
    const results=await Promise.all([email.run(),email.run()]); expect(results.reduce((sum,row)=>sum+row.accepted,0)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const payload=send.mock.calls[0][0] as unknown as {text:string;to:string[]};
    expect(payload.text).toContain("Music"); expect(payload.text).not.toContain("No reminders"); expect(payload.text).not.toContain("Already past"); expect(payload.text).not.toContain("Cancelled");
    expect(payload.to).toEqual(["subscription-fixture@example.com"]);
    expect((await email.run()).accepted).toBe(0);
    const prefs=(await service.list(userA)).preferences;
    await service.preferences(userA,randomUUID(),{enabled:false,revision:prefs.revision});
    const otherPrefs=(await service.list(userB)).preferences; expect(otherPrefs.enabled).toBe(false);
  });
  it("reuses an immutable payload/key after an ambiguous response and stops before provider key expiry", async () => {
    now=new Date("2026-10-14T13:00:00Z"); await create("Retry email",{billingAnchorOn:"2026-10-21"});
    const prefs=(await service.list(userA)).preferences; await service.preferences(userA,randomUUID(),{enabled:true,revision:prefs.revision});
    const send=vi.fn(async()=>{throw new EmailSendError(true,"provider_503");});
    const email=createReminderEmailService(connection.db,send,()=>now); expect((await email.run()).failed).toBe(1);
    now=new Date("2026-10-14T13:10:00Z"); await email.run(); expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    now=new Date("2026-10-15T13:00:00Z"); await email.run(); expect(send).toHaveBeenCalledTimes(2);
    const [digest]=await withUser(connection.db,userA,tx=>tx.select().from(reminderDigests).where(eq(reminderDigests.localDate,"2026-10-14")));
    expect(digest.status).toBe("uncertain");
  });
  it("waits until local 9 a.m., honors the kill switch and requires a verified recipient", async () => {
    now=new Date("2026-10-16T12:59:00Z"); await create("Morning digest",{billingAnchorOn:"2026-10-23"});
    const send=vi.fn(async()=>({id:randomUUID()})); const email=createReminderEmailService(connection.db,send,()=>now);
    expect((await email.run()).accepted).toBe(0); expect(send).not.toHaveBeenCalled();
    now=new Date("2026-10-16T13:00:00Z"); vi.stubEnv("REMINDER_EMAIL_DISABLED","1");
    expect((await email.run()).disabled).toBe(true); expect(send).not.toHaveBeenCalled(); vi.stubEnv("REMINDER_EMAIL_DISABLED","0");
    await admin`update auth.users set email_confirmed_at=null where id=${userA}`;
    expect((await email.run()).accepted).toBe(0); expect(send).not.toHaveBeenCalled();
    expect((await service.list(userA)).preferences.emailAvailable).toBe(false);
    await admin`update auth.users set email_confirmed_at=now() where id=${userA}`;
    expect((await email.run()).accepted).toBe(1); expect(send).toHaveBeenCalledTimes(1);
    const row=(await service.list(userA)).data.find(row=>row.name==="Morning digest")!;
    await service.edit(userA,randomUUID(),row.id,{revision:row.revision,schedule:{...schedule,billingAnchorOn:row.billingAnchorOn,reminderDays:14}});
    now=new Date("2026-10-17T13:00:00Z"); expect((await email.run()).accepted).toBe(0);
    expect(send).toHaveBeenCalledTimes(1); // Offset edits never repeat the same renewal email.
  });
  it("suppresses retries after a schedule or confirmed email changes", async () => {
    now=new Date("2026-10-18T13:00:00Z"); const {subscription:row}=await create("Changed before retry",{billingAnchorOn:"2026-10-25"});
    const send=vi.fn(async()=>{throw new Error("Fixture ambiguous timeout");}); const email=createReminderEmailService(connection.db,send,()=>now);
    expect((await email.run()).failed).toBe(1);
    await service.edit(userA,randomUUID(),row.id,{revision:row.revision,schedule:{...schedule,billingAnchorOn:row.billingAnchorOn,amountMinor:2000}});
    now=new Date("2026-10-18T13:10:00Z"); await email.run(); expect(send).toHaveBeenCalledTimes(1);
    const [changed]=await withUser(connection.db,userA,tx=>tx.select().from(reminderDigests).where(eq(reminderDigests.localDate,"2026-10-18")));
    expect(changed.status).toBe("uncertain");
    now=new Date("2026-10-19T13:00:00Z"); await create("Changed recipient",{billingAnchorOn:"2026-10-26"}); await email.run();
    expect(send).toHaveBeenCalledTimes(2);
    await admin`update auth.users set email='changed-fixture@example.com' where id=${userA}`;
    now=new Date("2026-10-19T13:10:00Z"); await email.run(); expect(send).toHaveBeenCalledTimes(2);
    const [recipient]=await withUser(connection.db,userA,tx=>tx.select().from(reminderDigests).where(eq(reminderDigests.localDate,"2026-10-19")));
    expect(recipient.status).toBe("uncertain");
    await admin`update auth.users set email='subscription-fixture@example.com' where id=${userA}`;
  });
  it("recovers a lost provider response through its digest tag and ignores duplicate/older events", async () => {
    const [digest]=await withUser(connection.db,userA,tx=>tx.select().from(reminderDigests).where(eq(reminderDigests.localDate,"2026-10-19")));
    const providerId=randomUUID(), deliveredId=randomUUID(), sentId=randomUUID();
    const email=createReminderEmailService(connection.db,async()=>({id:randomUUID()}),()=>now);
    const data={email_id:providerId,tags:{digest_id:digest.id}};
    await email.webhook(deliveredId,{type:"email.delivered",data}); await email.webhook(deliveredId,{type:"email.delivered",data});
    await email.webhook(sentId,{type:"email.sent",data});
    const [recovered]=await withUser(connection.db,userA,tx=>tx.select().from(reminderDigests).where(eq(reminderDigests.id,digest.id)));
    expect(recovered).toMatchObject({status:"delivered",providerId,leaseUntil:null,retryAfter:null});
    await admin`delete from app.reminder_webhook_events where event_id in (${deliveredId},${sentId})`;
  });
  it("uses signed unsubscribe nonces, handles provider feedback once, and blocks hard bounces", async () => {
    const [prefs]=await withUser(connection.db,userA,tx=>tx.select().from(reminderPreferences));
    const email=createReminderEmailService(connection.db,async()=>({id:randomUUID()}),()=>now);
    const token=unsubscribeToken(userA,prefs.unsubscribeNonce,"fixture-signing-secret"); await email.unsubscribe(token); await email.unsubscribe(token);
    expect((await service.list(userA)).preferences.enabled).toBe(false);
    const [digest]=await withUser(connection.db,userA,tx=>tx.select().from(reminderDigests).where(eq(reminderDigests.status,"accepted")));
    const eventId=randomUUID(); await email.webhook(eventId,{type:"email.bounced",data:{email_id:digest.providerId!}}); await email.webhook(eventId,{type:"email.bounced",data:{email_id:digest.providerId!}});
    expect((await service.list(userA)).preferences.blocked).toBe(true);
    await expect(service.preferences(userA,randomUUID(),{enabled:true,revision:(await service.list(userA)).preferences.revision})).rejects.toMatchObject({status:422});
    await expect(email.unsubscribe(token+'x')).rejects.toMatchObject({status:400});
    await admin`delete from app.reminder_webhook_events where event_id=${eventId}`;
  });
  it("suppresses archived categories and keeps off and overdue states accurate", async () => {
    expect((await service.list(userA)).data.find(row=>row.name==="No reminders")?.state).toBe("off");
    expect((await service.list(userA)).data.find(row=>row.name==="Already past")?.state).toBe("overdue");
    await admin`update app.categories set archived_at=now() where id=${categoryA}`;
    expect((await service.list(userA)).data).toHaveLength(0);
  });
  it("paginates past skipped accounts and sends every later page as candidates disappear", async () => {
    const prefix = randomUUID().slice(0, 4);
    const accounts = Array.from({ length: 102 }, (_, index) => ({
      id: `00000000-${prefix}-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      email: `pagination-${prefix}-${index}@example.com`,
      email_confirmed_at: new Date(), is_anonymous: false,
    }));
    const collections = accounts.map(account => ({ id: randomUUID(), user_id: account.id, name: "Pagination fixture" }));
    const owned = collections.map(collection => ({ id: randomUUID(), user_id: collection.user_id, category_id: collection.id, name: "Pagination subscription" }));
    const sender = process.env.REMINDER_FROM!;
    vi.stubEnv("REMINDER_FROM", "reminders@verified.example.com");
    try {
      await admin.begin(async tx => {
        await tx`insert into auth.users ${tx(accounts)}`;
        await tx`insert into app.profiles ${tx(accounts.map(account => ({ user_id: account.id, currency: "USD", timezone: "UTC" })))}`;
        await tx`insert into app.categories ${tx(collections)}`;
        await tx`insert into app.items ${tx(owned)}`;
        await tx`insert into app.subscriptions ${tx(owned.map(item => ({ user_id: item.user_id, item_id: item.id, amount_minor: 1500, currency: "USD", interval_unit: "month", billing_anchor_on: "2026-10-20", next_period: 0, next_due_on: "2026-10-20", reminder_days: 7 })))}`;
        await tx`insert into app.reminder_preferences ${tx(accounts.map(account => ({ user_id: account.id, enabled: true })))}`;
        // Simulate accounts losing eligibility after opting in.
        await tx`update auth.users set email_confirmed_at=null where id in ${tx(accounts.slice(0, 50).map(account => account.id))}`;
      });
      const send = vi.fn<EmailSender>(async () => ({ id: randomUUID() }));
      const email = createReminderEmailService(connection.db, send, () => new Date("2026-10-13T13:00:00Z"));
      expect(await email.run()).toEqual({ accepted: 52, failed: 0 });
      expect(send.mock.calls.map(([payload]) => payload.to[0]).sort()).toEqual(accounts.slice(50).map(account => account.email).sort());
      expect(await email.run()).toEqual({ accepted: 0, failed: 0 });
      expect(send).toHaveBeenCalledTimes(52);
    } finally {
      vi.stubEnv("REMINDER_FROM", sender);
      await admin`delete from auth.users where id in ${admin(accounts.map(account => account.id))}`;
    }
  });
});
