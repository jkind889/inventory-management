import "server-only";
import { rootCertificates } from "node:tls";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { supabaseRootCA } from "./supabase-ca";

export function createDatabase(url: string) {
  const parsed = new URL(url);
  if (decodeURIComponent(parsed.username).split(".")[0] !== "inventory_runtime") {
    throw new Error("DATABASE_URL must use the restricted inventory_runtime role.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  const client = postgres(url, {
    prepare: false, max: 5, idle_timeout: 20, connect_timeout: 10,
    ssl: local ? false : { rejectUnauthorized: true, ca: [...rootCertificates, supabaseRootCA] },
    onnotice: () => {},
  });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
export type Database = ReturnType<typeof createDatabase>["db"];
export type UserTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
let connection: ReturnType<typeof createDatabase> | undefined;
export function getDatabase(): Database {
  if (!connection) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
    connection = createDatabase(process.env.DATABASE_URL);
  }
  return connection.db;
}
export function withUser<T>(db: Database, userId: string, run: (tx: UserTransaction) => Promise<T>) {
  return db.transaction(async (tx) => {
    // Connection pools reuse sessions: never set identity outside a transaction.
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return run(tx);
  });
}
