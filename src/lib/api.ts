import { getBrowserClient } from "./supabase-browser";
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const client = getBrowserClient();
  const { data, error } = await client.auth.getSession();
  if (error || !data.session)
    throw new Error("Your session has expired. Please sign in again.");
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
      Authorization: `Bearer ${data.session.access_token}`,
    },
    cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401) await client.auth.signOut({ scope: "local" });
    throw new Error(body.error ?? "Something went wrong. Please try again.");
  }
  return body as T;
}
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
