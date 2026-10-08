import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/server/api/app";
import type { InventoryService } from "../src/server/services/inventory";
import { itemReviewInput } from "../src/shared/contracts";
import { isCollectionCategory, starterCategories } from "../src/shared/collection";

const id = "a336ce88-ed8a-4e4b-8fa8-1f923c88ef25";
const headers = { Authorization: "Bearer valid", "Content-Type": "application/json", "Idempotency-Key": id };
describe("item review API", () => {
  it("keeps subscriptions available for collections", () => {
    expect(starterCategories).toContain("Subscriptions");
    expect(isCollectionCategory({ name: "Subscriptions" })).toBe(true);
  });
  it("validates verdicts, usage, boolean answers, notes and strict fields", async () => {
    const service = vi.fn(() => { throw new Error("Invalid requests must not reach the service"); });
    const app = createApi({ verifyToken: async () => id, service });
    for (const change of [{ verdict: "great" }, { usageFrequency: "sometimes" }, { wouldBuyAgain: "false" }, { note: "x".repeat(5001) }, { userId: id }, { itemId: id }, { createdAt: "2026-10-01" }]) {
      expect((await app.request(`/api/items/${id}/reviews`, { method: "POST", headers, body: JSON.stringify({ verdict: "worth_it", ...change }) })).status).toBe(400);
    }
    for (const key of ["", "invalid"]) {
      expect((await app.request(`/api/items/${id}/reviews`, { method: "POST", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify({ verdict: "unsure" }) })).status).toBe(400);
    }
    expect((await app.request("/api/items/invalid/reviews", { method: "POST", headers, body: JSON.stringify({ verdict: "unsure" }) })).status).toBe(400);
    expect(service).not.toHaveBeenCalled();
  });
  it("requires authentication and forwards normalized content with replay status", async () => {
    const addItemReview = vi.fn().mockResolvedValueOnce({ review: { id }, replayed: false }).mockResolvedValueOnce({ review: { id }, replayed: true });
    const app = createApi({ verifyToken: async token => token === "valid" ? id : null, service: () => ({ addItemReview }) as unknown as InventoryService });
    expect((await app.request(`/api/items/${id}/reviews`, { method: "POST" })).status).toBe(401);
    const request = { method: "POST", headers, body: JSON.stringify({ verdict: "not_worth_it", note: "  Too expensive  " }) };
    expect((await app.request(`/api/items/${id}/reviews`, request)).status).toBe(201);
    expect((await app.request(`/api/items/${id}/reviews`, request)).status).toBe(200);
    expect(addItemReview).toHaveBeenCalledWith(id, id, id, { verdict: "not_worth_it", usageFrequency: null, wouldBuyAgain: null, note: "Too expensive" });
    expect(itemReviewInput.parse({ verdict: "unsure", wouldBuyAgain: false }).wouldBuyAgain).toBe(false);
  });
});
