import { z } from 'zod';
import { calendarDate, currencies, itemReviewInput } from './contracts';
import { renewalOn, scheduleInput } from './subscriptions';
import { MAX_ITEM_TAGS, tagNameInput } from './tags';
export const itemStates = ['wishlist', 'owned', 'sold', 'returned', 'donated'] as const;
export const advancedFilters = z.object({
  state: z.enum(['all', ...itemStates]).default('owned'),
  from: calendarDate.optional(), to: calendarDate.optional(),
  minAmountMinor: z.coerce.number().int().min(0).max(999999999999).optional(),
  maxAmountMinor: z.coerce.number().int().min(0).max(999999999999).optional(),
});
export const viewFilters = advancedFilters.extend({ q: z.string().trim().max(200).default(''), categoryId: z.uuid().optional(), sort: z.enum(['newest', 'name', 'purchased', 'price']).default('newest') }).refine(validFilterRange, 'Check the date and price ranges.');
export const savedView = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(80), filters: viewFilters }).strict();
export const preferencesInput = z.object({
  savedViews: z.array(savedView).max(30).refine(v => new Set(v.map(x => x.id)).size === v.length, 'Duplicate saved views.'),
  recentCategoryIds: z.array(z.uuid()).max(6),
}).strict();
export type Preferences = z.infer<typeof preferencesInput>;
export type ViewFilters = z.infer<typeof viewFilters>;
export const itemChanges = z.object({
  name: z.string().trim().min(1).max(200).optional(), categoryId: z.uuid().optional(),
  acquiredOn: calendarDate.nullable().optional(), description: z.string().trim().max(5000).nullable().optional(),
  state: z.enum(['owned', 'sold', 'returned', 'donated']).optional(),
  archived: z.boolean().optional(),
  archivedAt: z.iso.datetime({ offset: true }).nullable().optional(),
}).strict().refine(v => Object.keys(v).length > 0, 'Choose a change.')
  .refine(v => v.archived === undefined || v.archivedAt === undefined, 'Choose one archive value.');
export const bulkItemInput = z.object({ ids: z.array(z.uuid()).min(1).max(100).refine(v => new Set(v).size === v.length, 'Duplicate item IDs.'), changes: itemChanges }).strict();
export const importRow = z.object({
  name: z.string().trim().min(1).max(200), category: z.string().trim().min(1).max(80),
  acquiredOn: calendarDate.nullable().default(null), description: z.string().trim().max(5000).nullable().default(null),
  state: z.enum(itemStates).default('owned'), amountMinor: z.number().int().min(1).max(999999999999).nullable().default(null),
  currency: z.enum(currencies).optional(), merchant: z.string().trim().max(200).nullable().default(null),
}).strict().refine(v => v.amountMinor === null || (!!v.acquiredOn && !!v.currency && v.state !== 'wishlist'), 'Purchases need a date, currency, and a non-wishlist state.');
export const importInput = z.object({ rows: z.array(importRow).min(1).max(500), skipDuplicates: z.boolean().default(true) }).strict();
export type ImportRow = z.infer<typeof importRow>;
const timestamp = z.preprocess(value => typeof value === 'string' ? value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00') : value, z.iso.datetime({ offset: true }));
const audit = { createdAt: timestamp, updatedAt: timestamp };
export const backupCategory = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(80), archivedAt: timestamp.nullable(), ...audit });
export const backupItem = z.object({ id: z.uuid(), categoryId: z.uuid(), name: z.string().trim().min(1).max(200), description: z.string().max(5000).nullable(), state: z.enum(itemStates), acquiredOn: calendarDate.nullable(), condition: z.string().max(120).nullable(), productUrl: z.url().max(2048).refine(v => ['http:', 'https:'].includes(new URL(v).protocol)).nullable(), targetAmountMinor: z.number().int().min(0).max(999999999999).nullable(), priority: z.number().int().min(1).max(3).nullable(), archivedAt: timestamp.nullable(), ...audit });
export const backupTransaction = z.object({ name: z.string().trim().min(1).max(200).nullable().optional(), id: z.uuid(), categoryId: z.uuid(), itemId: z.uuid().nullable(), kind: z.literal('expense'), amountMinor: z.number().int().min(1).max(999999999999), currency: z.enum(currencies), occurredOn: calendarDate, merchant: z.string().max(200).nullable(), note: z.string().max(5000).nullable(), ...audit });
export const backupReview = itemReviewInput.extend({ id: z.uuid(), itemId: z.uuid(), createdAt: timestamp }).strip();
export const backupPhoto = z.object({ id: z.uuid(), itemId: z.uuid(), mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']), byteSize: z.number().int().min(1).max(5000000), checksum: z.string().regex(/^[a-f0-9]{64}$/), file: z.string().regex(/^photos\/[0-9a-f-]+\.(png|jpg|webp)$/) });
const backupRecords = z.object({
  format: z.literal('inventory-backup'), version: z.literal(1), exportedAt: timestamp,
  profile: z.object({ currency: z.enum(currencies), timezone: z.string().max(100).refine(v => { try { new Intl.DateTimeFormat('en', {timeZone:v}); return true; } catch { return false; } }), displayName: z.string().max(120).nullable() }),
  categories: z.array(backupCategory).max(1000), items: z.array(backupItem).max(10000),
  transactions: z.array(backupTransaction).max(50000), reviews: z.array(backupReview).max(50000),
  preferences: preferencesInput, photos: z.array(backupPhoto).max(10000),
});
const backupTag = z.object({ id: z.uuid(), name: tagNameInput });
const backupItemTag = z.object({ itemId: z.uuid(), tagId: z.uuid(), slot: z.number().int().min(1).max(MAX_ITEM_TAGS) });
const backupSubscription = scheduleInput.safeExtend({
  id: z.uuid(), itemId: z.uuid(), currency: z.enum(currencies), nextDueOn: calendarDate,
  status: z.enum(['active', 'ending', 'stopped']), endsOn: calendarDate.nullable(),
  revision: z.number().int().min(1).max(2147483647), ...audit,
}).strip().refine(v => (v.status === 'ending') === (v.endsOn !== null), 'Subscription ending status must match its end date.')
  .refine(v => {
    try { return v.nextDueOn === renewalOn(v.billingAnchorOn, v.intervalUnit, v.nextPeriod); } catch { return false; }
  }, 'Subscription renewal date does not match its schedule.');
const backupResolution = z.object({ id: z.uuid(), subscriptionId: z.uuid(), dueOn: calendarDate, createdAt: timestamp });
// Keep v1 parsing unchanged: adding defaults would change historical restore receipt hashes.
export const backupInput = z.discriminatedUnion('version', [
  backupRecords.extend({ version: z.literal(1) }),
  backupRecords.extend({
    version: z.literal(2), tags: z.array(backupTag).max(50000), itemTags: z.array(backupItemTag).max(50000),
    subscriptions: z.array(backupSubscription).max(10000), renewalResolutions: z.array(backupResolution).max(50000),
  }),
]).superRefine((v, ctx) => {
  const cat = new Set(v.categories.map(x => x.id)), ids = new Set(v.items.map(x => x.id));
  const fail = (message: string) => ctx.addIssue({ code:'custom', message });
  for (const group of [v.categories, v.items, v.transactions, v.reviews, v.photos]) if (new Set(group.map(x=>x.id)).size !== group.length) fail('Duplicate record IDs.');
  if (new Set(v.categories.map(x => x.name.toLowerCase())).size !== v.categories.length) fail('Duplicate category names.');
  if (v.items.some(x=>!cat.has(x.categoryId)) || v.transactions.some(x=>!cat.has(x.categoryId) || (x.itemId && !ids.has(x.itemId))) || [...v.reviews, ...v.photos].some(x=>!ids.has(x.itemId))) fail('Backup contains broken links.');
  if (v.transactions.some(x=>x.currency!==v.profile.currency)) fail('Backup currencies do not match.');
  if (v.preferences.savedViews.some(x=>x.filters.categoryId && !cat.has(x.filters.categoryId)) || v.preferences.recentCategoryIds.some(x=>!cat.has(x))) fail('Backup preferences contain broken links.');
  if (new Set(v.photos.map(x=>x.itemId)).size !== v.photos.length) fail('Multiple cover photos for an item.');
  if (v.version === 2) {
    const tagIds = new Set(v.tags.map(tag => tag.id));
    const subscriptions = new Map(v.subscriptions.map(subscription => [subscription.id, subscription]));
    for (const group of [v.tags, v.subscriptions, v.renewalResolutions]) if (new Set(group.map(x => x.id)).size !== group.length) fail('Duplicate record IDs.');
    if (new Set(v.tags.map(tag => tag.name)).size !== v.tags.length) fail('Duplicate tag names.');
    if (v.itemTags.some(link => !ids.has(link.itemId) || !tagIds.has(link.tagId))) fail('Backup contains broken tag links.');
    if (new Set(v.itemTags.map(link => `${link.itemId}:${link.tagId}`)).size !== v.itemTags.length ||
        new Set(v.itemTags.map(link => `${link.itemId}:${link.slot}`)).size !== v.itemTags.length) fail('Duplicate item tags or tag slots.');
    if (v.subscriptions.some(subscription => !ids.has(subscription.itemId))) fail('Backup contains broken subscription links.');
    if (new Set(v.subscriptions.map(subscription => subscription.itemId)).size !== v.subscriptions.length) fail('Multiple subscriptions for an item.');
    if (v.subscriptions.some(subscription => subscription.currency !== v.profile.currency)) fail('Backup subscription currencies do not match.');
    if (new Set(v.renewalResolutions.map(resolution => `${resolution.subscriptionId}:${resolution.dueOn}`)).size !== v.renewalResolutions.length) fail('Duplicate resolved renewals.');
    if (v.renewalResolutions.some(resolution => !subscriptions.has(resolution.subscriptionId) || resolution.dueOn >= subscriptions.get(resolution.subscriptionId)!.nextDueOn)) fail('Backup contains invalid resolved renewals.');
  }
});
export type Backup = z.infer<typeof backupInput>;
export type ImportResult = { imported: number; skipped: number };
export type RestoreResult = { itemIds: Record<string, string>; archived: {id:string; archivedAt:string}[] };
export function validFilterRange(v: {from?:string;to?:string;minAmountMinor?:number;maxAmountMinor?:number}) {
  return (!v.from || !v.to || v.from <= v.to) && (v.minAmountMinor === undefined || v.maxAmountMinor === undefined || v.minAmountMinor <= v.maxAmountMinor);
}
export function duplicateIdentity(row: Pick<ImportRow,'name'|'acquiredOn'> & {category:string}) {
  return JSON.stringify([row.name.trim().toLowerCase(), row.category.trim().toLowerCase(), row.acquiredOn]);
}
