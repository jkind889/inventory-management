"use client";

import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Dialog } from "@/components/dialog";
import { Icon } from "@/components/icon";
import { CategoryArtwork } from "@/components/category-artwork";
import {
  formatMoney,
  parsePrice,
  type Category,
  type Profile,
  type WantsResponse,
} from "@/shared/collection";
import {
  getSubmissionAttempt,
  type SubmissionAttempt,
} from "@/shared/submission";
function AddWant({
  categories,
  profile,
  close,
  saved,
}: {
  categories: Category[];
  profile: Profile;
  close: () => void;
  saved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<SubmissionAttempt | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const price = String(form.get("price") || "").trim();
    const targetAmountMinor = !price
      ? null
      : /^0(?:\.0{1,2})?$/.test(price)
        ? 0
        : parsePrice(price);
    if (price && targetAmountMinor === null) {
      setError("Enter a valid estimated price, with up to two decimal places.");
      return;
    }
    const body = JSON.stringify({
      name: String(form.get("name")).trim(),
      categoryId: String(form.get("category")),
      targetAmountMinor,
      productUrl: String(form.get("url") || "").trim() || null,
      priority: Number(form.get("priority")),
      description: String(form.get("notes") || "").trim() || null,
    });
    attempt.current = getSubmissionAttempt(attempt.current, "/wants", body);
    setBusy(true);
    setError("");
    try {
      await api("/wants", {
        method: "POST",
        body,
        headers: {
          "Idempotency-Key": attempt.current.key,
        },
      });
      attempt.current = null;
      saved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <Dialog title="Add a future want" close={close} busy={busy}>
      <p className="muted">A place for things you’re considering.</p>
      <form className="item-form" onSubmit={submit}>
        <fieldset disabled={busy}>
          <label className="field">
            Item name
            <input
              autoFocus
              name="name"
              required
              maxLength={200}
              placeholder="What’s on your mind?"
            />
          </label>
          <label className="field">
            Collection
            <select name="category" required>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-row">
            <label className="field">
              Estimated price ({profile.currency})
              <input
                name="price"
                inputMode="decimal"
                maxLength={13}
                placeholder="Optional"
              />
            </label>
            <label className="field">
              Priority
              <select name="priority" defaultValue="2">
                <option value="1">High</option>
                <option value="2">Medium</option>
                <option value="3">Low</option>
              </select>
            </label>
          </div>
          <label className="field">
            Product link (optional)
            <input
              name="url"
              type="url"
              pattern="https?://.*"
              maxLength={2048}
              placeholder="https://"
            />
          </label>
          <label className="field">
            Notes (optional)
            <textarea name="notes" maxLength={5000} rows={3} />
          </label>
        </fieldset>
        <p className="field-help">Estimated prices don’t count as spending.</p>
        {error && (
          <p className="form-message error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save want"}
            <Icon name="plus" size={18} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
export function WantsScreen({
  profile,
  categories,
  openItem,
}: {
  profile: Profile;
  categories: Category[];
  openItem: (id: string) => void;
}) {
  const [add, setAdd] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState("");
  const key = `${offset}:${refresh}`;
  const [completed, setCompleted] = useState<{
    key: string;
    result?: WantsResponse;
    error?: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<WantsResponse>(`/wants?limit=12&offset=${offset}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted)
          setCompleted({
            key,
            result,
          });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setCompleted({
            key,
            error: errorMessage(error),
          });
      });
    return () => controller.abort();
  }, [key, offset]);
  const ready = completed?.key === key;
  const result = ready ? completed?.result : undefined;
  return (
    <>
      <header className="collection-heading">
        <div>
          <h1>Future Wants</h1>
          <p className="muted">Things to consider. A little time to decide.</p>
        </div>
        <button
          className="button secondary"
          onClick={() => setAdd(true)}
          disabled={!categories.length}
        >
          Add want <Icon name="plus" size={18} />
        </button>
      </header>
      <div className="wants-note">
        <span>Estimated prices don’t count as spending.</span>
        <span>High priority first</span>
      </div>
      {notice && (
        <div className="notice" role="status">
          {notice}
          <button
            className="icon-button"
            aria-label="Dismiss message"
            onClick={() => setNotice("")}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {!ready ? (
        <div
          className="item-grid"
          role="status"
          aria-label="Loading future wants"
        >
          {[0, 1, 2].map((i) => (
            <div className="skeleton" key={i} />
          ))}
        </div>
      ) : completed.error ? (
        <div className="empty-state" role="alert">
          <h2>Future Wants couldn’t load.</h2>
          <p>{completed.error}</p>
          <button
            className="button secondary"
            onClick={() => setRefresh((v) => v + 1)}
          >
            Try again
          </button>
        </div>
      ) : !result?.data.length ? (
        <div className="empty-state">
          <Icon name="box" size={44} />
          <h2>A little room for possibility.</h2>
          <p>
            Save something you’re considering, with a link or an estimated
            price.
          </p>
          <button
            className="button secondary"
            disabled={!categories.length}
            onClick={() => setAdd(true)}
          >
            Add your first want <Icon name="plus" size={16} />
          </button>
        </div>
      ) : (
        <div className="item-grid wants-grid">
          {result.data.map((item) => {
            const category =
              categories.find((c) => c.id === item.categoryId)?.name ?? "Other";
            return (
              <button
                className="item-card"
                key={item.id}
                onClick={() => openItem(item.id)}
              >
                <CategoryArtwork category={category} />
                <div className="item-copy">
                  <div className="want-meta">
                    <span>{category}</span>
                    <span>
                      {item.priority === 1
                        ? "High"
                        : item.priority === 3
                          ? "Low"
                          : "Medium"}{" "}
                      priority
                    </span>
                  </div>
                  <h2>{item.name}</h2>
                  <p>
                    {item.targetAmountMinor === null
                      ? "Price not estimated"
                      : `${formatMoney(item.targetAmountMinor, profile.currency)} estimated`}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
      {result && result.total > 12 && (
        <div className="pagination">
          <span>
            {offset + 1}–{Math.min(offset + 12, result.total)} of {result.total}
          </span>
          <button
            className="button secondary"
            disabled={!offset}
            onClick={() => setOffset((v) => v - 12)}
          >
            Previous
          </button>
          <button
            className="button secondary"
            disabled={offset + 12 >= result.total}
            onClick={() => setOffset((v) => v + 12)}
          >
            Next
          </button>
        </div>
      )}
      {add && (
        <AddWant
          categories={categories}
          profile={profile}
          close={() => setAdd(false)}
          saved={() => {
            setAdd(false);
            setOffset(0);
            setRefresh((v) => v + 1);
            setNotice("Saved to Future Wants.");
          }}
        />
      )}
    </>
  );
}
