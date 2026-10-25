import { createHash, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDatabase, withUser } from '../src/server/db/client';
import { itemTags, items, operations, reminderPreferences, renewalResolutions, subscriptions, tags } from '../src/server/db/schema';
import { createInventoryService } from '../src/server/services/inventory';
import { createSubscriptionService } from '../src/server/services/subscriptions';
import { backupInput } from '../src/shared/collection-tools';

config({path:'.env.test.local',override:true,quiet:true});
describe.skipIf(!process.env.DATABASE_ADMIN_URL)('backup preservation in local Postgres',()=>{
  let admin:ReturnType<typeof postgres>,connection:ReturnType<typeof createDatabase>,inventory:ReturnType<typeof createInventoryService>,tracking:ReturnType<typeof createSubscriptionService>;
  const users:string[]=[];
  beforeAll(()=>{
    for(const variable of ['DATABASE_ADMIN_URL','DATABASE_URL']) if(!['localhost','127.0.0.1'].includes(new URL(process.env[variable]!).hostname)) throw new Error('Local tests only.');
    admin=postgres(process.env.DATABASE_ADMIN_URL!,{max:1,onnotice:()=>{}});
    connection=createDatabase(process.env.DATABASE_URL!);inventory=createInventoryService(connection.db);tracking=createSubscriptionService(connection.db);
  });
  afterAll(async()=>{
    for(const user of users) await admin`delete from auth.users where id=${user}`;
    if(admin) await admin.end();
    if(connection) await connection.close();
  });
  async function account() {
    const userId=randomUUID();await admin`insert into auth.users(id) values (${userId})`;users.push(userId);
    await inventory.bootstrap(userId,{currency:'USD',timezone:'UTC'});
    return {userId,categoryId:(await inventory.categories(userId))[0].id};
  }
  async function source() {
    const owner=await account();
    const item=await inventory.existingItem(owner.userId,randomUUID(),{name:'Tagged subscription',categoryId:owner.categoryId,description:'Preserved notes',acquiredOn:null,tags:['alpha','zeta']});
    const {subscription}=await tracking.create(owner.userId,randomUUID(),{itemId:item.item.id,schedule:{amountMinor:999,intervalUnit:'month',billingAnchorOn:'2026-01-31',nextPeriod:0,reminderDays:7,serviceUrl:'https://example.com/service',emailEnabled:true}});
    await tracking.advance(owner.userId,randomUUID(),subscription.id,{revision:1,dueOn:'2026-01-31'});
    return {...owner,itemId:item.item.id,subscriptionId:subscription.id};
  }
  it('round-trips ordered/unused tags, active/ending/stopped subscriptions and renewal history without email consent',async()=>{
    const owner=await source(),destination=await account();
    await withUser(connection.db,owner.userId,async tx=>{
      const links=await tx.select().from(itemTags).where(eq(itemTags.itemId,owner.itemId));
      await tx.delete(itemTags).where(eq(itemTags.itemId,owner.itemId));
      await tx.insert(itemTags).values(links.map(link=>({...link,slot:3-link.slot})));
      await tx.insert(tags).values({userId:owner.userId,name:'unused'});
      await tx.insert(reminderPreferences).values({userId:owner.userId,enabled:true});
    });
    for(const status of ['ending','stopped'] as const) {
      const item=await inventory.existingItem(owner.userId,randomUUID(),{name:status,categoryId:owner.categoryId,description:null,acquiredOn:null});
      const {subscription}=await tracking.create(owner.userId,randomUUID(),{itemId:item.item.id,schedule:{amountMinor:0,intervalUnit:'year',billingAnchorOn:'2024-02-29',nextPeriod:2,reminderDays:null,serviceUrl:null,emailEnabled:false}});
      await tracking.stop(owner.userId,randomUUID(),subscription.id,{revision:1,endsOn:status==='ending'?'2027-02-28':null});
      if(status==='stopped') await inventory.editItem(owner.userId,item.item.id,randomUUID(),{archived:true});
    }
    const [consent]=await withUser(connection.db,destination.userId,tx=>tx.insert(reminderPreferences).values({userId:destination.userId,enabled:false,blocked:true}).returning());
    const [existingTag]=await withUser(connection.db,destination.userId,tx=>tx.insert(tags).values({userId:destination.userId,name:'unused'}).returning());
    const {backup}=await inventory.backup(owner.userId);
    expect(backup.version).toBe(2);if(backup.version!==2)throw new Error('Expected v2');
    expect(backup.tags.map(tag=>tag.name).sort()).toEqual(['alpha','unused','zeta']);
    expect(backup).not.toHaveProperty('reminderPreferences');
    expect(JSON.stringify(backup)).not.toContain(owner.userId);
    const key=randomUUID();
    const results=await Promise.all([inventory.restoreCollection(destination.userId,key,backup),inventory.restoreCollection(destination.userId,key,backup)]);
    expect(results.map(result=>result.replayed).sort()).toEqual([false,true]);
    expect((await inventory.restoreCollection(destination.userId,key,backup)).replayed).toBe(true);
    const restored=(await inventory.backup(destination.userId)).backup;
    expect(restored.version).toBe(2);if(restored.version!==2)throw new Error('Expected v2');
    expect(restored.tags.map(tag=>tag.name).sort()).toEqual(['alpha','unused','zeta']);
    expect(restored.tags.find(tag=>tag.name==='unused')!.id).toBe(existingTag.id);
    expect((await inventory.itemDetail(destination.userId,results[0].itemIds[owner.itemId])).item.tags.map(tag=>tag.name)).toEqual(['zeta','alpha']);
    for(const subscription of backup.subscriptions) {
      const actual=restored.subscriptions.find(row=>row.itemId===results[0].itemIds[subscription.itemId])!;
      expect(actual).toEqual({...subscription,id:actual.id,itemId:results[0].itemIds[subscription.itemId]});
      expect(actual.id).not.toBe(subscription.id);
      const history=restored.renewalResolutions.filter(row=>row.subscriptionId===actual.id);
      expect(history.map(row=>({dueOn:row.dueOn,createdAt:row.createdAt}))).toEqual(backup.renewalResolutions.filter(row=>row.subscriptionId===subscription.id).map(row=>({dueOn:row.dueOn,createdAt:row.createdAt})));
    }
    expect(await withUser(connection.db,destination.userId,tx=>tx.select().from(reminderPreferences))).toEqual([consent]);
    await expect(inventory.restoreCollection(destination.userId,key,{...backup,exportedAt:'2026-10-02T00:00:00.000Z'})).rejects.toMatchObject({status:409});
  });
  it('reads v1 without inventing omitted datasets and replays historical v1 receipts',async()=>{
    const owner=await source(),destination=await account(),legacyReceiptAccount=await account();
    const {backup}=await inventory.backup(owner.userId);
    const legacy=backupInput.parse({...backup,version:1});
    expect(legacy).not.toHaveProperty('tags');expect(legacy).not.toHaveProperty('subscriptions');
    const result=await inventory.restoreCollection(destination.userId,randomUUID(),legacy);
    expect((await inventory.itemDetail(destination.userId,result.itemIds[owner.itemId])).item.tags).toEqual([]);
    expect(await tracking.forItem(destination.userId,result.itemIds[owner.itemId])).toBeNull();
    const key=randomUUID(),savedResult={itemIds:{},archived:[]};
    await withUser(connection.db,legacyReceiptAccount.userId,tx=>tx.insert(operations).values({userId:legacyReceiptAccount.userId,idempotencyKey:key,operationType:'collection_restore',requestHash:createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),result:savedResult}));
    expect(await inventory.restoreCollection(legacyReceiptAccount.userId,key,backupInput.parse(legacy))).toEqual({...savedResult,replayed:true});
    expect(await withUser(connection.db,legacyReceiptAccount.userId,tx=>tx.select().from(items))).toEqual([]);
  });
  it('rolls back all restored records and the receipt on failure, then permits a valid same-key retry',async()=>{
    const owner=await source(),destination=await account(),key=randomUUID();
    const {backup}=await inventory.backup(owner.userId);if(backup.version!==2)throw new Error('Expected v2');
    // Exercise the transaction guarantee even if an internal caller violates a database constraint.
    const invalid={...backup,subscriptions:backup.subscriptions.map(subscription=>({...subscription,amountMinor:-1}))};
    await expect(inventory.restoreCollection(destination.userId,key,invalid)).rejects.toBeDefined();
    for(const table of [items,tags,subscriptions,renewalResolutions,operations]) expect(await withUser(connection.db,destination.userId,tx=>tx.select().from(table))).toEqual([]);
    expect((await inventory.restoreCollection(destination.userId,key,backup)).replayed).toBe(false);
    expect((await tracking.forItem(destination.userId,(await inventory.backup(destination.userId)).backup.items[0].id))?.amountMinor).toBe(999);
  });
  it('scopes identical restore keys and all remapped records to each destination account',async()=>{
    const owner=await source(),first=await account(),second=await account(),key=randomUUID();
    const {backup}=await inventory.backup(owner.userId);if(backup.version!==2)throw new Error('Expected v2');
    const [a,b]=await Promise.all([inventory.restoreCollection(first.userId,key,backup),inventory.restoreCollection(second.userId,key,backup)]);
    expect(a.replayed).toBe(false);expect(b.replayed).toBe(false);
    expect(a.itemIds[owner.itemId]).not.toBe(b.itemIds[owner.itemId]);
    expect(await withUser(connection.db,first.userId,tx=>tx.select().from(subscriptions).where(eq(subscriptions.userId,second.userId)))).toEqual([]);
    const link=await withUser(connection.db,first.userId,tx=>tx.select().from(itemTags).where(and(eq(itemTags.userId,first.userId),eq(itemTags.itemId,a.itemIds[owner.itemId]))));
    expect(link).toHaveLength(2);expect(link.every(row=>!backup.tags.some(tag=>tag.id===row.tagId))).toBe(true);
    await expect(inventory.existingItem(first.userId,key,{name:'Conflicting operation',categoryId:first.categoryId,description:null,acquiredOn:null})).rejects.toMatchObject({status:409});
  });
});
