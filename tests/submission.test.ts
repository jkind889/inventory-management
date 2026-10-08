import { describe, expect, it } from "vitest";
import { getSubmissionAttempt } from "../src/shared/submission";

describe("submission retry identity", () => {
  it.each(["/items", "/purchases"])("retains the key after a failed %s attempt", path => {
    const body = JSON.stringify({ name: "Headphones" });
    const first = getSubmissionAttempt(null, path, body);
    expect(getSubmissionAttempt(first, path, body).key).toBe(first.key);
  });
  it("uses a new key when fields or the submission flow change", () => {
    const first = getSubmissionAttempt(null, "/items", "original");
    expect(getSubmissionAttempt(first, "/items", "edited").key).not.toBe(first.key);
    expect(getSubmissionAttempt(first, "/purchases", "original").key).not.toBe(first.key);
  });
  it("permits a separate intended item with identical fields after clearing the attempt", () => {
    const first = getSubmissionAttempt(null, "/items", "same item");
    expect(getSubmissionAttempt(null, "/items", "same item").key).not.toBe(first.key);
  });
});
