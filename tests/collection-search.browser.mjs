// Run against the local dev server with npm run test:collection-ui.
// Uses an existing Playwright installation; PLAYWRIGHT_MODULE_PATH can point to
// a bundled runtime. All Auth/API traffic is mocked in this isolated browser.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
const playwright = await import(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const { chromium } = playwright.default ?? playwright;
const baseUrl = process.env.UI_TEST_BASE_URL || "http://localhost:3000";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname), "Browser regression tests must stay local.");
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
const userId = "a336ce88-ed8a-4e4b-8fa8-1f923c88ef25";
const categoryId = "b336ce88-ed8a-4e4b-8fa8-1f923c88ef25";
const now = Math.floor(Date.now() / 1000);
const user = { id: userId, aud: "authenticated", role: "authenticated", email: "collection-test@example.com", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
const token = ["e30", Buffer.from(JSON.stringify({ sub: userId, exp: now + 3600, iat: now, aud: "authenticated" })).toString("base64url"), "fixture"].join(".");
const session = { access_token: token, refresh_token: "fixture", token_type: "bearer", expires_in: 3600, expires_at: now + 3600, user };
const fixtures = Array.from({ length: 13 }, (_, index) => ({ id: `fixture-${index}`, userId, categoryId, name: index === 12 ? "Lamp" : `Chair ${String(index + 1).padStart(2, "0")}`, acquiredOn: null, recordedCostMinor: null }));
const browser = await chromium.launch({ headless: true, channel: process.env.UI_TEST_BROWSER_CHANNEL || "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
const failedRequests = [];
const requests = [];
let holdSearch = null;
let heldRoute = null;
let failSearch = null;
const evidenceDir = process.env.UI_TEST_EVIDENCE_DIR || "/tmp/inventory-collection-search";
await mkdir(evidenceDir, { recursive: true });
page.on("pageerror", error => errors.push(error.message));
page.on("requestfailed", request => failedRequests.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
page.on("console", message => {
  // The recovery scenario deliberately returns one HTTP 500 response.
  if (["error", "warning"].includes(message.type()) && !(message.text().includes("Failed to load resource") && message.text().includes("500"))) errors.push(message.text());
});
await context.addInitScript(({ project, session }) => {
  localStorage.setItem(`sb-${project}-auth-token`, JSON.stringify(session));
}, { project, session });
await context.route("**/auth/v1/**", route => route.fulfill({ json: { user } }));
await context.route("**/api/**", async route => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/profile/bootstrap") return route.fulfill({ json: { profile: { userId, currency: "USD", timezone: "America/New_York", displayName: "Test collection" } } });
  if (url.pathname === "/api/categories") return route.fulfill({ json: { data: [{ id: categoryId, userId, name: "Furniture", archivedAt: null }] } });
  if (url.pathname === "/api/collections/overview") return route.fulfill({ json: { data: [{ category: { id: categoryId, name: "Furniture" }, total: fixtures.length, latest: [] }] } });
  assert.equal(url.pathname, "/api/collection", "Unexpected API call in fixture browser");
  const q = url.searchParams.get("q") || "";
  requests.push({ q, offset: Number(url.searchParams.get("offset")), sort: url.searchParams.get("sort"), category: url.searchParams.get("categoryId") });
  if (q === holdSearch) {
    heldRoute = route;
    return;
  }
  if (q === failSearch) return route.fulfill({ status: 500, json: { error: "Fixture collection failure" } });
  const matches = fixtures.filter(item => item.name.toLowerCase().includes(q.toLowerCase()));
  const offset = Number(url.searchParams.get("offset"));
  return route.fulfill({ json: { data: matches.slice(offset, offset + 12), total: matches.length, limit: 12, offset } });
});

async function waitUntil(predicate, description) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, description);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const search = page.getByRole("textbox", { name: "Search your collection" });
const status = page.locator(".collection-count");
async function settled(text) {
  await waitUntil(async () => (await status.textContent()) === text, `Collection did not settle to ${text}`);
}
try {
  await page.goto(baseUrl);
  assert.equal(new URL(page.url()).origin, new URL(baseUrl).origin);
  assert.equal(await page.title(), "Inventory");
  await page.getByRole("button", { name: "View collection", exact: false }).click();
  await settled("13 items");
  assert.equal(await page.locator(".item-card").count(), 12);
  assert.equal(await page.locator("nextjs-portal").getByText("Runtime Error", { exact: false }).count(), 0);
  await page.screenshot({ path: `${evidenceDir}/loaded.png` });

  // BUG-001: undo before the debounce leaves the settled value unchanged.
  const beforeUndo = requests.length;
  await search.fill("x");
  await search.fill("");
  await settled("13 items");
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await status.textContent(), "13 items");
  assert.equal(requests.length, beforeUndo, "Unchanged search should not fetch again");
  console.log("PASS rapid edit/undo restores existing results without another request");

  await search.fill("Chair");
  await settled("12 items");
  const beforeNonemptyUndo = requests.length;
  await search.fill("ChairX");
  await search.fill("Chair");
  await settled("12 items");
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(requests.length, beforeNonemptyUndo);
  console.log("PASS edit/undo of a nonempty search and ordinary search");

  await search.fill("");
  await settled("13 items");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await settled("13 items");
  await page.getByRole("heading", { name: "Lamp", exact: true }).waitFor();
  assert.equal(requests.at(-1).offset, 12);
  await search.fill("x");
  await search.fill("");
  await page.getByRole("heading", { name: "Chair 01", exact: true }).waitFor();
  await settled("13 items");
  assert.equal(requests.at(-1).offset, 0);
  console.log("PASS pagination and rapid undo from page two reset to page one");

  holdSearch = "slow";
  await search.fill("slow");
  await waitUntil(() => heldRoute !== null, "Slow request was not started");
  assert.equal(await status.textContent(), "Loading your collection…");
  await search.fill("Lamp");
  await settled("1 item");
  // Let an obsolete response arrive after the newer request has completed.
  await heldRoute.fulfill({ json: { data: [{ ...fixtures[0], name: "Obsolete result" }], total: 1, limit: 12, offset: 0 } }).catch(() => {});
  holdSearch = null;
  heldRoute = null;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await page.getByRole("heading", { name: "Lamp", exact: true }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Obsolete result", exact: true }).count(), 0);
  console.log("PASS real pending request remains loading and obsolete response is ignored");

  failSearch = "failure";
  await search.fill("failure");
  await page.locator(".empty-state[role=alert]").getByText("Fixture collection failure").waitFor();
  assert.notEqual(await status.textContent(), "Loading your collection…");
  failSearch = null;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await settled("0 items");
  await page.getByText("Fixture collection failure", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.locator(".empty-state[role=alert]").count(), 0);
  console.log("PASS request failure clears loading and retry recovers");

  await search.fill("");
  await settled("13 items");
  await page.getByRole("combobox", { name: "Sort collection" }).selectOption("name");
  await settled("13 items");
  assert.equal(requests.at(-1).sort, "name");
  await page.getByRole("combobox", { name: "Filter category" }).selectOption("");
  await settled("13 items");
  await page.getByRole("combobox", { name: "Filter category" }).selectOption(categoryId);
  await settled("13 items");
  assert.equal(requests.at(-1).category, categoryId);
  console.log("PASS sort and category changes complete their requests");
  await page.screenshot({ path: `${evidenceDir}/fixed.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await search.fill("x");
  await search.fill("");
  await settled("13 items");
  await page.screenshot({ path: `${evidenceDir}/mobile.png` });
  assert.equal(await page.locator("nextjs-portal").getByText("Runtime Error", { exact: false }).count(), 0);
  assert.ok(failedRequests.every(request => request.path === "/api/collection" && request.error === "net::ERR_ABORTED"), "Unexpected failed resource requests");
  assert.deepEqual(errors, [], "Unexpected browser errors or warnings");
  console.log(`PASS page identity, rendered content, console health, desktop/mobile screenshots; evidence: ${evidenceDir}`);
} catch (error) {
  await page.screenshot({ path: `${evidenceDir}/failure.png` });
  console.error({ errors, failedRequests, requests });
  throw error;
} finally {
  await browser.close();
}
