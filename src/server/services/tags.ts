import { and, eq, sql } from "drizzle-orm";
import { itemTags, items, tags } from "../db/schema";
import type { UserTransaction } from "../db/client";
import { tagNamesInput, type Tag } from "../../shared/tags";

// Correlated aggregation returns one row per item, without multiplying counts or pages.
export const selectedTags = sql<Tag[]>`coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by it.slot)
  from app.item_tags it join app.tags t on t.user_id = it.user_id and t.id = it.tag_id
  where it.user_id = "items"."user_id" and it.item_id = "items"."id"), '[]'::jsonb)`;

export function taggedWhere(userId: string, q: string, tagIds: string[] = []) {
  return and(
    q ? sql`(strpos(lower(${items.name}), lower(${q})) > 0 or exists (
      select 1 from app.item_tags it join app.tags t on t.user_id = it.user_id and t.id = it.tag_id
      where it.user_id = ${userId} and it.item_id = ${items.id} and strpos(t.name, lower(${q})) > 0))` : undefined,
    ...tagIds.map(id => sql`exists (select 1 from app.item_tags it where it.user_id = ${userId} and it.item_id = ${items.id} and it.tag_id = ${id}::uuid)`),
  );
}

export function creationTags<T extends { tags?: string[] }>(input: T) {
  const { tags: supplied, ...fields } = input;
  const names = tagNamesInput.parse(supplied ?? []).sort();
  // Empty/omitted tags must keep the exact historical creation receipt hash.
  const receipt = names.length ? { ...fields, tags: names } : fields;
  return { names, fields, receipt };
}

// Caller holds the item lock (or created the item in this transaction).
export async function replaceTags(tx: UserTransaction, userId: string, itemId: string, names: string[]): Promise<Tag[]> {
  const result: Tag[] = [];
  // Consistent upsert order avoids deadlocks when two items create overlapping tags.
  for (const name of [...names].sort()) {
    const [tag] = await tx.insert(tags).values({ userId, name })
      .onConflictDoUpdate({ target: [tags.userId, tags.name], set: { name } })
      .returning({ id: tags.id, name: tags.name });
    result.push(tag);
  }
  await tx.delete(itemTags).where(and(eq(itemTags.userId, userId), eq(itemTags.itemId, itemId)));
  if (result.length) await tx.insert(itemTags).values(result.map((tag, index) => ({ userId, itemId, tagId: tag.id, slot: index + 1 })));
  return result;
}
