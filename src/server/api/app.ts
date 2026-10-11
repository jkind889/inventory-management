import { itemTagsInput } from "../../shared/tags";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z, ZodError } from "zod";
import { tagsListInput, bootstrapInput, collectionInput, existingItemInput, wantInput, wantsListInput, paginationInput, purchaseInput, spendingInput, transactionListInput } from "../../shared/contracts";
import type { InventoryService } from "../services/inventory";
import { itemReviewInput } from "../../shared/contracts";

import { photoUploadInput, photoRemoveInput, photoImportInput } from "../../shared/photos";
import type { PhotoService } from "../services/photos";

type Dependencies = { verifyToken: (token: string) => Promise<string | null>; service: () => InventoryService; photos?: (token: string) => PhotoService };
export function createApi(deps: Dependencies) {
  const app = new Hono<{ Variables: { userId: string; token: string } }>().basePath("/api");
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
    c.set("token", bearer.slice(7));
    await next();
  });
  app.post("/profile/bootstrap", async c => {
    const input = bootstrapInput.parse(await c.req.json());
    return c.json(await deps.service().bootstrap(c.get("userId"), input));
  });
  app.get("/categories", async c => c.json({ data: await deps.service().categories(c.get("userId")) }));
  app.get("/collections/overview", async c => {
    const overview = await deps.service().collectionOverview(c.get("userId"));
    const photos = deps.photos?.(c.get("token"));
    const covers = await photos?.covers(c.get("userId"), overview.data.flatMap(entry => entry.latest.map(item => item.id)));
    return c.json({ data: overview.data.map(entry => ({ ...entry, latest: entry.latest.map(item => ({ ...item, cover: covers?.get(item.id) ?? null })) })) });
  });
  app.get("/wants", async c => {
    const input = wantsListInput.parse({ ...c.req.query(), tagId: c.req.queries("tagId") });
    return c.json(await deps.service().wants(c.get("userId"), input));
  });
  app.post("/wants", async c => {
    const key = z.uuid().parse(c.req.header("Idempotency-Key"));
    const input = wantInput.parse(await c.req.json());
    const result = await deps.service().addWant(c.get("userId"), key, input);
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.get("/collection", async c => c.json(await deps.service().collection(c.get("userId"), collectionInput.parse({ ...c.req.query(), tagId: c.req.queries("tagId") }))));
  app.get("/tags", async c => c.json(await deps.service().tags(c.get("userId"), tagsListInput.parse(c.req.query()))));
  app.put("/items/:id/tags", async c => {
    const id = z.uuid().parse(c.req.param("id"));
    const key = z.uuid().parse(c.req.header("Idempotency-Key"));
    const input = itemTagsInput.parse(await c.req.json());
    return c.json(await deps.service().setItemTags(c.get("userId"), id, key, input.tags));
  });
  app.get("/items/:id", async c => {
    const id = z.uuid().parse(c.req.param("id"));
    const detail = await deps.service().itemDetail(c.get("userId"), id);
    const photos = deps.photos?.(c.get("token"));
    await photos?.cleanup(c.get("userId"));
    const [covers, pendingPhoto] = await Promise.all([photos?.covers(c.get("userId"), [id]), photos?.pending(c.get("userId"), id)]);
    return c.json({ ...detail, cover: covers?.get(id) ?? null, pendingPhoto: pendingPhoto ?? null });
  });
  app.post("/items/:id/photo/uploads", async c => {
    const id = z.uuid().parse(c.req.param("id"));
    const key = z.uuid().parse(c.req.header("Idempotency-Key"));
    const input = photoUploadInput.parse(await c.req.json());
    if (!deps.photos) throw new HTTPException(503, { message: "Photos are unavailable." });
    const result = await deps.photos(c.get("token")).reserve(c.get("userId"), id, key, input);
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.post("/items/:id/photo/imports", async c => {
    const id = z.uuid().parse(c.req.param("id"));
    const key = z.uuid().parse(c.req.header("Idempotency-Key"));
    const input = photoImportInput.parse(await c.req.json());
    if (!deps.photos) throw new HTTPException(503, { message: "Photos are unavailable." });
    const result = await deps.photos(c.get("token")).importFromUrl(c.get("userId"), id, key, input);
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.post("/items/:id/photo/uploads/:uploadId/complete", async c => {
    const id = z.uuid().parse(c.req.param("id"));
    const uploadId = z.uuid().parse(c.req.param("uploadId"));
    const key = z.uuid().parse(c.req.header("Idempotency-Key"));
    z.object({}).strict().parse(await c.req.json());
    if (!deps.photos) throw new HTTPException(503, { message: "Photos are unavailable." });
    const result = await deps.photos(c.get("token")).complete(c.get("userId"), id, uploadId, key);
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.delete("/items/:id/photo", async c => {
    const id = z.uuid().parse(c.req.param("id"));
    const key = z.uuid().parse(c.req.header("Idempotency-Key"));
    const input = photoRemoveInput.parse(await c.req.json());
    if (!deps.photos) throw new HTTPException(503, { message: "Photos are unavailable." });
    const result = await deps.photos(c.get("token")).remove(c.get("userId"), id, key, input.expectedCoverId);
    return c.json(result);
  });
  app.post("/items/:id/reviews", async c => {
    const id = z.uuid().parse(c.req.param("id"));
    const key = z.uuid().parse(c.req.header("Idempotency-Key"));
    const input = itemReviewInput.parse(await c.req.json());
    const result = await deps.service().addItemReview(c.get("userId"), id, key, input);
    return c.json(result, result.replayed ? 200 : 201);
  });
  app.get("/items", async c => {
    const { limit, offset } = paginationInput.parse(c.req.query());
    return c.json({ data: await deps.service().items(c.get("userId"), limit, offset), limit, offset });
  });
  app.post("/items", async c => {
    const key = z.uuid().parse(c.req.header("Idempotency-Key"));
    const input = existingItemInput.parse(await c.req.json());
    const result = await deps.service().existingItem(c.get("userId"), key, input);
    return c.json(result, result.replayed ? 200 : 201);
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
