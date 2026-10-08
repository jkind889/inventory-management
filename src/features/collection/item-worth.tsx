"use client";

import { useRef, useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/api";
import type { ItemReview } from "@/shared/collection";
import { getSubmissionAttempt, type SubmissionAttempt } from "@/shared/submission";
import { usageFrequencies, usageLabels, verdictLabels, worthVerdicts } from "@/shared/reviews";

function ReviewSummary({ review, timezone }: { review: ItemReview; timezone: string }) {
  return <div className="worth-summary">
    <p><strong className={`worth-verdict verdict-${review.verdict}`}>{verdictLabels[review.verdict]}</strong>
      <time dateTime={review.createdAt}>{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: timezone }).format(new Date(review.createdAt))}</time>
    </p>
    <dl className="inspector-fields">
      <div><dt>Usage</dt><dd>{review.usageFrequency ? usageLabels[review.usageFrequency] : "Not recorded"}</dd></div>
      <div><dt>Would buy again?</dt><dd>{review.wouldBuyAgain === null ? "Still deciding" : review.wouldBuyAgain ? "Yes" : "No"}</dd></div>
      {review.note && <div><dt>Why?</dt><dd className="inspector-note">{review.note}</dd></div>}
    </dl>
  </div>;
}

export function ItemWorth({ itemId, reviews: initialReviews, timezone }: { itemId: string; reviews: ItemReview[]; timezone: string }) {
  const [reviews, setReviews] = useState(initialReviews);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const attempt = useRef<SubmissionAttempt | null>(null);
  const pending = useRef(false);
  const latest = reviews[0];

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const fields = new FormData(event.currentTarget);
    const buyAgain = fields.get("wouldBuyAgain");
    const body = JSON.stringify({
      verdict: fields.get("verdict"),
      usageFrequency: fields.get("usageFrequency") || null,
      wouldBuyAgain: buyAgain === "" ? null : buyAgain === "yes",
      note: String(fields.get("note") ?? "").trim() || null,
    });
    const path = `/items/${itemId}/reviews`;
    attempt.current = getSubmissionAttempt(attempt.current, path, body);
    pending.current = true;
    setSaving(true); setError(""); setSaved(false);
    try {
      const { review } = await api<{ review: ItemReview }>(path, {
        method: "POST", body, headers: { "Idempotency-Key": attempt.current.key },
      });
      setReviews((previous) => [review, ...previous.filter((entry) => entry.id !== review.id)].slice(0, 20));
      attempt.current = null;
      setEditing(false); setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      pending.current = false; setSaving(false);
    }
  }

  return <section className="inspector-worth" aria-labelledby={`worth-heading-${itemId}`}>
    <h2 id={`worth-heading-${itemId}`}>Worth it?</h2>
    {latest ? <ReviewSummary review={latest} timezone={timezone} /> : <p className="muted">No check-in yet. Reflect on how much you use this item and whether it was worth the cost.</p>}
    {saved && <p className="worth-saved" role="status">Check-in saved.</p>}
    {editing ? <form className="worth-form" onSubmit={save}>
      <fieldset disabled={saving}>
        <legend>{latest ? "New check-in" : "First check-in"}</legend>
        <label>Verdict<select name="verdict" required defaultValue={latest?.verdict ?? ""}>
          <option value="" disabled>Choose a verdict</option>
          {worthVerdicts.map((verdict) => <option value={verdict} key={verdict}>{verdictLabels[verdict]}</option>)}
        </select></label>
        <label>How often do you use it?<select name="usageFrequency" defaultValue={latest?.usageFrequency ?? ""}>
          <option value="">Not recorded</option>
          {usageFrequencies.map((frequency) => <option value={frequency} key={frequency}>{usageLabels[frequency]}</option>)}
        </select></label>
        <label>Would you buy it again?<select name="wouldBuyAgain" defaultValue={latest?.wouldBuyAgain === true ? "yes" : latest?.wouldBuyAgain === false ? "no" : ""}>
          <option value="">Still deciding</option><option value="yes">Yes</option><option value="no">No</option>
        </select></label>
        <label>Why? <span className="muted">(optional)</span><textarea name="note" rows={3} maxLength={5000} placeholder="What made it worthwhile, or what disappointed you?" /></label>
      </fieldset>
      {error && <p className="form-message error" role="alert">{error}</p>}
      <div className="worth-actions">
        <button className="button" disabled={saving} type="submit">{saving ? "Saving…" : "Save check-in"}</button>
        <button className="button secondary" disabled={saving} type="button" onClick={() => { setEditing(false); setError(""); attempt.current = null; }}>Cancel</button>
      </div>
    </form> : <button className="button secondary" onClick={() => { setEditing(true); setSaved(false); }}>{latest ? "Add check-in" : "Review this item"}</button>}
    {reviews.length > 1 && <details className="worth-history">
      <summary>Earlier check-ins ({reviews.length - 1})</summary>
      <p className="muted">Showing up to the 20 most recent check-ins.</p>
      {reviews.slice(1).map((review) => <ReviewSummary key={review.id} review={review} timezone={timezone} />)}
    </details>}
  </section>;
}
