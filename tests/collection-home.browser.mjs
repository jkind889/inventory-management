// Local-only visual and interaction checks. Fixtures never reach an account.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
const playwright = await import(
  process.env.PLAYWRIGHT_MODULE_PATH || "playwright"
);
const { chromium } = playwright.default ?? playwright;
const baseUrl = process.env.UI_TEST_BASE_URL || "http://localhost:3000";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname));
const evidence =
  process.env.UI_TEST_EVIDENCE_DIR || "/tmp/inventory-collection-home";
await mkdir(evidence, { recursive: true });
const userId = "a336ce88-ed8a-4e4b-8fa8-1f923c88ef25";
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(
  ".",
)[0];
const user = {
  id: userId,
  aud: "authenticated",
  role: "authenticated",
  email: "ui-fixture@example.com",
  app_metadata: {},
  user_metadata: {},
  created_at: new Date().toISOString(),
};
const now = Math.floor(Date.now() / 1000);
const token = [
  "e30",
  Buffer.from(
    JSON.stringify({
      sub: userId,
      exp: now + 3600,
      iat: now,
      aud: "authenticated",
    }),
  ).toString("base64url"),
  "fixture",
].join(".");
const session = {
  access_token: token,
  refresh_token: "fixture",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: now + 3600,
  user,
};
const names = ["Tech", "Clothes", "Hobbies", "Furniture", "Groceries", "Other", "Subscriptions"];
const categories = names.map((name, i) => ({
  id: `b336ce88-ed8a-4e4b-8fa8-${String(i).padStart(12, "0")}`,
  userId,
  name,
  archivedAt: null,
}));
const profile = { userId, currency: "USD", timezone: "America/New_York" };
const examples = [
  ["Everyday headphones", 19900, 7],
  ["Mechanical keyboard", 12000, 5],
  ["Navy jacket", 8500, 7],
  ["Cotton tee", 2400, 3],
  ["Sketchbook", 1800, 7],
  ["Watercolors", 3200, 4],
  ["Desk lamp", 4500, 7],
];
const owned = examples.map(([name, amount, day], i) => ({
  id: `c336ce88-ed8a-4e4b-8fa8-${String(i).padStart(12, "0")}`,
  userId,
  categoryId: categories[Math.floor(i / 2)].id,
  name,
  state: "owned",
  acquiredOn: `2026-10-${String(day).padStart(2, "0")}`,
  purchasedOn: `2026-10-${String(day).padStart(2, "0")}`,
  recordedCostMinor: String(amount),
  description: i === 0 ? "Everyday headphones for work and travel." : null,
  targetAmountMinor: null,
  productUrl: null,
  priority: null,
}));
const overview = {
  data: categories.map((category) => ({
    category,
    total: owned.filter((item) => item.categoryId === category.id).length,
    latest: owned.filter((item) => item.categoryId === category.id),
  })),
};
const wants = [];
const receipts = new Map();
const submitted = [];
const reviews = [];
const reviewReceipts = new Map();
const reviewSubmissions = [];
let loseReviewResponse = true;
let loseResponse = true;
let overviewFailure = false;
let failDetailId = null;
let holdDetailId = null;
let heldDetailRoute = null;
let wantsFailure = false;
const errors = [];
const browser = await chromium.launch({
  headless: true,
  channel: process.env.UI_TEST_BROWSER_CHANNEL || "chrome",
});
const context = await browser.newContext({
  viewport: { width: 1536, height: 1024 },
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (
    ["error", "warning"].includes(m.type()) &&
    !/Failed to load resource.*500/.test(m.text())
  )
    errors.push(m.text());
});
await context.addInitScript(
  ({ project, session }) =>
    localStorage.setItem(`sb-${project}-auth-token`, JSON.stringify(session)),
  { project, session },
);
await context.route("**/auth/v1/**", (route) =>
  route.fulfill({ json: { user } }),
);
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (url.pathname === "/api/subscriptions") return route.fulfill({ json: { data: [], today: "2026-10-11", attentionCount: 0, preferences: { enabled: false, revision: 0, blocked: false, emailAvailable: false, emailReason: "Email testing is not enabled for this fixture." } } });
  if (url.pathname.startsWith("/api/subscriptions/items/")) return route.fulfill({ json: { subscription: null } });
  if (path === "/api/profile/bootstrap")
    return route.fulfill({ json: { profile } });
  if (path === "/api/tags") return route.fulfill({ json: { data: [], total: 0, limit: 20, offset: 0 } });
  if (path === "/api/categories")
    return route.fulfill({ json: { data: categories } });
  if (path === "/api/collections/overview")
    return route.fulfill(
      overviewFailure
        ? { status: 500, json: { error: "Fixture overview failure" } }
        : { json: overview },
    );
  if (path === "/api/collection") {
    const filtered = owned.filter(
      (item) =>
        (!url.searchParams.get("categoryId") ||
          item.categoryId === url.searchParams.get("categoryId")) &&
        item.name
          .toLowerCase()
          .includes((url.searchParams.get("q") || "").toLowerCase()),
    );
    return route.fulfill({
      json: { data: filtered, total: filtered.length, limit: 12, offset: 0 },
    });
  }
  if (path === "/api/wants" && request.method() === "POST") {
    const input = request.postDataJSON();
    const key = request.headers()["idempotency-key"];
    assert.match(key, /^[a-f0-9-]{36}$/);
    submitted.push({ key, input });
    let result = receipts.get(key);
    if (!result) {
      const item = {
        ...input,
        id: `d336ce88-ed8a-4e4b-8fa8-${String(wants.length).padStart(12, "0")}`,
        userId,
        state: "wishlist",
        acquiredOn: null,
      };
      wants.push(item);
      result = { item, replayed: false };
      receipts.set(key, result);
    } else assert.deepEqual(input, submitted[0].input);
    if (loseResponse) {
      loseResponse = false;
      return route.fulfill({
        status: 500,
        json: { error: "Saved, but fixture response was lost. Try again." },
      });
    }
    return route.fulfill({ json: { ...result, replayed: true } });
  }
  if (path === "/api/wants") {
    if (wantsFailure) return route.fulfill({ status: 500, json: { error: "Fixture wishlist failure" } });
    const offset = Number(url.searchParams.get("offset") || 0);
    const matches = wants.filter(item => (!url.searchParams.get("categoryId") || item.categoryId === url.searchParams.get("categoryId")) && item.name.toLowerCase().includes((url.searchParams.get("q") || "").toLowerCase()));
    const sort = url.searchParams.get("sort");
    if (sort === "name") matches.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "newest") matches.reverse();
    else matches.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2));
    return route.fulfill({
      json: {
        data: matches.slice(offset, offset + 12),
        total: matches.length,
        limit: 12,
        offset,
      },
    });
  }
  if (path.endsWith("/reviews") && request.method() === "POST") {
    const itemId = path.split("/").at(-2);
    const body = request.postDataJSON();
    const key = request.headers()["idempotency-key"];
    assert.ok(key);
    reviewSubmissions.push({ key, body, itemId });
    if (reviewReceipts.has(key)) return route.fulfill({ json: { review: reviewReceipts.get(key), replayed: true } });
    const review = { id: `review-${reviews.length}`, userId, itemId, ...body, createdAt: new Date().toISOString() };
    reviews.unshift(review);
    reviewReceipts.set(key, review);
    if (loseReviewResponse) {
      loseReviewResponse = false;
      return route.fulfill({ status: 500, json: { error: "Review saved, but fixture response was lost. Try again." } });
    }
    return route.fulfill({ status: 201, json: { review, replayed: false } });
  }
  if (path.startsWith("/api/items/")) {
    const id = path.split("/").at(-1);
    const item = [...owned, ...wants].find((item) => item.id === id);
    assert.ok(item);
    if (id === holdDetailId) { heldDetailRoute = route; return; }
    if (id === failDetailId) return route.fulfill({ status: 500, json: { error: "Fixture item failure" } });
    return route.fulfill({
      json: {
        item,
        reviews: reviews.filter(review => review.itemId === id),
        transactions:
          item.state === "wishlist"
            ? []
            : [
                {
                  id: "receipt",
                  amountMinor: Number(item.recordedCostMinor),
                  currency: "USD",
                  occurredOn: item.purchasedOn,
                  merchant: "Local electronics store",
                  note: "Kept the receipt for warranty.",
                },
              ],
      },
    });
  }
  if (path === "/api/spending/summary")
    return route.fulfill({
      json: {
        currency: "USD",
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
        grossSpendingMinor: "52300",
        breakdown: [
          {
            categoryId: categories[0].id,
            categoryName: "Tech",
            amountMinor: "31900",
          },
          {
            categoryId: categories[1].id,
            categoryName: "Clothes",
            amountMinor: "10900",
          },
          {
            categoryId: categories[2].id,
            categoryName: "Hobbies",
            amountMinor: "5000",
          },
          {
            categoryId: categories[3].id,
            categoryName: "Furniture",
            amountMinor: "4500",
          },
        ],
      },
    });
  if (path === "/api/transactions")
    return route.fulfill({
      json: {
        data: owned.map((item) => ({
          id: item.id,
          itemId: item.id,
          categoryId: item.categoryId,
          itemName: item.name,
          categoryName: categories.find((c) => c.id === item.categoryId).name,
          amountMinor: Number(item.recordedCostMinor),
          currency: "USD",
          occurredOn: item.purchasedOn,
          itemArchivedAt: null,
        })),
        total: owned.length,
        limit: 10,
        offset: 0,
      },
    });
  throw new Error(`Unexpected fixture request ${path}`);
});
const nav = page.getByRole("navigation", { name: "Main navigation" });
async function noOverflow() {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "Horizontal page overflow",
  );
}
try {
  await page.goto(baseUrl);
  const tree = page.getByRole("navigation", { name: "Collection navigation" });
  const list = page.getByRole("list", { name: "Collection items" });
  const inspector = page.getByRole("region", { name: "Item details" });
  await list.getByRole("heading", { name: "Everyday headphones", exact: true }).waitFor();
  assert.equal(await page.title(), "Inventory");
  assert.equal(await tree.getByRole("button").count(), 7);
  await tree.getByRole("button", { name: /Subscriptions/ }).waitFor();
  assert.equal(await tree.getByRole("button", { name: /Groceries/ }).count(), 0);
  assert.equal(await nav.getByRole("button", { name: "Collections", exact: true }).getAttribute("aria-current"), "page");
  await noOverflow();
  await list.getByRole("button", { name: /Everyday headphones/ }).click();
  await inspector.getByRole("heading", { name: "Everyday headphones", exact: true }).waitFor();
  assert.equal(await list.getByRole("button", { name: /Everyday headphones/ }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("dialog").count(), 0, "Collection details must render inline");
  await inspector.getByText("$199.00", { exact: true }).waitFor();
  await inspector.getByText("Local electronics store", { exact: true }).waitFor();
  await inspector.getByText("Kept the receipt for warranty.", { exact: true }).waitFor();
  const worth = inspector.getByRole("region", { name: "Worth it?" });
  await worth.getByRole("button", { name: "Review this item" }).click();
  await worth.getByRole("combobox", { name: /^Verdict/ }).selectOption("worth_it");
  await worth.getByLabel("How often do you use it?").selectOption("daily");
  await worth.getByLabel("Would you buy it again?").selectOption("yes");
  await worth.getByLabel("Why?", { exact: false }).fill("Useful for work and travel.");
  await worth.getByRole("button", { name: "Save check-in" }).click();
  await worth.getByRole("alert").getByText("Review saved, but fixture response was lost. Try again.").waitFor();
  await worth.getByRole("button", { name: "Save check-in" }).click();
  await worth.getByText("Check-in saved.", { exact: true }).waitFor();
  assert.equal(reviews.length, 1);
  assert.equal(reviewSubmissions[0].key, reviewSubmissions[1].key);
  await worth.getByText("Worth it", { exact: true }).waitFor();
  await worth.getByRole("button", { name: "Add check-in" }).click();
  await worth.getByRole("combobox", { name: /^Verdict/ }).selectOption("not_worth_it");
  await worth.getByLabel("How often do you use it?").selectOption("rarely");
  await worth.getByLabel("Would you buy it again?").selectOption("no");
  await worth.getByLabel("Why?", { exact: false }).fill("I use them less now.");
  await worth.getByRole("button", { name: "Save check-in" }).click();
  await worth.getByText("Not worth it", { exact: true }).waitFor();
  assert.equal(reviews.length, 2);
  assert.notEqual(reviewSubmissions[2].key, reviewSubmissions[1].key);
  await worth.getByText("Earlier check-ins (1)", { exact: true }).click();
  await worth.getByText("Useful for work and travel.", { exact: true }).waitFor();
  await noOverflow();
  await page.locator(".inspector-scroll").evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: `${evidence}/collections-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await worth.getByRole("button", { name: "Add check-in" }).click();
  await worth.getByRole("button", { name: "Save check-in" }).scrollIntoViewIfNeeded();
  await noOverflow();
  await page.screenshot({ path: `${evidence}/review-mobile.png`, fullPage: true });
  await worth.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 1536, height: 1024 });
  // A failed item request stays inside the inspector and can be retried.
  failDetailId = owned[1].id;
  await list.getByRole("button", { name: /Mechanical keyboard/ }).click();
  await inspector.getByRole("alert").getByText("Fixture item failure").waitFor();
  failDetailId = null;
  await inspector.getByRole("button", { name: "Try again" }).click();
  await inspector.getByRole("heading", { name: "Mechanical keyboard", exact: true }).waitFor();
  // Switching rows while an item is loading must not display its late response.
  holdDetailId = owned[0].id;
  await list.getByRole("button", { name: /Everyday headphones/ }).click();
  await page.waitForFunction(() => document.querySelector(".inspector-scroll")?.textContent?.includes("Loading item"));
  const detailDeadline = Date.now() + 5000;
  while (!heldDetailRoute) {
    assert.ok(Date.now() < detailDeadline, "Held detail request did not start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await list.getByRole("button", { name: /Navy jacket/ }).click();
  await inspector.getByRole("heading", { name: "Navy jacket", exact: true }).waitFor();
  await heldDetailRoute.fulfill({ json: { item: owned[0], transactions: [], reviews: [] } }).catch(() => {});
  holdDetailId = null;
  assert.equal(await inspector.getByRole("heading", { name: "Everyday headphones", exact: true }).count(), 0);
  await list.getByRole("button", { name: /Mechanical keyboard/ }).click();
  await inspector.getByRole("heading", { name: "Mechanical keyboard", exact: true }).waitFor();
  assert.equal(await inspector.getByRole("heading", { name: "Everyday headphones", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Close item details" }).click();
  await inspector.getByRole("heading", { name: "Select an item" }).waitFor();
  await page.getByRole("textbox", { name: "Filter collections" }).fill("clo");
  assert.equal(await tree.getByRole("button").count(), 2);
  await tree.getByRole("button", { name: /Clothes/ }).click();
  await page.getByRole("textbox", { name: "Filter collections" }).fill("");
  await list.getByRole("heading", { name: "Navy jacket", exact: true }).waitFor();
  assert.equal(await list.getByRole("button").count(), 2);
  await list.getByRole("button", { name: /Navy jacket/ }).click();
  await inspector.getByRole("heading", { name: "Navy jacket", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Search your collection" }).fill("Navy");
  await inspector.getByRole("heading", { name: "Select an item" }).waitFor();
  await page.waitForFunction(() => document.querySelector(".collection-count")?.textContent === "1 item");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  assert.equal(await page.locator("select[name=category]").inputValue(), categories[1].id);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await tree.getByRole("button", { name: /Subscriptions/ }).click();
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  assert.equal(await page.locator("select[name=category]").inputValue(), categories[6].id);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await tree.getByRole("button", { name: /Other/ }).click();
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  assert.equal(await page.locator("select[name=category]").inputValue(), categories[5].id);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await nav.getByRole("button", { name: "Spending", exact: true }).click();
  await page.getByText("$523.00", { exact: true }).waitFor();
  await page.screenshot({ path: `${evidence}/spending-desktop.png` });
  await page
    .getByRole("button", { name: "Previous month", exact: true })
    .click();
  await page.getByText("$523.00", { exact: true }).waitFor();
  await nav.getByRole("button", { name: "Future Wants", exact: true }).click();
  await page
    .getByRole("heading", { name: "A little room for possibility." })
    .waitFor();
  await page.getByRole("button", { name: "Add want", exact: true }).click();
  await page.getByLabel("Item name", { exact: true }).fill("Future headphones");
  await page.getByLabel("Estimated price (USD)").fill("150.00");
  await page.locator("select[name=priority]").selectOption("1");
  await page
    .getByLabel("Product link (optional)")
    .fill("https://example.com/headphones");
  await page.getByLabel("Notes (optional)").fill("Consider after a month.");
  await page.getByRole("button", { name: "Save want", exact: true }).click();
  await page
    .getByRole("alert")
    .getByText("Saved, but fixture response was lost. Try again.")
    .waitFor();
  await page.getByRole("button", { name: "Save want", exact: true }).click();
  await page
    .getByRole("heading", { name: "Future headphones", exact: true })
    .waitFor();
  assert.equal(wants.length, 1);
  assert.equal(submitted[0].key, submitted[1].key);
  await page.getByRole("button", { name: /Future headphones/ }).click();
  await page
    .getByRole("region", { name: "Item details" })
    .getByText("$150.00 estimated", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: "View product" }).getAttribute("href"),
    "https://example.com/headphones",
  );
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("region", { name: "Item details" }).getByText("Consider after a month.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: "Worth it?" }).count(), 0);
  await page.screenshot({ path: `${evidence}/wants-desktop.png` });
  await page.getByRole("button", { name: "Close item details" }).click();
  await page.reload();
  await nav.getByRole("button", { name: "Future Wants", exact: true }).click();
  await page
    .getByRole("heading", { name: "Future headphones", exact: true })
    .waitFor();
  for (let index = 1; index <= 12; index++)
    wants.push({
      ...wants[0],
      id: `wishlist-page-${index}`,
      name: `Candidate ${index}`,
      categoryId: index === 12 ? categories[3].id : categories[0].id,
      priority: index === 12 ? 3 : 1,
      targetAmountMinor: index === 12 ? null : 15000,
    });
  await nav.getByRole("button", { name: "Collections", exact: true }).click();
  await nav.getByRole("button", { name: "Future Wants", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page
    .getByRole("heading", { name: "Candidate 12", exact: true })
    .waitFor();
  assert.equal(await page.locator(".wants-register-row").count(), 1);
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page
    .getByRole("heading", { name: "Future headphones", exact: true })
    .waitFor();
  assert.equal(await page.locator(".wants-register-row").count(), 12);
  const wantsList = page.getByRole("list", { name: "Future wants" });
  const wantsInspector = page.getByRole("region", { name: "Item details" });
  await tree.getByRole("button", { name: /Furniture/ }).click();
  await wantsList.getByRole("heading", { name: "Candidate 12", exact: true }).waitFor();
  assert.equal(await wantsList.getByRole("button").count(), 1);
  await wantsList.getByRole("button", { name: /Candidate 12/ }).click();
  await wantsInspector.getByText("Price not estimated", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Add want", exact: true }).click();
  assert.equal(await page.locator("select[name=category]").inputValue(), categories[3].id);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await tree.getByRole("button", { name: /All wants/ }).click();
  await page.getByRole("textbox", { name: "Search future wants" }).fill("candidate 12");
  await page.waitForFunction(() => document.querySelector(".collection-count")?.textContent === "1 want");
  await wantsList.getByRole("heading", { name: "Candidate 12", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Search future wants" }).fill("");
  await page.getByRole("combobox", { name: "Sort future wants" }).selectOption("name");
  await page.waitForFunction(() => document.querySelector(".collection-count")?.textContent === "13 wants");
  await wantsList.getByRole("heading", { name: "Candidate 1", exact: true }).waitFor();
  assert.equal(await wantsList.locator(".register-name").first().textContent(), "Candidate 1");
  await page.getByRole("combobox", { name: "Sort future wants" }).selectOption("priority");
  await wantsList.getByRole("heading", { name: "Future headphones", exact: true }).waitFor();
  await wantsList.getByRole("button", { name: /Future headphones/ }).click();
  await wantsInspector.getByRole("heading", { name: "Future headphones", exact: true }).waitFor();
  await noOverflow();
  await page.screenshot({ path: `${evidence}/wants-desktop.png` });
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator(".space-header").count(), 1);
  await noOverflow();
  await page.screenshot({ path: `${evidence}/wants-tablet.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("combobox", { name: "Filter category" }).selectOption(categories[3].id);
  await wantsList.getByRole("heading", { name: "Candidate 12", exact: true }).waitFor();
  await wantsList.getByRole("button", { name: /Candidate 12/ }).click();
  await wantsInspector.getByText("Price not estimated", { exact: true }).waitFor();
  await noOverflow();
  await page.screenshot({ path: `${evidence}/wants-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1536, height: 1024 });
  await tree.getByRole("button", { name: /All wants/ }).click();
  await page.getByRole("textbox", { name: "Search future wants" }).fill("no such want");
  await page.getByRole("heading", { name: "No future wants found." }).waitFor();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await wantsList.getByRole("heading", { name: "Future headphones", exact: true }).waitFor();
  wantsFailure = true;
  await page.getByRole("combobox", { name: "Sort future wants" }).selectOption("newest");
  await page.getByRole("alert").getByText("Fixture wishlist failure").waitFor();
  wantsFailure = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await wantsList.getByRole("heading", { name: "Candidate 12", exact: true }).waitFor();
  wants.splice(1);
  await nav.getByRole("button", { name: "Spending", exact: true }).click();
  await page.getByText("$523.00", { exact: true }).waitFor();
  overviewFailure = true;
  await nav.getByRole("button", { name: "Collections", exact: true }).click();
  await page.getByRole("textbox", { name: "Search your collection" }).fill("");
  await tree.getByRole("button", { name: /All items/ }).click();
  await list.getByRole("heading", { name: "Everyday headphones", exact: true }).waitFor();
  overviewFailure = false;
  // Unavailable optional sidebar counts must not block the item workspace.
  await page.setViewportSize({ width: 900, height: 1000 });
  await noOverflow();
  await page.screenshot({ path: `${evidence}/collections-tablet.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileCategory = page.getByRole("combobox", { name: "Filter category" });
  await mobileCategory.selectOption(categories[0].id);
  await page.waitForFunction(() => document.querySelector(".collection-count")?.textContent === "2 items");
  await list.getByRole("button", { name: /Everyday headphones/ }).click();
  await inspector.getByRole("heading", { name: "Everyday headphones", exact: true }).waitFor();
  assert.equal(await mobileCategory.locator("option", { hasText: "Groceries" }).count(), 0);
  await noOverflow();
  await page.screenshot({ path: `${evidence}/collections-mobile.png`, fullPage: true });
  await nav.getByRole("button", { name: "Future Wants", exact: true }).click();
  await page
    .getByRole("heading", { name: "Future headphones", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Add want", exact: true }).click();
  await noOverflow();
  await page.screenshot({ path: `${evidence}/want-form-mobile.png` });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await nav.getByRole("button", { name: "Spending", exact: true }).click();
  await page.getByText("$523.00", { exact: true }).waitFor();
  await noOverflow();
  await page.screenshot({
    path: `${evidence}/spending-mobile.png`,
    fullPage: true,
  });
  assert.equal(
    await page
      .locator("nextjs-portal")
      .getByText("Runtime Error", { exact: false })
      .count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS subscription category selectors, review save/history/lost-response retry, mobile review form, wishlist exclusion, workbench selection and inline details, sidebar and mobile filtering, search, category-aware add, Spending, saved wants/reload, retry key reuse, optional-count failure, 1536/900/390px layout; screenshots: ${evidence}`,
  );
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true });
  console.error({ errors });
  throw error;
} finally {
  await browser.close();
}
