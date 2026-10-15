import { describe, expect, it, vi } from "vitest";
import { tagNameInput, tagNamesInput, tagLength } from "../src/shared/tags";
import { existingItemInput, purchaseInput, wantInput } from "../src/shared/contracts";
import { creationTags } from "../src/server/services/tags";
import { createApi } from "../src/server/api/app";
import type { InventoryService } from "../src/server/services/inventory";

const userId = "a336ce88-ed8a-4e4b-8fa8-1f923c88ef25";
const itemId = "b336ce88-ed8a-4e4b-8fa8-1f923c88ef25";
const tagId = "c336ce88-ed8a-4e4b-8fa8-1f923c88ef25";
describe("tag contracts", () => {
  it("normalizes lowercase and whitespace while accepting punctuation and Unicode", () => {
    expect(tagNameInput.parse("  PC\u00a0   Gaming / 日本語  ")).toBe("pc gaming / 日本語");
    expect(tagLength("😀".repeat(30))).toBe(30);
    expect(tagNameInput.parse("😀".repeat(30))).toHaveLength(60);
    expect(tagNameInput.safeParse("😀".repeat(31)).success).toBe(false);
    expect(tagNameInput.safeParse("a".repeat(30)).success).toBe(true);
    expect(tagNameInput.safeParse("a".repeat(31)).success).toBe(false);
  });
  it("rejects blanks, controls, duplicates, and a sixth tag", () => {
    for (const value of ["", "  ", "a\tb", "a\nb", "a\u0085b", "a\0b"]) expect(tagNameInput.safeParse(value).success).toBe(false);
    expect(tagNamesInput.parse([])).toEqual([]);
    expect(tagNamesInput.parse(["a", "b", "c", "d", "e"])).toHaveLength(5);
    expect(tagNamesInput.safeParse(["a", "b", "c", "d", "e", "f"]).success).toBe(false);
    expect(tagNamesInput.safeParse([" Camping ", "camping"]).success).toBe(false);
  });
  it("adds optional tags to every creation flow without changing legacy receipt fields", () => {
    const existing = existingItemInput.parse({ name: "Old item", categoryId: itemId });
    expect(creationTags(existing).receipt).toEqual(existing);
    expect(JSON.stringify(creationTags({ ...existing, tags: [] }).receipt)).toBe(JSON.stringify(existing));
    expect(existingItemInput.parse({ ...existing, tags: [" CAMPING "] }).tags).toEqual(["camping"]);
    expect(wantInput.parse({ name: "Want", categoryId: itemId, tags: ["WANT"] }).tags).toEqual(["want"]);
    expect(purchaseInput.parse({ name: "Purchase", categoryId: itemId, amountMinor: 1, currency: "USD", occurredOn: "2026-10-09", tags: ["GIFT"] }).tags).toEqual(["gift"]);
  });
});

describe("tag API boundaries", () => {
  const headers = { Authorization: "Bearer valid", "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() };
  function fixture() {
    const service = { setItemTags: vi.fn(async () => ({ itemId, tags: [], replayed: false })), tags: vi.fn(async () => ({ data: [], total: 0, limit: 30, offset: 0 })), collection: vi.fn(async () => ({ data: [] })), wants: vi.fn(async () => ({ data: [] })) };
    const app = createApi({ verifyToken: async token => token === "valid" ? userId : null, service: () => service as unknown as InventoryService });
    return { app, service };
  }
  it("authenticates and validates saves before invoking the service", async () => {
    const { app, service } = fixture();
    expect((await app.request(`/api/items/${itemId}/tags`, { method: "PUT" })).status).toBe(401);
    for (const body of [{ tags: ["a".repeat(31)] }, { tags: ["a", "A"] }, { tags: ["a", "b", "c", "d", "e", "f"] }, { tags: ["a"], other: true }]) {
      expect((await app.request(`/api/items/${itemId}/tags`, { method: "PUT", headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect((await app.request(`/api/items/${itemId}/tags`, { method: "PUT", headers: { Authorization: "Bearer valid" }, body: '{"tags":[]}' })).status).toBe(400);
    expect(service.setItemTags).not.toHaveBeenCalled();
    expect((await app.request(`/api/items/${itemId}/tags`, { method: "PUT", headers, body: '{"tags":[" CAMPING "]}' })).status).toBe(200);
    expect(service.setItemTags).toHaveBeenCalledWith(userId, itemId, headers["Idempotency-Key"], ["camping"]);
  });
  it("parses repeated tag IDs for both list routes and rejects invalid values", async () => {
    const { app, service } = fixture();
    for (const [path, fn] of [["collection", service.collection], ["wants", service.wants]] as const) {
      expect((await app.request(`/api/${path}?tagId=${tagId}&tagId=${itemId}&tagId=${tagId}`, { headers })).status).toBe(200);
      expect(fn).toHaveBeenCalledWith(userId, expect.objectContaining({ tagId: [itemId, tagId].sort() }));
      expect((await app.request(`/api/${path}?tagId=bad`, { headers })).status).toBe(400);
    }
  });
  it("validates paginated suggestions", async () => {
    const { app, service } = fixture();
    expect((await app.request('/api/tags?q=camp&limit=20&offset=20', { headers })).status).toBe(200);
    expect(service.tags).toHaveBeenCalledWith(userId, { q: 'camp', limit: 20, offset: 20 });
    expect((await app.request('/api/tags?limit=101', { headers })).status).toBe(400);
  });
});
