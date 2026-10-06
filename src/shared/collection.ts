import type {
  categories,
  items,
  profiles,
  transactions,
} from "../server/db/schema";
export type Category = typeof categories.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
export type CollectionItem = typeof items.$inferSelect & {
  recordedCostMinor: string | null;
};
export type CollectionResponse = {
  data: CollectionItem[];
  total: number;
  limit: number;
  offset: number;
};
export type ItemDetail = {
  item: typeof items.$inferSelect;
  transactions: (typeof transactions.$inferSelect)[];
};
export function formatMoney(minor: string | number, currency: string) {
  // Intl formats the whole part from BigInt, so large totals stay exact.
  const amount = BigInt(minor);
  const whole = amount / 100n;
  const cents = (amount % 100n).toString().padStart(2, "0");
  return new Intl.NumberFormat("en-US", { style: "currency", currency })
    .formatToParts(whole)
    .map((part) => (part.type === "fraction" ? cents : part.value))
    .join("");
}
export function formatDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${value}T12:00:00Z`))
    : "Date not recorded";
}
export function parsePrice(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return cents >= 1 && cents <= 999999999999 ? cents : null;
}
