import {describe,expect,it,vi} from 'vitest';
import {collectionInput} from '../src/shared/contracts';
import {backupInput,bulkItemInput,importInput,preferencesInput,duplicateIdentity} from '../src/shared/collection-tools';
import {createApi} from '../src/server/api/app';
import type {InventoryService} from '../src/server/services/inventory';
const id='a336ce88-ed8a-4e4b-8fa8-1f923c88ef25';
describe('collection tool validation',()=>{
  it('rejects reversed dates/prices, invalid states and fractional minor units',()=>{
    for(const query of [{from:'2026-10-12',to:'2026-10-01'},{minAmountMinor:'100',maxAmountMinor:'50'},{minAmountMinor:'1.2'},{state:'missing'}]) expect(collectionInput.safeParse(query).success).toBe(false);
    expect(collectionInput.parse({state:'all',q:'%'})).toMatchObject({state:'all',q:'%'});
  });
  it('requires explicit valid purchase information and accepts unknown historical dates',()=>{
    const row={name:'Chair',category:'Furniture'};
    expect(importInput.parse({rows:[row]}).rows[0]).toMatchObject({acquiredOn:null,amountMinor:null});
    for(const changes of [{amountMinor:100},{amountMinor:100,acquiredOn:'2026-02-30',currency:'USD'},{amountMinor:100,acquiredOn:'2026-10-01',currency:'USD',state:'wishlist'}]) expect(importInput.safeParse({rows:[{...row,...changes}]}).success).toBe(false);
    expect(importInput.safeParse({rows:Array.from({length:501},()=>row)}).success).toBe(false);
  });
  it('bounds bulk changes and rejects ownership or spending edits',()=>{
    for(const changes of [{userId:id},{amountMinor:100},{state:'wishlist'},{}])expect(bulkItemInput.safeParse({ids:[id],changes}).success).toBe(false);
    expect(bulkItemInput.safeParse({ids:[id,id],changes:{state:'sold'}}).success).toBe(false);
    expect(preferencesInput.safeParse({savedViews:[{id,name:'bad',filters:{from:'2026-10-10',to:'2026-10-01'}}],recentCategoryIds:[]}).success).toBe(false);
  });
  it('normalizes duplicate identity without inventing a purchase price or date',()=>{
    expect(duplicateIdentity({name:'  CHAIR ',category:'Furniture',acquiredOn:null})).toBe(duplicateIdentity({name:'chair',category:' furniture ',acquiredOn:null}));
    expect(duplicateIdentity({name:'chair',category:'Furniture',acquiredOn:null})).not.toBe(duplicateIdentity({name:'chair',category:'Furniture',acquiredOn:'2026-10-01'}));
  });
  it('protects all new endpoints and validates idempotency keys before calling services',async()=>{
    const app=createApi({verifyToken:async t=>t==='valid'?id:null,service:()=>{throw new Error('Must validate first');}} as Parameters<typeof createApi>[0]);
    for(const [path,method,body] of [['/collection/import','POST',{rows:[]}],['/collection/restore','POST',{}],['/collection/bulk','PATCH',{}],['/collection/preferences','PUT',{}],[`/items/${id}`,'PATCH',{}]] as const){
      expect((await app.request(`/api${path}`,{method,body:JSON.stringify(body)})).status).toBe(401);
      expect((await app.request(`/api${path}`,{method,headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify(body)})).status).toBe(400);
    }
    for(const path of ['/collection/backup','/collection/export','/collection/preferences'])expect((await app.request(`/api${path}`)).status).toBe(401);
    void (null as InventoryService|null);
  });
  it('rejects malformed backup structure and future backup versions',()=>{
    expect(backupInput.safeParse({format:'inventory-backup',version:2}).success).toBe(false);
  });
  it('accepts a category-only item replacement using authenticated identity and rejects invalid fields',async()=>{
    const itemId='0048549f-640e-47cf-a761-972b637c209f';
    const key='db39af54-3800-42bd-bb22-798b01e7e8ac';
    const editItem=vi.fn(async()=>({item:{id:itemId,categoryId:id},replayed:false}));
    const app=createApi({verifyToken:async token=>token==='valid'?id:null,service:()=>({editItem}) as unknown as InventoryService});
    const headers={Authorization:'Bearer valid','Content-Type':'application/json','Idempotency-Key':key};
    const request=(body:unknown)=>app.request(`/api/items/${itemId}`,{method:'PATCH',headers,body:JSON.stringify(body)});
    for(const body of [{},{categoryId:null},{categoryId:''},{categoryId:'invalid'},{categoryId:[id]},{categoryId:id,userId:id},{categoryId:id,tags:['keep']},{categoryId:id,amountMinor:100}]) {
      expect((await request(body)).status).toBe(400);
    }
    expect(editItem).not.toHaveBeenCalled();
    expect((await request({categoryId:id})).status).toBe(200);
    expect(editItem).toHaveBeenCalledExactlyOnceWith(id,itemId,key,{categoryId:id});
  });
});
