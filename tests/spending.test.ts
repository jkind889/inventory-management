import { describe, expect, it } from "vitest";
import { monthRange, shiftMonth, spendingShare } from "../src/shared/spending";
describe("spending periods", () => {
  it("uses calendar month boundaries including leap years", () => {
    expect(monthRange("2024-02")).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
    });
    expect(monthRange("2026-02").to).toBe("2026-02-28");
    expect(monthRange("2026-04").to).toBe("2026-04-30");
    expect(monthRange("2026-12").to).toBe("2026-12-31");
    for (const bad of ["", "2026-13", "2026-2", "1899-12"])
      expect(() => monthRange(bad)).toThrow();
  });
  it("navigates across years without date drift", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
  it("calculates category shares from exact integer totals", () => {
    expect(spendingShare("0", "0")).toBe(0);
    expect(spendingShare("9007199254740993", "18014398509481986")).toBe(50);
  });
});
