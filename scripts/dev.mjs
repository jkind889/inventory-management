import { spawn } from "node:child_process";
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", ...process.argv.slice(2)], { stdio: "inherit" });
children.push(next);
next.on("error", () => stop(1));
next.on("exit", code => stop(code ?? 0));
if (process.env.REMINDER_WORKER_SECRET && (process.env.RESEND_API_KEY || process.env.RESEND_API)) {
  const args = process.argv.slice(2);
  const portIndex = args.findIndex(arg => arg === "--port" || arg === "-p");
  const port = portIndex >= 0 ? args[portIndex + 1] : process.env.PORT || "3000";
  const worker = spawn(process.execPath, ["scripts/reminders-worker.mjs", "--watch"], { stdio: "inherit", env: { ...process.env, REMINDER_WORKER_URL: `http://localhost:${port}` } });
  children.push(worker);
  worker.on("error", () => stop(1));
  worker.on("exit", code => { if (!stopping && code) stop(code); });
}
