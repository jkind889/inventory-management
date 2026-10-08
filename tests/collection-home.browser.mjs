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
const names = ["Tech", "Clothes", "Hobbies", "Furniture", "Groceries", "Other"];
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
  description: null,
  targetAmountMinor: null,
  productUrl: null,
  priority: null,
}));
const overview = {
  data: categories.map((category, i) => ({
    category,
    total: [12, 8, 14, 6, 0, 0][i],
    latest: owned.filter((item) => item.categoryId === category.id),
  })),
};
const wants = [];
const receipts = new Map();
const submitted = [];
let loseResponse = true;
let overviewFailure = false;
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
  if (path === "/api/profile/bootstrap")
    return route.fulfill({ json: { profile } });
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
    const offset = Number(url.searchParams.get("offset") || 0);
    return route.fulfill({
      json: {
        data: wants.slice(offset, offset + 12),
        total: wants.length,
        limit: 12,
        offset,
      },
    });
  }
  if (path.startsWith("/api/items/")) {
    const id = path.split("/").at(-1);
    const item = [...owned, ...wants].find((item) => item.id === id);
    assert.ok(item);
    return route.fulfill({
      json: {
        item,
        transactions:
          item.state === "wishlist"
            ? []
            : [
                {
                  id: "receipt",
                  amountMinor: Number(item.recordedCostMinor),
                  currency: "USD",
                  occurredOn: item.purchasedOn,
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
  await page.getByRole("heading", { name: "Tech", exact: true }).waitFor();
  assert.equal(await page.title(), "Inventory");
  assert.equal(await page.locator(".collection-block").count(), 6);
  assert.equal(
    await page
      .getByRole("region", { name: "Tech collection" })
      .locator(".purchase-preview")
      .count(),
    2,
  );
  assert.equal(
    await page
      .getByRole("region", { name: "Furniture collection" })
      .locator(".next-purchase")
      .count(),
    1,
  );
  assert.equal(
    await nav
      .getByRole("button", { name: "Collections", exact: true })
      .getAttribute("aria-current"),
    "page",
  );
  await noOverflow();
  await page.screenshot({ path: `${evidence}/collections-desktop.png` });
  await page
    .getByRole("region", { name: "Tech collection" })
    .getByRole("button", { name: /Everyday headphones/ })
    .click();
  await page
    .getByRole("dialog", { name: "Item details" })
    .getByRole("heading", { name: "Everyday headphones" })
    .waitFor();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("region", { name: "Clothes collection" })
    .getByRole("button", { name: "View collection" })
    .click();
  await page.getByRole("textbox", { name: "Search your collection" }).waitFor();
  await page
    .getByRole("textbox", { name: "Search your collection" })
    .fill("Navy");
  await page
    .getByRole("heading", { name: "Navy jacket", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  assert.equal(
    await page.locator("select[name=category]").inputValue(),
    categories[1].id,
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await nav.getByRole("button", { name: "Collections", exact: true }).click();
  await page.getByRole("heading", { name: "Tech", exact: true }).waitFor();
  await page
    .getByRole("region", { name: "Groceries collection" })
    .getByRole("button", { name: "Add item to Groceries", exact: true })
    .click();
  assert.equal(
    await page.locator("select[name=category]").inputValue(),
    categories[4].id,
  );
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
    .getByRole("dialog", { name: "Item details" })
    .getByText("$150.00 estimated", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: "View product" }).getAttribute("href"),
    "https://example.com/headphones",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.screenshot({ path: `${evidence}/wants-desktop.png` });
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
    });
  await nav.getByRole("button", { name: "Collections", exact: true }).click();
  await nav.getByRole("button", { name: "Future Wants", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page
    .getByRole("heading", { name: "Candidate 12", exact: true })
    .waitFor();
  assert.equal(await page.locator(".wants-grid .item-card").count(), 1);
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page
    .getByRole("heading", { name: "Future headphones", exact: true })
    .waitFor();
  assert.equal(await page.locator(".wants-grid .item-card").count(), 12);
  wants.splice(1);
  await nav.getByRole("button", { name: "Spending", exact: true }).click();
  await page.getByText("$523.00", { exact: true }).waitFor();
  overviewFailure = true;
  await nav.getByRole("button", { name: "Collections", exact: true }).click();
  await page
    .getByRole("heading", { name: "Collections couldn’t load." })
    .waitFor();
  overviewFailure = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("heading", { name: "Tech", exact: true }).waitFor();
  await page.setViewportSize({ width: 900, height: 1000 });
  assert.equal(
    await page
      .locator(".collection-blocks")
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      ),
    2,
  );
  await noOverflow();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page
      .locator(".collection-blocks")
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      ),
    1,
  );
  await noOverflow();
  await page.screenshot({
    path: `${evidence}/collections-mobile.png`,
    fullPage: true,
  });
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
    `PASS collection previews, drill-down/search, category-aware add, Spending, saved wants/reload, retry key reuse, error recovery, 1536/900/390px layout; screenshots: ${evidence}`,
  );
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true });
  console.error({ errors });
  throw error;
} finally {
  await browser.close();
}
