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
    for (const path of ["/api/collections/overview", "/api/wants"]) expect((await api().request(path)).status).toBe(401);
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
    expect((await api().request("/api/items", { method: "POST", headers: { ...headers, "Idempotency-Key": userId }, body: "{" })).status).toBe(400);
    for (const path of ["/api/items", "/api/purchases"]) {
      const common = { name: "Headphones", categoryId: userId };
      const body = JSON.stringify(path === "/api/items" ? common : { ...common, amountMinor: 100, currency: "USD", occurredOn: "2026-10-01" });
      for (const key of [undefined, "not-a-uuid"]) {
        expect((await api().request(path, { method: "POST", headers: { ...headers, ...(key ? { "Idempotency-Key": key } : {}) }, body })).status).toBe(400);
      }
    }
  });
  it("validates paired transaction dates before querying", async () => {
    const headers = { Authorization: "Bearer valid" };
    for (const query of ["from=2026-10-01", "to=2026-10-31", "from=2026-10-02&to=2026-10-01", "from=2026-02-30&to=2026-03-01", "limit=0"]) {
      expect((await api().request(`/api/transactions?${query}`, { headers })).status).toBe(400);
    }
  });
  it("bounds pagination and validates spending date order", async () => {
    const headers = { Authorization: "Bearer valid" };
    expect((await api().request("/api/items?limit=100000", { headers })).status).toBe(400);
    expect((await api().request("/api/spending/summary?from=2026-10-02&to=2026-10-01", { headers })).status).toBe(400);
  });
  it("validates wishlist input and request keys before invoking the service", async () => {
    const base = { name: "Future headphones", categoryId: userId };
    const headers = { Authorization: "Bearer valid", "Content-Type": "application/json", "Idempotency-Key": userId };
    for (const change of [{ productUrl: "javascript:alert(1)" }, { productUrl: "file:///tmp/private" }, { targetAmountMinor: -1 }, { targetAmountMinor: 0.5 }, { priority: 4 }, { state: "owned" }, { userId }]) {
      expect((await api().request("/api/wants", { method: "POST", headers, body: JSON.stringify({ ...base, ...change }) })).status).toBe(400);
    }
    expect((await api().request("/api/wants", { method: "POST", headers: { ...headers, "Idempotency-Key": "invalid" }, body: JSON.stringify(base) })).status).toBe(400);
    expect((await api().request("/api/wants?limit=101", { headers })).status).toBe(400);
  });
});
