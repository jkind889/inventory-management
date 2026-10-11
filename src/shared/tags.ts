import { z } from "zod";

export const MAX_ITEM_TAGS = 5;
export const MAX_TAG_LENGTH = 30;
export type Tag = { id: string; name: string };
export type TaggedItem<T> = T & { tags: Tag[] };
export type TagsResponse = { data: Tag[]; total: number; limit: number; offset: number };
export const TAGS_CHANGED = "inventory:tags-changed";
export const normalizeTag = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
export const tagLength = (value: string) => Array.from(normalizeTag(value)).length;
export const tagNameInput = z.string()
  .refine(value => !/\p{Cc}/u.test(value), "Tags cannot contain control characters.")
  .transform(normalizeTag)
  .refine(value => value.length > 0, "Enter a tag name.")
  .refine(value => Array.from(value).length <= MAX_TAG_LENGTH, "Tags must be 30 characters or fewer.");
export const tagNamesInput = z.array(tagNameInput).max(MAX_ITEM_TAGS, "An item can have up to 5 tags.")
  .refine(values => new Set(values).size === values.length, "Each tag can appear only once.");
export const itemTagsInput = z.object({ tags: tagNamesInput }).strict();
export const tagFilterInput = z.array(z.uuid()).max(MAX_ITEM_TAGS).transform(values => [...new Set(values)].sort()).optional();
