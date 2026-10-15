import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi, afterEach } from "vitest";
import { calendarToday, renewalOn, renewalState, scheduleInput, subscriptionCreateInput } from "../src/shared/subscriptions";
import { parseUnsubscribeToken, renderDigest, sendResendEmail, unsubscribeToken, verifyResendWebhook } from "../src/server/services/reminder-email";
import { createApi } from "../src/server/api/app";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("subscription calendars and contracts", () => {
  it("preserves the original monthly anchor through short months and year boundaries", () => {
    expect([0,1,2,12,13].map(period => renewalOn("2027-01-31", "month", period))).toEqual(["2027-01-31","2027-02-28","2027-03-31","2028-01-31","2028-02-29"]);
    expect(renewalOn("2026-12-30", "month", 2)).toBe("2027-02-28");
  });
  it("recovers February 29 in leap years and rejects calendar overflow", () => {
    expect([1,2,3,4].map(period => renewalOn("2024-02-29", "year", period))).toEqual(["2025-02-28","2026-02-28","2027-02-28","2028-02-29"]);
    expect(() => renewalOn("9999-12-31", "month", 1)).toThrow();
  });
  it("uses profile calendar days across UTC offsets and DST transitions", () => {
    expect(calendarToday("America/New_York", new Date("2026-10-12T02:00:00Z"))).toBe("2026-10-11");
    expect(calendarToday("Pacific/Auckland", new Date("2026-10-11T12:00:00Z"))).toBe("2026-10-12");
    const row = { status: "active" as const, endsOn: null, nextDueOn: "2026-03-09", reminderDays: 1 };
    expect(renewalState(row, "2026-03-08")).toBe("attention");
    expect(renewalState(row, "2026-03-09")).toBe("today");
    expect(renewalState(row, "2026-03-10")).toBe("overdue");
    expect(renewalState({ ...row, reminderDays: 0 }, "2026-03-08")).toBe("upcoming");
    expect(renewalState({ ...row, reminderDays: null }, "2026-03-10")).toBe("off");
    expect(renewalState({ ...row, status: "ending", endsOn: "2026-03-08" }, "2026-03-01")).toBe("stopped");
    expect(renewalState({ ...row, status: "ending", endsOn: "2026-03-09" }, "2026-03-08")).toBe("attention");
  });
  it("requires explicit dates and either an existing item or new item fields", () => {
    const schedule = { amountMinor: 0, intervalUnit: "month", billingAnchorOn: "2026-01-31", nextPeriod: 0, reminderDays: 7, serviceUrl: null, emailEnabled: true };
    expect(scheduleInput.safeParse(schedule).success).toBe(true);
    for (const changed of [{ amountMinor: -1 }, { amountMinor: 0.1 }, { billingAnchorOn: "2026-02-30" }, { nextPeriod: -1 }, { reminderDays: 2 }, { serviceUrl: "javascript:alert(1)" }, { intervalUnit: "week" }]) expect(scheduleInput.safeParse({ ...schedule, ...changed }).success).toBe(false);
    expect(subscriptionCreateInput.safeParse({ schedule }).success).toBe(false);
    expect(subscriptionCreateInput.safeParse({ itemId: randomUUID(), schedule }).success).toBe(true);
    expect(subscriptionCreateInput.safeParse({ itemId: randomUUID(), name: "Ambiguous", schedule }).success).toBe(false);
  });
});
describe("email boundaries", () => {
  it("escapes user names in HTML and provides text, deep links and unsubscribe headers", () => {
    const payload = renderDigest([{ name: '<script>alert("hi")</script>', amountMinor: 1500, currency: "USD", nextDueOn: "2026-10-20", itemId: randomUUID() }], "https://example.com", "https://example.com/unsubscribe?token=signed", "onboarding@resend.dev", "me@example.com");
    expect(payload.html).not.toContain("<script>"); expect(payload.html).toContain("&lt;script&gt;");
    expect(payload.text).toContain("$15.00 expected"); expect(payload.html).toContain("/?item=");
    expect(payload.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
  it("signs unsubscribe links with purpose and account-bound nonces", () => {
    const userId = randomUUID(), nonce = randomUUID(), token = unsubscribeToken(userId, nonce, "secret");
    expect(parseUnsubscribeToken(token, "secret")).toEqual({ userId, nonce });
    expect(parseUnsubscribeToken(token, "other")).toBeNull(); expect(parseUnsubscribeToken(token + "x", "secret")).toBeNull();
    expect(parseUnsubscribeToken("invalid", "secret")).toBeNull();
  });
  it("verifies raw webhook bytes, timestamp and signed event ID", () => {
    const secret = Buffer.from("test-webhook-secret").toString("base64"), timestamp = "1791716400", id = "msg_fixture", body = '{"type":"email.delivered"}';
    const signature = createHmac("sha256", Buffer.from(secret, "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
    const headers = new Headers({ "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` });
    expect(verifyResendWebhook(body, headers, `whsec_${secret}`, Number(timestamp) * 1000)).toBe(id);
    expect(verifyResendWebhook(body + " ", headers, `whsec_${secret}`, Number(timestamp) * 1000)).toBeNull();
    expect(verifyResendWebhook(body, headers, `whsec_${secret}`, (Number(timestamp) + 301) * 1000)).toBeNull();
  });
  it("passes the stable key to Resend without exposing provider errors", async () => {
    vi.stubEnv("RESEND_API", "test-secret");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "provider-id" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const payload = renderDigest([], "https://example.com", "https://example.com/unsubscribe", "onboarding@resend.dev", "me@example.com");
    expect(await sendResendEmail(payload, "stable-key")).toEqual({ id: "provider-id" });
    expect(fetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe("stable-key");
    fetch.mockResolvedValue(new Response("sensitive provider content", { status: 429 }));
    await expect(sendResendEmail(payload, "stable-key")).rejects.toMatchObject({ retryable: true, code: "provider_429", message: "Email delivery request failed." });
  });
  it("retries provider in-flight duplicates but stops changed-content conflicts", async () => {
    vi.stubEnv("RESEND_API_KEY", "fixture-key");
    const fetch=vi.fn(); vi.stubGlobal("fetch",fetch);
    const payload=renderDigest([],"https://example.com","https://example.com/unsubscribe","onboarding@resend.dev","me@example.com");
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({name:"concurrent_idempotent_requests",message:"private provider message"}),{status:409}));
    await expect(sendResendEmail(payload,"stable-key")).rejects.toMatchObject({retryable:true,code:"provider_409_concurrent"});
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({name:"invalid_idempotent_request"}),{status:409}));
    await expect(sendResendEmail(payload,"stable-key")).rejects.toMatchObject({retryable:false,code:"provider_409"});
  });
  it("keeps the worker private and unsubscribe GET free of mutations", async () => {
    const verifyToken = vi.fn(async () => null);
    const unsubscribe = vi.fn();
    const app = createApi({ verifyToken, service: () => { throw new Error("not used"); }, reminderEmail: () => ({ unsubscribe }) as never });
    vi.stubEnv("REMINDER_WORKER_SECRET", "worker-secret");
    expect((await app.request("/api/internal/reminders/run", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/subscriptions")).status).toBe(401);
    const response = await app.request("/api/reminders/unsubscribe?token=abc.def.ghi");
    expect(response.status).toBe(200); expect(await response.text()).toContain("Stop reminder emails?");
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});
