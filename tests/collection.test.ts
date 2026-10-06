import { describe, expect, it } from "vitest";
import { formatMoney, parsePrice } from "../src/shared/collection";
describe("purchase amounts", () => {
  it("parses decimal input without floating point rounding", () => {
    expect(parsePrice("19.99")).toBe(1999);
    expect(parsePrice("0.29")).toBe(29);
    expect(parsePrice("9999999999.99")).toBe(999999999999);
    for (const value of ["0", "-1", "1e2", "1.001", "1,000", "10000000000", ""])
      expect(parsePrice(value)).toBeNull();
  });
  it("formats totals above the safe integer range exactly", () => {
    expect(formatMoney("9007199254740993", "USD")).toBe(
      "$90,071,992,547,409.93",
    );
    expect(formatMoney(29, "USD")).toBe("$0.29");
  });
});
