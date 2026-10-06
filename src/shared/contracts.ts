import { z } from "zod";
export const currencies = ["USD", "EUR", "GBP", "CAD", "AUD"] as const;
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value &&
      value >= "1900-01-01"
    );
  }, "Use a valid calendar date from 1900 onward.");
const name = z.string().trim().min(1).max(200);
export const existingItemInput = z
  .object({
    name,
    categoryId: z.uuid(),
    acquiredOn: calendarDate.nullable().default(null),
    description: z.string().trim().max(5000).nullable().default(null),
  })
  .strict();
export const purchaseInput = z
  .object({
    name,
    categoryId: z.uuid(),
    amountMinor: z.number().int().min(1).max(999999999999),
    currency: z.enum(currencies),
    occurredOn: calendarDate,
    merchant: z.string().trim().max(200).nullable().default(null),
    note: z.string().trim().max(5000).nullable().default(null),
  })
  .strict();
export type PurchaseInput = z.infer<typeof purchaseInput>;
export const paginationInput = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
export const collectionInput = paginationInput.extend({
  q: z.string().trim().max(200).default(""),
  categoryId: z.uuid().optional(),
  sort: z.enum(["newest", "name", "purchased"]).default("newest"),
});
export const spendingInput = z
  .object({ from: calendarDate, to: calendarDate })
  .refine((v) => v.from <= v.to, "from must precede to");
export const transactionListInput = paginationInput
  .extend({
    from: calendarDate.optional(),
    to: calendarDate.optional(),
  })
  .refine(
    (v) => (!v.from && !v.to) || (!!v.from && !!v.to && v.from <= v.to),
    "Supply both from and to, with from preceding to.",
  );
export const bootstrapInput = z
  .object({
    currency: z.enum(currencies).default("USD"),
    timezone: z
      .string()
      .max(100)
      .default("America/New_York")
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Use a valid time zone."),
  })
  .strict();
