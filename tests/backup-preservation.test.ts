import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { backupInput } from '../src/shared/collection-tools';

const timestamp='2026-10-01T00:00:00.000Z';
const audit={createdAt:timestamp,updatedAt:timestamp};
function fixture() {
  const categoryId=randomUUID(),itemId=randomUUID(),tagId=randomUUID(),subscriptionId=randomUUID();
  return {
    format:'inventory-backup',version:2,exportedAt:timestamp,
    profile:{currency:'USD',timezone:'UTC',displayName:null},
    categories:[{id:categoryId,name:'Tech',archivedAt:null,...audit}],
    items:[{id:itemId,categoryId,name:'Camera',description:null,state:'owned',acquiredOn:null,condition:null,productUrl:null,targetAmountMinor:null,priority:null,archivedAt:null,...audit}],
    transactions:[],reviews:[],preferences:{savedViews:[],recentCategoryIds:[]},photos:[],
    tags:[{id:tagId,name:'travel'}],itemTags:[{itemId,tagId,slot:1}],
    subscriptions:[{id:subscriptionId,itemId,amountMinor:100,currency:'USD',intervalUnit:'month',billingAnchorOn:'2026-01-31',nextPeriod:1,nextDueOn:'2026-02-28',reminderDays:3,serviceUrl:'https://example.com',emailEnabled:true,status:'active',endsOn:null,revision:2,...audit}],
    renewalResolutions:[{id:randomUUID(),subscriptionId,dueOn:'2026-01-31',createdAt:timestamp}],
  };
}

describe('backup v2 validation',()=>{
  it('requires all v2 datasets and accepts legacy v1 without changing its serialized receipt',()=>{
    const legacy={format:'inventory-backup',version:1,exportedAt:timestamp,profile:{currency:'USD',timezone:'UTC',displayName:null},categories:[],items:[],transactions:[],reviews:[],preferences:{savedViews:[],recentCategoryIds:[]},photos:[]};
    expect(JSON.stringify(backupInput.parse(legacy))).toBe(JSON.stringify(legacy));
    expect(backupInput.safeParse({...legacy,version:2}).success).toBe(false);
    expect(backupInput.safeParse({...fixture(),version:3}).success).toBe(false);
    expect(backupInput.parse(fixture()).version).toBe(2);
  });
  it('rejects broken and duplicate tag links, names, slots and excessive item tags',()=>{
    const backup=fixture();
    for(const changes of [
      {tags:[...backup.tags,backup.tags[0]]},
      {tags:[...backup.tags,{id:randomUUID(),name:' Travel '}]},
      {itemTags:[{...backup.itemTags[0],tagId:randomUUID()}]},
      {itemTags:[{...backup.itemTags[0],itemId:randomUUID()}]},
      {itemTags:[...backup.itemTags,backup.itemTags[0]]},
      {itemTags:[{...backup.itemTags[0],slot:6}]},
      {tags:[{...backup.tags[0],name:'bad\nname'}]},
    ]) expect(backupInput.safeParse({...backup,...changes}).success).toBe(false);
    const extra={id:randomUUID(),name:'second'};
    expect(backupInput.safeParse({...backup,tags:[...backup.tags,extra],itemTags:[...backup.itemTags,{...backup.itemTags[0],tagId:extra.id}]}).success).toBe(false);
  });
  it('validates subscription relations, schedules, currency and renewal history',()=>{
    const backup=fixture(),subscription=backup.subscriptions[0],resolution=backup.renewalResolutions[0];
    for(const changes of [
      {itemId:randomUUID()},{currency:'EUR'},{nextDueOn:'2026-03-01'},{nextPeriod:10001},
      {status:'ending',endsOn:null},{status:'active',endsOn:'2026-03-01'},{serviceUrl:'javascript:alert(1)'},
    ]) expect(backupInput.safeParse({...backup,subscriptions:[{...subscription,...changes}]}).success).toBe(false);
    expect(backupInput.safeParse({...backup,subscriptions:[subscription,{...subscription,id:randomUUID()}]}).success).toBe(false);
    for(const changes of [{subscriptionId:randomUUID()},{dueOn:subscription.nextDueOn},{dueOn:'2026-03-01'}]) {
      expect(backupInput.safeParse({...backup,renewalResolutions:[{...resolution,...changes}]}).success).toBe(false);
    }
    expect(backupInput.safeParse({...backup,renewalResolutions:[resolution,{...resolution,id:randomUUID()}]}).success).toBe(false);
  });
  it('strips source account identifiers and account-specific reminder settings',()=>{
    const backup=fixture(),userId=randomUUID();
    const result=backupInput.parse({...backup,reminderPreferences:{enabled:true,unsubscribeNonce:randomUUID()},subscriptions:[{...backup.subscriptions[0],userId}],tags:[{...backup.tags[0],userId}],itemTags:[{...backup.itemTags[0],userId}],renewalResolutions:[{...backup.renewalResolutions[0],userId}]});
    expect(JSON.stringify(result)).not.toContain(userId);
    expect(result).not.toHaveProperty('reminderPreferences');
  });
});
