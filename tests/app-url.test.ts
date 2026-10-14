import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppUrl } from "../src/server/app-url";

afterEach(() => vi.unstubAllEnvs());

describe("canonical app origin", () => {
  it("preserves the local port and normalizes a deployed origin", () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    expect(getAppUrl()).toBe("http://localhost:3000");
    vi.stubEnv("APP_URL", "https://Inventory.example.com/");
    expect(getAppUrl()).toBe("https://inventory.example.com");
  });

  it.each([undefined, "", "localhost:3000", "javascript:alert(1)", "https://user:password@example.com", "https://example.com/app", "https://example.com/?secret=1", "https://example.com/#fragment"])(
    "rejects invalid configuration without exposing it: %s",
    value => {
      vi.stubEnv("APP_URL", value);
      expect(getAppUrl).toThrow("APP_URL must be an HTTP(S) origin without credentials, a path, query, or fragment.");
    },
  );
});
