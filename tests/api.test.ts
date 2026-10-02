import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/server/api/app";
import type { InventoryService } from "../src/server/services/inventory";
const userId = "a336ce88-ed8a-4e4b-8fa8-1f923c88ef25";
function api() {
  return createApi({ verifyToken: async token => token === "valid" ? userId : null, service: vi.fn(() => { throw new Error("Service must not be invoked for invalid input"); }) as () => InventoryService });
}
describe("API boundary", () => {
  it("provides a health check without database configuration", async () => {
    expect((await api().request("/api/health")).status).toBe(200);
  });
  it("requires authentication before accessing records", async () => {
    expect((await api().request("/api/items")).status).toBe(401);
    expect((await api().request("/api/items", { headers: { Authorization: "Bearer forged" } })).status).toBe(401);
  });
  it("rejects invalid calendar dates, fractional cents, and supplied user IDs", async () => {
    const base = { name: "Headphones", categoryId: userId, amountMinor: 100, currency: "USD", occurredOn: "2026-10-01" };
    for (const change of [{ occurredOn: "2026-02-30" }, { amountMinor: 1.5 }, { amountMinor: -1 }, { userId }]) {
      const response = await api().request("/api/purchases", { method: "POST", headers: { Authorization: "Bearer valid", "Content-Type": "application/json", "Idempotency-Key": userId }, body: JSON.stringify({ ...base, ...change }) });
      expect(response.status).toBe(400);
    }
  });
  it("rejects malformed JSON and missing request keys", async () => {
    const headers = { Authorization: "Bearer valid", "Content-Type": "application/json" };
    expect((await api().request("/api/items", { method: "POST", headers, body: "{" })).status).toBe(400);
    expect((await api().request("/api/purchases", { method: "POST", headers, body: "{}" })).status).toBe(400);
  });
  it("bounds pagination and validates spending date order", async () => {
    const headers = { Authorization: "Bearer valid" };
    expect((await api().request("/api/items?limit=100000", { headers })).status).toBe(400);
    expect((await api().request("/api/spending/summary?from=2026-10-02&to=2026-10-01", { headers })).status).toBe(400);
  });
});
