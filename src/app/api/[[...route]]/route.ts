import { handle } from "hono/vercel";
import { createApi } from "@/server/api/app";
import { verifyToken } from "@/server/api/auth";
import { getDatabase } from "@/server/db/client";
import { createInventoryService } from "@/server/services/inventory";
import { createPhotoService } from "@/server/services/photos";
import { createPhotoStorage } from "@/server/services/photo-storage";
import { createSubscriptionService } from "@/server/services/subscriptions";
import { createReminderEmailService } from "@/server/services/reminder-email";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const app = createApi({ verifyToken, service: () => createInventoryService(getDatabase()), photos: token => createPhotoService(getDatabase(), createPhotoStorage(token)),
  subscriptions: () => createSubscriptionService(getDatabase()), reminderEmail: () => createReminderEmailService(getDatabase()) });
export const GET = handle(app);
export const POST = handle(app);

export const DELETE = handle(app);
export const PATCH = handle(app);
export const PUT = handle(app);
