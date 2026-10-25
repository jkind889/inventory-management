// Real local Auth/API persistence plus category-editor interaction regressions.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { config } from "dotenv";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { chromium, expect } from "@playwright/test";

config({ path: ".env.local", quiet: true });
const base = process.env.UI_TEST_BASE_URL || "http://127.0.0.1:3004";
for (const url of [base, process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.DATABASE_ADMIN_URL]) {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "These tests must stay local.");
}
const evidence = process.env.UI_TEST_EVIDENCE_DIR || "/tmp/inventory-item-category";
await mkdir(evidence, { recursive: true });
const admin = postgres(process.env.DATABASE_ADMIN_URL, { max: 1, onnotice: () => {} });
const auth = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
let browser, userId;
const errors = [], submissions = [];
let failure = null, heldSave = null;
async function request(session, path, method = "GET", body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
try {
  const { data, error } = await auth.auth.signUp({ email: `category-${randomUUID()}@example.com`, password: `aA1!${randomUUID()}` });
  assert.equal(error, null); assert.ok(data.session); userId = data.user.id;
  const session = data.session;
  await request(session, "/profile/bootstrap", "POST", {});
  const categories = (await request(session, "/categories")).data;
  const tech = categories.find(c => c.name === "Tech"), hobbies = categories.find(c => c.name === "Hobbies"), clothes = categories.find(c => c.name === "Clothes");
  const purchase = await request(session, "/purchases", "POST", {
    name: "Category test camera", categoryId: tech.id, amountMinor: 12345, currency: "USD", occurredOn: "2026-10-01", merchant: "Camera shop", note: "Original purchase note", tags: ["Travel", "Keep"],
  });
  const itemId = purchase.item.id;
  await request(session, `/items/${itemId}`, "PATCH", { description: "Keep this item note" });
  const original = await request(session, `/items/${itemId}`);
  browser = await chromium.launch({ headless: true, channel: process.env.UI_TEST_BROWSER_CHANNEL || "chrome" });
  const context = await browser.newContext({ viewport: { width: 1536, height: 1024 } });
  const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  await context.addInitScript(({ project, session }) => localStorage.setItem(`sb-${project}-auth-token`, JSON.stringify(session)), { project, session });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type()) && !/Failed to load resource:.*(?:503|ERR_FAILED)/.test(message.text())) errors.push(message.text());
  });
  await context.route(`**/api/items/${itemId}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    submissions.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    const mode = failure; failure = null;
    if (mode === "hold") return new Promise(resolve => { heldSave = async () => { await route.continue(); resolve(); }; });
    if (mode === "before") return route.fulfill({ status: 503, json: { error: "Temporary category test failure. Please retry." } });
    if (mode === "after") {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      return route.abort("failed");
    }
    return route.continue();
  });
  await page.goto(base);
  assert.equal(new URL(page.url()).origin, new URL(base).origin);
  assert.equal(await page.title(), "Inventory");
  await expect(page.locator(".collection-count")).toHaveText("1 item");
  await page.locator(".collection-register-row").click();
  const editor = page.getByRole("region", { name: "Item category", exact: true });
  const inspect = page.locator(".item-inspector");
  const select = editor.getByLabel("Category", { exact: true });
  const savedCategory = () => editor.locator(":scope > p.muted");
  async function begin(category) {
    await editor.getByRole("button", { name: "Edit category", exact: true }).click();
    await select.selectOption(category.id);
  }
  async function save(category) {
    await editor.getByRole("button", { name: "Save category", exact: true }).click();
    await expect(savedCategory()).toHaveText(category.name);
    await expect(editor.getByRole("status")).toHaveText("Category saved.");
    await expect(inspect.locator(".inspector-meta")).toContainText(category.name);
  }
  async function verifyPreserved(category) {
    const detail = await request(session, `/items/${itemId}`);
    const stableFields = item => Object.fromEntries(Object.entries(item).filter(([key]) => !["categoryId", "updatedAt"].includes(key)));
    assert.equal(detail.item.categoryId, category.id);
    assert.deepEqual(stableFields(detail.item), stableFields(original.item));
    assert.deepEqual(detail.transactions, original.transactions);
    assert.deepEqual(detail.reviews, original.reviews);
    assert.equal((await request(session, "/spending/summary?from=2026-10-01&to=2026-10-31")).grossSpendingMinor, "12345");
    assert.equal((await request(session, "/collection")).total, 1);
  }

  // Cancel makes no update request, and reopening starts from the saved category.
  await expect(savedCategory()).toHaveText("Tech");
  await begin(hobbies);
  await editor.getByRole("button", { name: "Cancel category" }).click();
  assert.equal(submissions.length, 0);
  await expect(savedCategory()).toHaveText("Tech");
  await editor.getByRole("button", { name: "Edit category", exact: true }).click();
  await expect(select).toHaveValue(tech.id);
  await select.selectOption(hobbies.id);
  await page.screenshot({ path: `${evidence}/desktop-editor.png` });
  failure = "hold";
  await editor.getByRole("button", { name: "Save category", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Saving category…", exact: true })).toBeDisabled();
  await expect(editor.getByRole("button", { name: "Cancel category" })).toBeDisabled();
  await expect(select).toBeDisabled();
  await expect.poll(() => heldSave !== null).toBe(true);
  await heldSave(); heldSave = null;
  await expect(savedCategory()).toHaveText("Hobbies");
  await expect(editor.getByRole("status")).toHaveText("Category saved.");
  await expect(page.locator(".register-category")).toHaveText("Hobbies");
  assert.deepEqual(submissions[0].body, { categoryId: hobbies.id });
  await verifyPreserved(hobbies);
  await page.reload();
  await expect(page.locator(".register-category")).toHaveText("Hobbies");
  await page.locator(".collection-register-row").click();
  await expect(savedCategory()).toHaveText("Hobbies");

  // A failed request keeps the saved UI and draft separate, then retries the same key.
  await begin(clothes); failure = "before";
  await editor.getByRole("button", { name: "Save category", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("Temporary category test failure");
  await expect(select).toHaveValue(clothes.id);
  await expect(inspect.locator(".inspector-meta")).toContainText("Hobbies");
  await expect(page.locator(".register-category")).toHaveText("Hobbies");
  assert.equal((await request(session, `/items/${itemId}`)).item.categoryId, hobbies.id);
  await page.screenshot({ path: `${evidence}/failed-save.png` });
  await save(clothes);
  assert.equal(submissions[1].key, submissions[2].key);
  assert.notEqual(submissions[0].key, submissions[1].key);
  await verifyPreserved(clothes);

  // Lost response after commit also retains the intended submission for replay.
  await begin(tech); failure = "after";
  await editor.getByRole("button", { name: "Save category", exact: true }).click();
  await expect(editor.getByRole("alert")).toBeVisible();
  await expect(select).toHaveValue(tech.id);
  assert.equal((await request(session, `/items/${itemId}`)).item.categoryId, tech.id);
  await save(tech);
  assert.equal(submissions[3].key, submissions[4].key);
  assert.notEqual(submissions[2].key, submissions[3].key);
  await verifyPreserved(tech);

  // Replacing a category moves the item out of an active category filter and updates counts.
  const navigation = page.getByRole("navigation", { name: "Collection navigation" });
  await navigation.getByRole("button", { name: /^Tech/ }).click();
  await expect(page.locator(".collection-count")).toHaveText("1 item");
  await page.locator(".collection-register-row").click();
  await begin(hobbies); await save(hobbies);
  await expect(page.locator(".collection-count")).toHaveText("0 items");
  await expect(navigation.getByRole("button", { name: /^Tech/ }).locator(".tree-count")).toHaveText("0");
  await expect(navigation.getByRole("button", { name: /^Hobbies/ }).locator(".tree-count")).toHaveText("1");
  await navigation.getByRole("button", { name: /^Hobbies/ }).click();
  await expect(page.locator(".collection-count")).toHaveText("1 item");
  await page.locator(".collection-register-row").click();
  await expect(savedCategory()).toHaveText("Hobbies");
  await verifyPreserved(hobbies);

  // The full editor gets the latest category; category-only save there preserves other data.
  await page.getByRole("button", { name: "Edit item", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Category", { exact: true })).toHaveValue(hobbies.id);
  await dialog.getByLabel("Category", { exact: true }).selectOption(clothes.id);
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".register-category")).toHaveText("Clothes");
  await verifyPreserved(clothes);
  await page.locator(".collection-register-row").click();
  await expect(savedCategory()).toHaveText("Clothes");
  await page.screenshot({ path: `${evidence}/desktop-saved.png` });

  // Mobile controls remain usable without horizontal overflow and persist after reload.
  await page.setViewportSize({ width: 390, height: 844 });
  await begin(tech);
  await editor.scrollIntoViewIfNeeded();
  await expect(editor.getByRole("button", { name: "Save category", exact: true })).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${evidence}/mobile-editor.png` });
  await save(tech);
  await verifyPreserved(tech);
  await page.reload();
  await expect(page.locator(".register-category")).toHaveText("Tech");
  await page.locator(".collection-register-row").click();
  await expect(savedCategory()).toHaveText("Tech");
  await editor.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/mobile-saved.png` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await expect(page.locator("nextjs-error-overlay")).toHaveCount(0);
  assert.deepEqual(errors, []);
  for (const submission of submissions) assert.match(submission.key, /^[0-9a-f-]{36}$/i);
  console.log(JSON.stringify({ passed: true, checks: ["real local Auth/API persistence", "cancel and reopen", "single-category PATCH", "failed save draft and same-key retry", "lost-response replay", "separate edit keys", "category filter and counts", "full editor regression", "unchanged item/tags/purchases/spending", "reload persistence", "1536x1024 desktop", "390x844 mobile", "no unexpected console/page errors"], evidence }));
  await context.close();
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: `${evidence}/failure.png` });
  throw error;
} finally {
  if (browser) await browser.close();
  if (userId) await admin`delete from auth.users where id=${userId}`;
  await admin.end();
}
