// Real local Auth/API regressions for the collection-tools review fixes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { config } from "dotenv";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { chromium, expect } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

config({ path: ".env.local", quiet: true });
const base = process.env.UI_TEST_BASE_URL || "http://127.0.0.1:3004";
for (const url of [base, process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.DATABASE_ADMIN_URL]) {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "These tests must stay local.");
}
const evidence = process.env.UI_TEST_EVIDENCE_DIR || "/tmp/inventory-collection-review";
await mkdir(evidence, { recursive: true });
const admin = postgres(process.env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => {} });
const auth = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const users = [], errors = [];
let browser;

async function request(session, path, method = "GET", body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result).slice(0,500)}`);
  return result;
}
async function account(currency = "USD", timezone = "UTC") {
  const { data, error } = await auth.auth.signUp({ email: `review-fix-${randomUUID()}@example.com`, password: `aA1!${randomUUID()}` });
  assert.equal(error, null); assert.ok(data.session); users.push(data.user.id);
  await request(data.session, "/profile/bootstrap", "POST", { currency, timezone });
  return data.session;
}
async function openSession(session, viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  await context.addInitScript(({ project, session }) => localStorage.setItem(`sb-${project}-auth-token`, JSON.stringify(session)), { project, session });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type()) && !/Failed to load resource:.*503/.test(message.text())) errors.push(message.text());
  });
  await page.goto(base);
  assert.equal(new URL(page.url()).origin, new URL(base).origin);
  await expect(page).toHaveTitle("Inventory");
  await expect(page.locator(".collection-count")).toHaveText(/\d+ items?/);
  return { context, page };
}
async function screenshot(page, name) {
  await expect(page.locator("nextjs-error-overlay")).toHaveCount(0);
  const firstRow = page.locator(".collection-register-row").first();
  if (await firstRow.count()) {
    await firstRow.scrollIntoViewIfNeeded();
    await expect(firstRow).toBeInViewport();
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No horizontal document overflow");
  await page.screenshot({ path: `${evidence}/${name}.png` });
}

try {
  browser = await chromium.launch({ headless: true, channel: process.env.UI_TEST_BROWSER_CHANNEL || "chrome" });
  for (const [size, viewport] of [["desktop", { width: 1536, height: 1024 }], ["mobile", { width: 390, height: 844 }]]) {
    const session = await account();
    const category = (await request(session, "/categories")).data.find(category => category.name === "Tech");
    const alpha = (await request(session, "/items", "POST", { name: "Alpha untagged", categoryId: category.id })).item;
    const beta = (await request(session, "/items", "POST", { name: "Beta tagged", categoryId: category.id, tags: ["travel"] })).item;
    const { page, context } = await openSession(session, viewport);

    // Tag-filter changes must abandon the previous page's bulk selection.
    await page.getByLabel("Select Alpha untagged", { exact: true }).check();
    await page.getByRole("button", { name: "Tags", exact: true }).click();
    await page.locator(".tag-filter-options").getByLabel("travel", { exact: true }).check();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator(".collection-count")).toHaveText("1 item");
    await expect(page.getByLabel("Select Alpha untagged", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit selected", exact: true })).toBeDisabled();
    await expect(page.locator(".selection-hint")).toHaveCount(0);
    await page.getByLabel("Select Beta tagged", { exact: true }).check();
    const bulkRequest = page.waitForRequest(request => new URL(request.url()).pathname === "/api/collection/bulk" && request.method() === "PATCH");
    await page.getByRole("button", { name: "Edit selected (1)", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Ownership state", { exact: true }).selectOption("donated");
    await dialog.getByRole("button", { name: "Apply changes", exact: true }).click();
    assert.deepEqual((await bulkRequest).postDataJSON().ids, [beta.id]);
    await expect(dialog).toHaveCount(0);
    assert.equal((await request(session, `/items/${alpha.id}`)).item.state, "owned");
    assert.equal((await request(session, `/items/${beta.id}`)).item.state, "donated");
    await page.getByRole("button", { name: "Clear tags", exact: true }).click();
    await expect(page.locator(".collection-count")).toHaveText("1 item");
    await screenshot(page, `${size}-selection-cleared`);

    // Clicking the active entry type must not bypass a still-visible tag draft.
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Item name", { exact: true }).fill("Switch entry test");
    await dialog.getByLabel("Price (USD)", { exact: true }).fill("1.00");
    await dialog.getByLabel("Add a tag", { exact: true }).fill("unfinished");
    await dialog.getByRole("button", { name: "New purchase", exact: true }).click();
    await expect(dialog.getByLabel("Add a tag", { exact: true })).toHaveValue("unfinished");
    await dialog.getByRole("button", { name: "Add item", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Select or create the tag before saving.");

    // A different entry type remounts the picker, so its pending flag must reset.
    await dialog.getByRole("button", { name: "Already owned", exact: true }).click();
    await expect(dialog.getByLabel("Add a tag", { exact: true })).toHaveValue("");
    await dialog.getByLabel("Item name", { exact: true }).fill("Saved after entry switch");
    await dialog.getByRole("button", { name: "Add item", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".collection-count")).toHaveText("2 items");
    const added = (await request(session, "/collection?q=Saved%20after%20entry%20switch")).data;
    assert.equal(added.length, 1); assert.deepEqual(added[0].tags, []);
    assert.deepEqual((await request(session, `/items/${added[0].id}`)).transactions, []);

    // A newly imported category must immediately appear in rows and selectors.
    await page.getByRole("button", { name: "Import", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Choose CSV or ZIP").setInputFiles({ name: "new-category.csv", mimeType: "text/csv", buffer: Buffer.from("name,category\nImported workshop item,Workshop") });
    await dialog.getByRole("button", { name: "Import items", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".collection-count")).toHaveText("3 items");
    await expect(page.locator(".collection-register-row").filter({ hasText: "Imported workshop item" }).locator(".register-category")).toHaveText("Workshop");
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Category", { exact: true }).locator("option", { hasText: "Workshop" })).toHaveCount(1);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await screenshot(page, `${size}-import-category`);
    await context.close();

    // Download a real complete backup, then restore into a loaded USD session.
    const source = await account("EUR", "Europe/Berlin");
    await request(source, "/collection/import", "POST", { rows: [{ name: "Portable subscription", category: "Workshop", acquiredOn: "2026-10-01", amountMinor: 999, currency: "EUR" }], skipDuplicates: true });
    const sourceItem = (await request(source, "/collection")).data[0];
    await request(source, `/items/${sourceItem.id}/tags`, "PUT", { tags: ["preserve-me", "travel"] });
    const schedule = { amountMinor: 999, intervalUnit: "month", billingAnchorOn: "2026-01-31", nextPeriod: 0, reminderDays: 7, serviceUrl: "https://example.com/account", emailEnabled: false };
    const { subscription } = await request(source, "/subscriptions", "POST", { itemId: sourceItem.id, schedule });
    await request(source, `/subscriptions/${subscription.id}/advance`, "POST", { revision: subscription.revision, dueOn: subscription.nextDueOn });
    const sourceSubscription = (await request(source, `/subscriptions/items/${sourceItem.id}`)).subscription;
    const sourceBrowser = await openSession(source, viewport);
    await sourceBrowser.page.getByRole("button", { name: "Export & backup", exact: true }).click();
    const downloadEvent = sourceBrowser.page.waitForEvent("download");
    await sourceBrowser.page.getByRole("dialog").getByRole("button", { name: "Download complete ZIP backup", exact: true }).click();
    const backupPath = `${evidence}/${size}-complete.zip`;
    await (await downloadEvent).saveAs(backupPath);
    const manifest = JSON.parse(strFromU8(unzipSync(new Uint8Array(await readFile(backupPath)))["inventory.json"]));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.subscriptions.length, 1);
    assert.equal(manifest.renewalResolutions.length, 1);
    await sourceBrowser.context.close();

    const target = await account();
    const restored = await openSession(target, viewport);
    let restoreRequests = 0, failCategories = false;
    await restored.context.route("**/api/collection/restore", async route => {
      restoreRequests++;
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      failCategories = true;
      await route.fulfill({ response });
    });
    await restored.context.route("**/api/categories", async route => {
      if (!failCategories) return route.continue();
      failCategories = false;
      await route.fulfill({ status: 503, json: { error: "Account refresh test failure. Try again." } });
    });
    await restored.page.getByRole("button", { name: "Import", exact: true }).click();
    dialog = restored.page.getByRole("dialog");
    await dialog.getByLabel("Choose CSV or ZIP").setInputFiles(backupPath);
    await dialog.getByRole("button", { name: "Restore backup", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(restored.page.locator(".empty-state[role=alert]")).toContainText("Account refresh test failure");
    await expect(restored.page.locator(".collection-register-row")).toHaveCount(0);
    await restored.page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(restored.page.locator(".collection-count")).toHaveText("1 item");
    assert.equal(restoreRequests, 1, "Retrying account refresh must not resubmit the completed restore");
    await expect(restored.page.locator(".register-category")).toHaveText("Workshop");
    await expect(restored.page.locator(".register-price")).toHaveText("€9.99");
    await expect(restored.page.locator(".register-item .tag-chip")).toHaveText(["preserve-me", "travel"]);
    const restoredItem = (await request(target, "/collection")).data[0];
    const restoredSubscription = (await request(target, `/subscriptions/items/${restoredItem.id}`)).subscription;
    for (const field of ["amountMinor", "currency", "intervalUnit", "billingAnchorOn", "nextPeriod", "nextDueOn", "reminderDays", "serviceUrl", "status", "endsOn"]) assert.deepEqual(restoredSubscription[field], sourceSubscription[field], field);
    const restoredManifest = (await request(target, "/collection/export")).backup;
    assert.equal(restoredManifest.renewalResolutions.length, 1);
    assert.equal(restoredManifest.profile.currency, "EUR");
    assert.equal(restoredManifest.profile.timezone, "Europe/Berlin");
    await screenshot(restored.page, `${size}-restored-account`);

    // The next purchase must use the refreshed currency/category without reload.
    await restored.page.getByRole("button", { name: "Add item", exact: true }).click();
    dialog = restored.page.getByRole("dialog");
    await expect(dialog.getByLabel("Price (EUR)", { exact: true })).toBeVisible();
    await dialog.getByLabel("Category", { exact: true }).selectOption({ label: "Workshop" });
    await dialog.getByLabel("Item name", { exact: true }).fill("Purchase after restore");
    await dialog.getByLabel("Price (EUR)", { exact: true }).fill("2.50");
    await dialog.getByRole("button", { name: "Add item", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(restored.page.locator(".collection-count")).toHaveText("2 items");
    const followup = (await request(target, "/collection?q=Purchase%20after%20restore")).data[0];
    const detail = await request(target, `/items/${followup.id}`);
    assert.equal(detail.transactions[0].currency, "EUR");
    assert.equal(detail.transactions[0].amountMinor, 250);
    await restored.page.reload();
    await expect(restored.page.locator(".collection-count")).toHaveText("2 items");
    assert.equal(restoreRequests, 1);
    await restored.context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ["real Auth/API", "tag filter clears hidden bulk selection", "active entry keeps visible tag guard", "entry switch clears pending tag", "CSV category refresh", "v2 ZIP tags/subscription/history roundtrip", "restore currency/category refresh", "failed refresh retries without duplicate restore", "new purchase uses restored currency", "desktop/mobile", "clean console and no horizontal overflow"], evidence }));
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  if (page) await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  if (browser) await browser.close();
  for (const userId of users) await admin`delete from auth.users where id=${userId}`;
  await admin.end();
}
