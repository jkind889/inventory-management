import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z, ZodError } from "zod";
import { bootstrapInput, collectionInput, existingItemInput, paginationInput, purchaseInput, spendingInput, transactionListInput } from "../../shared/contracts";
import type { InventoryService } from "../services/inventory";

type Dependencies = { verifyToken: (token: string) => Promise<string | null>; service: () => InventoryService };
export function createApi(deps: Dependencies) {
  const app = new Hono<{ Variables: { userId: string } }>().basePath("/api");
  app.use("*", secureHeaders());
  app.use("*", bodyLimit({ maxSize: 32 * 1024 }));
  app.get("/health", c => c.json({ status: "ok" }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const bearer = c.req.header("Authorization");
    if (!bearer?.startsWith("Bearer ")) throw new HTTPException(401, { message: "Sign in to continue." });
    const userId = await deps.verifyToken(bearer.slice(7));
    if (!userId || !z.uuid().safeParse(userId).success) throw new HTTPException(401, { message: "Your session is invalid or expired." });
    c.set("userId", userId);
    await next();
  });
  app.post("/profile/bootstrap", async c => {
    const input = bootstrapInput.parse(await c.req.json());
    return c.json(await deps.service().bootstrap(c.get("userId"), input));
  });
  app.get("/categories", async c => c.json({ data: await deps.service().categories(c.get("userId")) }));
  app.get("/collection", async c => c.json(await deps.service().collection(c.get("userId"), collectionInput.parse(c.req.query()))));
  app.get("/items/:id", async c => c.json(await deps.service().itemDetail(c.get("userId"), z.uuid().parse(c.req.param("id")))));
  app.get("/items", async c => {
    const { limit, offset } = paginationInput.parse(c.req.query());
    return c.json({ data: await deps.service().items(c.get("userId"), limit, offset), limit, offset });
  });
  app.post("/items", async c => {
    const input = existingItemInput.parse(await c.req.json());
    return c.json({ item: await deps.service().existingItem(c.get("userId"), input) }, 201);
  });
  app.post("/purchases", async c => {
    const key = z.uuid().parse(c.req.header("Idempotency-Key"));
    const input = purchaseInput.parse(await c.req.json());
    const result = await deps.service().purchase(c.get("userId"), key, input);
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.get("/transactions", async c => {
    const input = transactionListInput.parse(c.req.query());
    return c.json(await deps.service().transactionHistory(c.get("userId"), input));
  });
  app.get("/spending/summary", async c => {
    const { from, to } = spendingInput.parse(c.req.query());
    return c.json(await deps.service().spending(c.get("userId"), from, to));
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof ZodError) return c.json({ error: "Invalid input.", issues: error.issues.map(({ path, message }) => ({ path, message })) }, 400);
    if (error instanceof SyntaxError) return c.json({ error: "Request body must be valid JSON." }, 400);
    // Never return connection strings, SQL, tokens, or financial payloads in errors.
    console.error("API request failed", { name: error.name });
    return c.json({ error: "Unable to complete the request." }, 500);
  });
  return app;
}
