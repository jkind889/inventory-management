export type SubmissionAttempt = { signature: string; key: string };

// Retain the returned attempt through failures; clear it after confirmed success
// or when the user starts a separate intended submission.
export function getSubmissionAttempt(
  previous: SubmissionAttempt | null,
  path: string,
  body: string,
): SubmissionAttempt {
  const signature = JSON.stringify([path, body]);
  return previous?.signature === signature
    ? previous
    : { signature, key: crypto.randomUUID() };
}
