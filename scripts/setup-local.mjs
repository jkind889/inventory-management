import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import postgres from "postgres";
const status = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8" }));
const adminUrl = new URL(status.DB_URL);
if (!["127.0.0.1", "localhost"].includes(adminUrl.hostname)) throw new Error("Local setup requires a loopback database.");
const password = randomBytes(32).toString("hex");
const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
try {
  // Hex generated in this process; no user-supplied SQL and no secret output.
  await admin.unsafe(`alter role inventory_runtime password '${password}'`);
  const runtime = new URL(adminUrl); runtime.username = "inventory_runtime"; runtime.password = password;
  const values = [
    `NEXT_PUBLIC_SUPABASE_URL=${status.API_URL}`,
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${status.PUBLISHABLE_KEY ?? status.ANON_KEY}`,
    `DATABASE_URL=${runtime}`,
    `DATABASE_ADMIN_URL=${adminUrl}`,
  ].join("\n") + "\n";
  writeFileSync(".env.test.local", values, { mode: 0o600 });
  console.log("Local test environment saved to .env.test.local. No cloud settings changed.");
} finally { await admin.end(); }
