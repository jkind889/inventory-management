import {randomUUID} from 'node:crypto';
import {config} from 'dotenv';
import postgres from 'postgres';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {createDatabase,withUser} from '../src/server/db/client';
import {createInventoryService} from '../src/server/services/inventory';
import {categories,collectionPreferences,items,itemPhotos,transactions} from '../src/server/db/schema';
import {backupInput,importInput,preferencesInput} from '../src/shared/collection-tools';
import {collectionInput} from '../src/shared/contracts';
config({path:'.env.test.local',override:true,quiet:true});
describe.skipIf(!process.env.DATABASE_ADMIN_URL)('collection tools in local Postgres',()=>{
  const a=randomUUID(),b=randomUUID(),c=randomUUID();let admin:ReturnType<typeof postgres>,connection:ReturnType<typeof createDatabase>,service:ReturnType<typeof createInventoryService>,categoryA:string,categoryB:string;
  beforeAll(async()=>{
    for(const variable of ['DATABASE_ADMIN_URL','DATABASE_URL'])if(!['localhost','127.0.0.1'].includes(new URL(process.env[variable]!).hostname))throw new Error('Local tests only.');
    admin=postgres(process.env.DATABASE_ADMIN_URL!,{max:1,onnotice:()=>{}});connection=createDatabase(process.env.DATABASE_URL!);service=createInventoryService(connection.db);
    await admin`insert into auth.users(id) values (${a}),(${b}),(${c})`;
    for(const user of [a,b,c])await service.bootstrap(user,{currency:'USD',timezone:'America/New_York'});
    categoryA=(await service.categories(a))[0].id;categoryB=(await service.categories(b))[0].id;
  });
  afterAll(async()=>{if(admin){await admin`delete from auth.users where id in (${a},${b},${c})`;await admin.end();}if(connection)await connection.close();});
  it('edits and bulk-edits atomically, preserves spending, and replays without undoing later edits',async()=>{
    const purchase=await service.purchase(a,randomUUID(),{name:'Searchable camera',categoryId:categoryA,amountMinor:12345,currency:'USD',occurredOn:'2026-10-01',merchant:'Photo store',note:'Travel kit'});
    const key=randomUUID(),input={name:'Updated camera',description:'Hiking and travel',state:'sold' as const};
    const results=await Promise.all([service.editItem(a,purchase.item.id,key,input),service.editItem(a,purchase.item.id,key,input)]);
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
    await service.editItem(a,purchase.item.id,randomUUID(),{name:'Latest camera'});
    expect((await service.editItem(a,purchase.item.id,key,input)).replayed).toBe(true);
    expect((await service.itemDetail(a,purchase.item.id)).item.name).toBe('Latest camera');
    await expect(service.editItem(a,purchase.item.id,key,{name:'Other'})).rejects.toMatchObject({status:409});
    const original=await withUser(connection.db,a,tx=>tx.select().from(transactions).where(eq(transactions.id,purchase.transaction.id)));
    expect(original[0]).toEqual(purchase.transaction);
    const second=await service.existingItem(a,randomUUID(),{name:'Other object',categoryId:categoryA,description:null,acquiredOn:null});
    const bulkKey=randomUUID(),bulk={ids:[purchase.item.id,second.item.id],changes:{state:'donated' as const}};
    const bulkResults=await Promise.all([service.bulkEdit(a,bulkKey,bulk),service.bulkEdit(a,bulkKey,bulk)]);
    expect(bulkResults.map(r=>r.replayed).sort()).toEqual([false,true]);
    await expect(service.bulkEdit(a,randomUUID(),{ids:[second.item.id,randomUUID()],changes:{name:'Should roll back'}})).rejects.toMatchObject({status:404});
    expect((await service.itemDetail(a,second.item.id)).item.name).toBe('Other object');
    await expect(service.editItem(b,purchase.item.id,randomUUID(),{name:'Unauthorized'})).rejects.toMatchObject({status:404});
    await expect(service.bulkEdit(a,randomUUID(),{ids:[second.item.id],changes:{categoryId:categoryB}})).rejects.toMatchObject({status:422});
  });
  it('searches notes/merchants and filters dates, states, and prices before counting/paging',async()=>{
    const result=await service.collection(a,collectionInput.parse({q:'travel',state:'all',from:'2026-10-01',to:'2026-10-01',minAmountMinor:12345,maxAmountMinor:12345,limit:1}));
    expect(result.total).toBe(1);expect(result.data[0].name).toBe('Latest camera');
    expect((await service.collection(a,collectionInput.parse({q:'photo store',state:'all'}))).total).toBe(1);
    expect((await service.collection(a,collectionInput.parse({q:'%',state:'all'}))).total).toBe(0);
    expect((await service.collection(b,collectionInput.parse({q:'travel',state:'all'}))).total).toBe(0);
  });
  it('imports once, creates categories, detects duplicates and rolls back failures',async()=>{
    const payload=importInput.parse({rows:[{name:'Imported chair',category:'New furniture'},{name:'Imported chair',category:'New furniture'},{name:'Imported lamp',category:'New furniture',amountMinor:9900,acquiredOn:'2026-10-02',currency:'USD'}]});
    const key=randomUUID(),results=await Promise.all([service.importCollection(a,key,payload),service.importCollection(a,key,payload)]);
    expect(results[0]).toMatchObject({imported:2,skipped:1});expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
    expect(await service.importCollection(a,randomUUID(),payload)).toMatchObject({imported:0,skipped:3});
    expect(await service.importCollection(b,randomUUID(),payload)).toMatchObject({imported:2,skipped:1});
    await expect(service.importCollection(a,key,{...payload,skipDuplicates:false})).rejects.toMatchObject({status:409});
    await expect(service.existingItem(a,key,{name:'Wrong operation',categoryId:categoryA,acquiredOn:null,description:null})).rejects.toMatchObject({status:409});
    const before=(await service.backup(a)).backup;
    await expect(service.importCollection(a,randomUUID(),{rows:[{...payload.rows[0],name:'Will roll back',category:'Rollback category'},{...payload.rows[0],name:''}],skipDuplicates:false})).rejects.toBeDefined();
    const after=(await service.backup(a)).backup;expect(after.items.length).toBe(before.items.length);expect(after.categories.length).toBe(before.categories.length);
    await expect(service.importCollection(a,randomUUID(),importInput.parse({rows:[{name:'Wrong currency',category:'Another category',amountMinor:1,acquiredOn:'2026-10-01',currency:'EUR'}]}))).rejects.toMatchObject({status:422});
  });
  it('persists account-scoped views and recent categories with conflict-safe retries',async()=>{
    const input=preferencesInput.parse({savedViews:[{id:randomUUID(),name:'Donated tech',filters:{q:'camera',state:'donated',categoryId:categoryA}}],recentCategoryIds:[categoryA]});
    const key=randomUUID(),results=await Promise.all([service.savePreferences(a,key,input),service.savePreferences(a,key,input)]);
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);expect(await service.preferences(a)).toEqual(input);expect((await service.preferences(b)).savedViews).toEqual([]);
    await expect(service.savePreferences(b,randomUUID(),input)).rejects.toMatchObject({status:422});
    expect(await withUser(connection.db,b,tx=>tx.select().from(collectionPreferences))).toHaveLength(1);
  });
  it('takes a complete snapshot and restores links, spending, reviews and views into an empty account',async()=>{
    const wanted=await service.addWant(a,randomUUID(),{name:'Future lens',categoryId:categoryA,description:'Wishlist notes',productUrl:null,targetAmountMinor:50000,priority:1});
    const acquired=(await service.collection(a,collectionInput.parse({state:'donated'}))).data[0];
    await service.addItemReview(a,acquired.id,randomUUID(),{verdict:'worth_it',usageFrequency:null,wouldBuyAgain:true,note:'Useful before donation'});
    const {backup}=await service.backup(a);expect(backup.items.some(x=>x.id===wanted.item.id)).toBe(true);expect(backup.reviews).toHaveLength(1);
    const key=randomUUID(),results=await Promise.all([service.restoreCollection(c,key,backup),service.restoreCollection(c,key,backup)]);
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
    const restored=(await service.backup(c)).backup;
    expect(restored.items).toHaveLength(backup.items.length);expect(restored.transactions.map(t=>t.amountMinor).sort()).toEqual(backup.transactions.map(t=>t.amountMinor).sort());expect(restored.reviews[0].itemId).toBe(results[0].itemIds[backup.reviews[0].itemId]);
    const selectedView=restored.preferences.savedViews[0];expect(restored.categories.some(x=>x.id===selectedView.filters.categoryId)).toBe(true);
    expect(restored.items.every(x=>!backup.items.some(old=>old.id===x.id))).toBe(true);
    await expect(service.restoreCollection(c,randomUUID(),backup)).rejects.toMatchObject({status:409});
    expect(backupInput.safeParse({...backup,items:[{...backup.items[0],categoryId:randomUUID()}]}).success).toBe(false);
    // Photo metadata is part of the same owner-scoped backup snapshot.
    const photoId=randomUUID();await withUser(connection.db,a,tx=>tx.insert(itemPhotos).values({id:photoId,userId:a,itemId:acquired.id,storagePath:`${a}/${acquired.id}/${photoId}`,status:'active',byteSize:10,mimeType:'image/png',checksum:'a'.repeat(64),width:1,height:1}));
    const snapshot=await service.backup(a);expect(snapshot.backup.photos[0].itemId).toBe(acquired.id);expect(snapshot.photoPaths[0].path.startsWith(a)).toBe(true);expect((await service.backup(b)).backup.photos).toEqual([]);
    void categories;void items;
  });
});
