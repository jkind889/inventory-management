"use client";

import { useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { getSubmissionAttempt, type SubmissionAttempt } from "@/shared/submission";
import { TAGS_CHANGED, type Tag } from "@/shared/tags";
import { TagChips, TagPicker } from "./tag-controls";

export function ItemTags({ itemId, initial }: { itemId: string; initial: Tag[] }) {
  const [tags, setTags] = useState(initial);
  const [draft, setDraft] = useState(initial.map(tag => tag.name));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const attempt = useRef<SubmissionAttempt | null>(null);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || pending) return;
    const path = `/items/${itemId}/tags`;
    const body = JSON.stringify({ tags: [...draft].sort() });
    attempt.current = getSubmissionAttempt(attempt.current, path, body);
    setBusy(true); setError("");
    try {
      const result = await api<{ tags: Tag[] }>(path, { method: "PUT", body, headers: { "Idempotency-Key": attempt.current.key } });
      setTags(result.tags); setEditing(false); attempt.current = null; setNotice("Tags saved.");
      window.dispatchEvent(new CustomEvent(TAGS_CHANGED, { detail: { itemId } }));
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <section className="item-tags" aria-label="Item tags">
    <div className="tag-section-heading"><h2>Tags</h2>{!editing && <button type="button" className="text-button" onClick={() => { setDraft(tags.map(tag => tag.name)); setPending(false); setError(""); setNotice(""); setEditing(true); }}>Edit tags</button>}</div>
    {editing ? <form onSubmit={save}>
      <TagPicker value={draft} onChange={setDraft} pendingChanged={setPending} disabled={busy} />
      {error && <p className="form-message error" role="alert">{error}</p>}
      <div className="tag-editor-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => { setEditing(false); attempt.current = null; }}>Cancel tags</button><button className="button primary" disabled={busy || pending}>{busy ? "Saving tags…" : "Save tags"}</button></div>
    </form> : tags.length ? <TagChips tags={tags} /> : <p className="muted">No tags yet.</p>}
    {notice && <p role="status" className="field-help">{notice}</p>}
  </section>;
}
