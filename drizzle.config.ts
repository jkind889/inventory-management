import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
config({ path: ".env.local" });
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle-introspection",
  schemaFilter: ["app"],
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? "" },
});
