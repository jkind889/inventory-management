import { handle } from "hono/vercel";
import { createApi } from "@/server/api/app";
import { verifyToken } from "@/server/api/auth";
import { getDatabase } from "@/server/db/client";
import { createInventoryService } from "@/server/services/inventory";
import { createPhotoService } from "@/server/services/photos";
import { createPhotoStorage } from "@/server/services/photo-storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const app = createApi({ verifyToken, service: () => createInventoryService(getDatabase()), photos: token => createPhotoService(getDatabase(), createPhotoStorage(token)) });
export const GET = handle(app);
export const POST = handle(app);

export const DELETE = handle(app);
