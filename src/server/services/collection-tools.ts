import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { withUser, type Database, type UserTransaction } from '../db/client';
import { categories, collectionPreferences, itemPhotos, itemReviews, items, itemTags, profiles, renewalResolutions, subscriptions, tags, transactions } from '../db/schema';
import { withIdempotency } from './idempotency';
import { backupInput, duplicateIdentity, type Backup, type Preferences, type RestoreResult, type bulkItemInput, type importInput, type itemChanges } from '../../shared/collection-tools';

export async function lockCollection(tx: UserTransaction, userId: string) {
  // Serialize collection writers without blocking FK key-share locks from
  // item-first photo/review writes. Changes to profile keys still lock strongly.
  const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId)).for('no key update');
  if (!profile) throw new HTTPException(409, { message: 'Set up your profile first.' });
  return profile;
}
export async function rememberCategory(tx: UserTransaction, userId: string, categoryId: string) {
  const [previous] = await tx.select().from(collectionPreferences).where(eq(collectionPreferences.userId,userId));
  const recentCategoryIds = [categoryId, ...(previous?.recentCategoryIds ?? []).filter(id=>id!==categoryId)].slice(0,6);
  await tx.insert(collectionPreferences).values({userId, recentCategoryIds}).onConflictDoUpdate({target:collectionPreferences.userId,set:{recentCategoryIds}});
}
async function activeCategory(tx: UserTransaction, userId:string, categoryId:string) {
  const [category] = await tx.select().from(categories).where(and(eq(categories.userId,userId),eq(categories.id,categoryId),isNull(categories.archivedAt)));
  if (!category) throw new HTTPException(422,{message:'Choose an active category from your collection.'});
}
export function createCollectionTools(db: Database) {
  return {
    preferences(userId: string) {
      return withUser(db,userId,async tx=>{
        const [row]=await tx.select().from(collectionPreferences).where(eq(collectionPreferences.userId,userId));
        return {savedViews:row?.savedViews ?? [],recentCategoryIds:row?.recentCategoryIds ?? []};
      });
    },
    savePreferences(userId: string,key:string,input:Preferences) {
      return withIdempotency(db,userId,key,'preferences',input,async tx=>{
        await lockCollection(tx,userId);
        const owned=await tx.select({id:categories.id}).from(categories).where(eq(categories.userId,userId));
        const ids=new Set(owned.map(x=>x.id));
        if (input.recentCategoryIds.some(id=>!ids.has(id)) || input.savedViews.some(v=>v.filters.categoryId && !ids.has(v.filters.categoryId))) throw new HTTPException(422,{message:'A category in these preferences is unavailable.'});
        await tx.insert(collectionPreferences).values({userId,...input}).onConflictDoUpdate({target:collectionPreferences.userId,set:input});
        return input;
      });
    },
    editItem(userId:string,id:string,key:string,input:z.infer<typeof itemChanges>) {
      return withIdempotency(db,userId,key,'item_edit',{id,...input},async tx=>{
        await lockCollection(tx,userId);
        const [current]=await tx.select().from(items).where(and(eq(items.userId,userId),eq(items.id,id))).for('update');
        if (!current) throw new HTTPException(404,{message:'This item could not be found.'});
        if (current.state==='wishlist' && input.state) throw new HTTPException(422,{message:'Wishlist conversion is a separate purchase action.'});
        if (input.categoryId) await activeCategory(tx,userId,input.categoryId);
        const {archived,...fields}=input;
        const [item]=await tx.update(items).set({...fields,...(archived===undefined?{}:{archivedAt:archived?new Date().toISOString():null})}).where(and(eq(items.userId,userId),eq(items.id,id))).returning();
        if (input.categoryId) await rememberCategory(tx,userId,input.categoryId);
        return {item};
      });
    },
    bulkEdit(userId:string,key:string,input:z.infer<typeof bulkItemInput>) {
      return withIdempotency(db,userId,key,'bulk_edit',input,async tx=>{
        await lockCollection(tx,userId);
        const selected=await tx.select().from(items).where(and(eq(items.userId,userId),inArray(items.id,input.ids),isNull(items.archivedAt))).orderBy(items.id).for('update');
        if(selected.length!==input.ids.length) throw new HTTPException(404,{message:'One or more selected items are unavailable. Refresh and try again.'});
        if(input.changes.state && selected.some(x=>x.state==='wishlist')) throw new HTTPException(422,{message:'Wishlist conversion is a separate purchase action.'});
        if(input.changes.categoryId) await activeCategory(tx,userId,input.changes.categoryId);
        const {archived,...fields}=input.changes;
        await tx.update(items).set({...fields,...(archived===undefined?{}:{archivedAt:archived?new Date().toISOString():null})}).where(and(eq(items.userId,userId),inArray(items.id,input.ids)));
        if(input.changes.categoryId) await rememberCategory(tx,userId,input.changes.categoryId);
        return {updated:selected.length};
      });
    },
    importCollection(userId:string,key:string,input:z.infer<typeof importInput>) {
      return withIdempotency(db,userId,key,'collection_import',input,async tx=>{
        const profile=await lockCollection(tx,userId);
        if(input.rows.some(r=>r.amountMinor!==null && r.currency!==profile.currency)) throw new HTTPException(422,{message:"Use your profile's reporting currency for imported purchases."});
        const existingCategories=await tx.select().from(categories).where(eq(categories.userId,userId));
        const categoryMap=new Map(existingCategories.map(c=>[c.name.toLowerCase(),c]));
        const existing=await tx.select({name:items.name,acquiredOn:items.acquiredOn,categoryId:items.categoryId}).from(items).where(eq(items.userId,userId));
        const names=new Map(existingCategories.map(c=>[c.id,c.name]));
        const seen=new Set(existing.map(x=>duplicateIdentity({...x,category:names.get(x.categoryId) ?? ''})));
        let imported=0,skipped=0;
        for(const row of input.rows) {
          const identity=duplicateIdentity(row);
          if(input.skipDuplicates && seen.has(identity)) {skipped++;continue;}
          let category=categoryMap.get(row.category.toLowerCase());
          if(category?.archivedAt) throw new HTTPException(422,{message:`The ${row.category} category is archived. Choose an active category.`});
          if(!category) {
            [category]=await tx.insert(categories).values({userId,name:row.category}).returning();
            categoryMap.set(row.category.toLowerCase(),category);
          }
          const [item]=await tx.insert(items).values({userId,categoryId:category.id,name:row.name,acquiredOn:row.acquiredOn,description:row.description,state:row.state}).returning();
          if(row.amountMinor!==null) await tx.insert(transactions).values({userId,itemId:item.id,categoryId:category.id,amountMinor:row.amountMinor,currency:profile.currency,occurredOn:row.acquiredOn!,merchant:row.merchant});
          seen.add(identity);imported++;
          await rememberCategory(tx,userId,category.id);
        }
        return {imported,skipped};
      });
    },
    backup(userId:string) {
      // A consistent snapshot across all tables, including rows hidden by UI filters.
      return db.transaction(async tx=>{
        await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
        const [profile]=await tx.select().from(profiles).where(eq(profiles.userId,userId));
        if(!profile) throw new HTTPException(409,{message:'Set up your profile first.'});
        const allCategories=await tx.select().from(categories).where(eq(categories.userId,userId));
        const allItems=await tx.select().from(items).where(eq(items.userId,userId));
        const allTransactions=await tx.select().from(transactions).where(eq(transactions.userId,userId));
        const reviews=await tx.select().from(itemReviews).where(eq(itemReviews.userId,userId));
        const [prefs]=await tx.select().from(collectionPreferences).where(eq(collectionPreferences.userId,userId));
        const photos=await tx.select().from(itemPhotos).where(and(eq(itemPhotos.userId,userId),eq(itemPhotos.status,'active')));
        const allTags=await tx.select().from(tags).where(eq(tags.userId,userId));
        const allItemTags=await tx.select().from(itemTags).where(eq(itemTags.userId,userId));
        const allSubscriptions=await tx.select().from(subscriptions).where(eq(subscriptions.userId,userId));
        const resolutions=await tx.select().from(renewalResolutions).where(eq(renewalResolutions.userId,userId));
        // Account-level email consent, unsubscribe tokens and delivery logs are not portable.
        const backup=backupInput.parse({format:'inventory-backup',version:2,exportedAt:new Date().toISOString(),profile,categories:allCategories,items:allItems,transactions:allTransactions,reviews,tags:allTags,itemTags:allItemTags,subscriptions:allSubscriptions,renewalResolutions:resolutions,preferences:{savedViews:prefs?.savedViews??[],recentCategoryIds:prefs?.recentCategoryIds??[]},photos:photos.map(p=>({...p,file:`photos/${p.id}.${p.mimeType==='image/png'?'png':p.mimeType==='image/webp'?'webp':'jpg'}`}))});
        return {backup,photoPaths:photos.map(p=>({id:p.id,path:p.storagePath}))};
      },{isolationLevel:'repeatable read'});
    },
    restoreCollection(userId:string,key:string,input:Backup) {
      return withIdempotency(db,userId,key,'collection_restore',input,async tx=>{
        await lockCollection(tx,userId);
        const [item]=await tx.select({id:items.id}).from(items).where(eq(items.userId,userId)).limit(1);
        const [expense]=await tx.select({id:transactions.id}).from(transactions).where(eq(transactions.userId,userId)).limit(1);
        if(item || expense) throw new HTTPException(409,{message:'Restore is available only in an empty collection. Export your current data first.'});
        await tx.update(profiles).set(input.profile).where(eq(profiles.userId,userId));
        const existing=await tx.select().from(categories).where(eq(categories.userId,userId));
        const categoryIds=new Map<string,string>();
        for(const {id,...data} of input.categories) {
          const match=existing.find(c=>c.name.toLowerCase()===data.name.toLowerCase());
          const newId=match?.id ?? randomUUID();categoryIds.set(id,newId);
          await tx.insert(categories).values({id:newId,userId,...data}).onConflictDoUpdate({target:categories.id,set:data});
        }
        const result:RestoreResult={itemIds:{},archived:[]};
        for(const {id,categoryId,archivedAt,...data} of input.items) {
          const newId=randomUUID(); result.itemIds[id]=newId;
          // Keep archived items writable until their photo bytes have been restored.
          if(archivedAt) result.archived.push({id:newId,archivedAt});
          await tx.insert(items).values({id:newId,userId,categoryId:categoryIds.get(categoryId)!,...data,archivedAt:null});
        }
        for(const {id: _id,categoryId,itemId,...data} of input.transactions) {
          void _id;
          await tx.insert(transactions).values({userId,categoryId:categoryIds.get(categoryId)!,itemId:itemId?result.itemIds[itemId]:null,...data});
        }
        for(const {id: _id,itemId,...data} of input.reviews) {
          void _id;
          await tx.insert(itemReviews).values({userId,itemId:result.itemIds[itemId],...data});
        }
        if(input.version===2) {
          const tagIds=new Map<string,string>();
          // Reuse an account's unused tag with the same name; never reuse a supplied ID.
          for(const tag of [...input.tags].sort((a,b)=>a.name.localeCompare(b.name))) {
            const [restored]=await tx.insert(tags).values({userId,name:tag.name}).onConflictDoUpdate({target:[tags.userId,tags.name],set:{name:tag.name}}).returning({id:tags.id});
            tagIds.set(tag.id,restored.id);
          }
          for(const link of input.itemTags) await tx.insert(itemTags).values({userId,itemId:result.itemIds[link.itemId],tagId:tagIds.get(link.tagId)!,slot:link.slot});
          const subscriptionIds=new Map<string,string>();
          for(const {id,itemId,...data} of input.subscriptions) {
            const newId=randomUUID();subscriptionIds.set(id,newId);
            await tx.insert(subscriptions).values({id:newId,userId,itemId:result.itemIds[itemId],...data});
          }
          for(const {id: _id,subscriptionId,...data} of input.renewalResolutions) {
            void _id;
            await tx.insert(renewalResolutions).values({userId,subscriptionId:subscriptionIds.get(subscriptionId)!,...data});
          }
        }
        const preferences={savedViews:input.preferences.savedViews.map(v=>({...v,filters:{...v.filters,categoryId:v.filters.categoryId?categoryIds.get(v.filters.categoryId):undefined}})),recentCategoryIds:input.preferences.recentCategoryIds.map(id=>categoryIds.get(id)!)};
        await tx.insert(collectionPreferences).values({userId,...preferences}).onConflictDoUpdate({target:collectionPreferences.userId,set:preferences});
        return result;
      });
    },
  };
}
