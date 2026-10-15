import { config } from "dotenv";
import { setTimeout as delay } from "node:timers/promises";
config({ path: ".env.local", quiet: true });

const watch = process.argv.includes("--watch");
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => controller.abort());
const origin = new URL(process.env.REMINDER_WORKER_URL || process.env.APP_URL || "http://localhost:3000");
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw new Error("This runner is for local development. Configure Supabase Cron for hosted delivery.");
if (!process.env.REMINDER_WORKER_SECRET) throw new Error("Configure REMINDER_WORKER_SECRET in .env.local.");
if (watch) await delay(5000, undefined, { signal: controller.signal }).catch(() => {});
let consecutiveFailures = 0;
do {
  if (controller.signal.aborted) break;
  try {
    const response = await fetch(new URL("/api/internal/reminders/run", origin), {
      method: "POST", headers: { Authorization: `Bearer ${process.env.REMINDER_WORKER_SECRET}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
    });
    if (!response.ok) throw new Error(`Worker returned HTTP ${response.status}.`);
    const result = await response.json();
    if (!watch || result.accepted || result.failed || consecutiveFailures) console.log(`Reminder worker: ${result.accepted ?? 0} accepted, ${result.failed ?? 0} failed${result.disabled ? " (email disabled)" : ""}.`);
    consecutiveFailures = 0;
  } catch {
    if (controller.signal.aborted) break;
    consecutiveFailures++;
    if (consecutiveFailures === 1 || !watch) console.error("Reminder worker could not reach the local app. Check that the server and reminder settings are ready.");
    if (!watch) process.exitCode = 1;
  }
  if (watch) await delay(consecutiveFailures ? 30000 : 15 * 60000, undefined, { signal: controller.signal }).catch(() => {});
} while (watch && !controller.signal.aborted);
