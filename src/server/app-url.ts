import "server-only";

/** Canonical origin for links that leave the current browser session. */
export function getAppUrl(): string {
  try {
    const url = new URL(process.env.APP_URL ?? "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash
    ) throw new Error();
    return url.origin;
  } catch {
    throw new Error("APP_URL must be an HTTP(S) origin without credentials, a path, query, or fragment.");
  }
}
