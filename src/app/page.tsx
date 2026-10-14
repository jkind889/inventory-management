import { AppEntry } from "@/features/auth/app-entry";
import { connection } from "next/server";
import { getAppUrl } from "@/server/app-url";

export default async function Home() {
  // Read the canonical origin at runtime, including after a host/env change.
  await connection();
  return <AppEntry appUrl={getAppUrl()} />;
}
