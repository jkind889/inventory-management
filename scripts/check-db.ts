import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/server/db/client";
import { items } from "../src/server/db/schema";

config({ path: ".env.local", quiet: true });
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing.");
  const connection = createDatabase(process.env.DATABASE_URL);
  try {
    const [role] = await connection.db.execute(sql`
      select current_user as username, rolbypassrls, rolsuper, rolcreaterole
      from pg_roles where rolname = current_user
    `);
    if (role.username !== "inventory_runtime" || role.rolbypassrls || role.rolsuper || role.rolcreaterole) {
      throw new Error("Database role has unexpected privileges.");
    }
    // With no verified user context, the runtime must see no collection data.
    const visible = await connection.db.select({ id: items.id }).from(items).limit(1);
    if (visible.length !== 0) throw new Error("Database exposed records without user context.");
    console.log("Connected through Drizzle. Restricted role verified; no records visible without user context.");
  } finally {
    await connection.close();
  }
}
main().catch(error => {
  // Do not dump driver exceptions: they may include SQL or connection details.
  console.error("Database check failed.", { code: error.code ?? error.cause?.code ?? "CHECK_FAILED" });
  process.exitCode = 1;
});
