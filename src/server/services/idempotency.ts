import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { withUser, type Database, type UserTransaction } from "../db/client";
import { operations, type OperationResults } from "../db/schema";

// Keep the mutation and its replay receipt in one account-scoped transaction.
export function withIdempotency<K extends keyof OperationResults>(
  db: Database,
  userId: string,
  key: string,
  operationType: K,
  input: unknown,
  run: (tx: UserTransaction) => Promise<OperationResults[K]>,
) {
  return withUser(db, userId, async tx => {
    // All operation types share this lock/key namespace to reject cross-flow reuse.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`}, 0))`);
    // Preserve purchase hashes already recorded by the original implementation.
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const [previous] = await tx.select().from(operations).where(and(eq(operations.userId, userId), eq(operations.idempotencyKey, key)));
    if (previous) {
      if (previous.operationType !== operationType || previous.requestHash !== hash) {
        throw new HTTPException(409, { message: "That request key was already used for a different submission." });
      }
      // The operation type was checked above before decoding its saved result.
      return { ...previous.result as OperationResults[K], replayed: true };
    }
    const result = await run(tx);
    await tx.insert(operations).values({ userId, idempotencyKey: key, operationType, requestHash: hash, result });
    return { ...result, replayed: false };
  });
}
