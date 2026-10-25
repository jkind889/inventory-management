"use client";

import { useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { ITEMS_CHANGED, type Category, type ItemDetail } from "@/shared/collection";
import { getSubmissionAttempt, type SubmissionAttempt } from "@/shared/submission";

export function ItemCategory({ itemId, categoryId, categories, saved }: {
  itemId: string;
  categoryId: string;
  categories: Category[];
  saved: (categoryId: string) => void;
}) {
  const [draft, setDraft] = useState(categoryId);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const attempt = useRef<SubmissionAttempt | null>(null);
  const available = categories.filter(category => !category.archivedAt);
  const current = categories.find(category => category.id === categoryId)?.name ?? "Other";

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !draft) return;
    const path = `/items/${itemId}`;
    const body = JSON.stringify({ categoryId: draft });
    attempt.current = getSubmissionAttempt(attempt.current, path, body);
    setBusy(true); setError("");
    try {
      const result = await api<{ item: ItemDetail["item"] }>(path, {
        method: "PATCH", body, headers: { "Idempotency-Key": attempt.current.key },
      });
      saved(result.item.categoryId);
      attempt.current = null;
      setEditing(false); setNotice("Category saved.");
      window.dispatchEvent(new CustomEvent(ITEMS_CHANGED, { detail: { itemId } }));
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }

  return <section className="item-category" aria-label="Item category">
    <div className="tag-section-heading"><h2>Category</h2>{!editing && <button type="button" className="text-button" onClick={() => {
      setDraft(available.some(category => category.id === categoryId) ? categoryId : "");
      setError(""); setNotice(""); setEditing(true);
    }}>Edit category</button>}</div>
    {editing ? <form onSubmit={save}>
      <label className="field">Category<select aria-label="Category" name="category" required value={draft} disabled={busy} onChange={event => setDraft(event.target.value)}>
        <option value="" disabled>Choose a category</option>
        {available.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select></label>
      <p className="field-help">Replaces this item’s category. Purchase history keeps its original spending category.</p>
      {error && <p className="form-message error" role="alert">{error}</p>}
      <div className="tag-editor-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => { setEditing(false); attempt.current = null; }}>Cancel category</button><button className="button primary" disabled={busy || !draft}>{busy ? "Saving category…" : "Save category"}</button></div>
    </form> : <p className="muted">{current}</p>}
    {notice && <p role="status" className="field-help">{notice}</p>}
  </section>;
}
