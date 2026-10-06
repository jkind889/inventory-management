import type { transactions } from "../server/db/schema";
export type SpendingSummary = {
  currency: string;
  from: string;
  to: string;
  grossSpendingMinor: string;
  breakdown: {
    categoryId: string;
    categoryName: string;
    amountMinor: string;
  }[];
};
export type SpendingTransaction = typeof transactions.$inferSelect & {
  itemName: string | null;
  categoryName: string;
  itemArchivedAt: string | null;
};
export type TransactionHistory = {
  data: SpendingTransaction[];
  total: number;
  limit: number;
  offset: number;
};
export function monthRange(month: string) {
  if (!/^(19\d{2}|[2-9]\d{3})-(0[1-9]|1[0-2])$/.test(month))
    throw new Error("Choose a valid month from 1900 onward.");
  const [year, number] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${lastDay}` };
}
export function shiftMonth(month: string, offset: number) {
  monthRange(month);
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1 + offset, 1))
    .toISOString()
    .slice(0, 7);
}
export function currentMonth(timezone: string) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}
export function spendingShare(amount: string, total: string) {
  return BigInt(total) === 0n
    ? 0
    : Number((BigInt(amount) * 10000n) / BigInt(total)) / 100;
}
