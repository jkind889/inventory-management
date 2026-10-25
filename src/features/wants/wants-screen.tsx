"use client";

import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { TagChips, TagFilter, TagPicker } from "@/features/tags/tag-controls";
import { TAGS_CHANGED, type Tag } from "@/shared/tags";
import { Dialog } from "@/components/dialog";
import { Icon } from "@/components/icon";
import { WorkbenchInspector, WorkbenchPagination, WorkbenchSidebar } from "@/features/collection/workbench-panels";
import {
  formatMoney,
  ITEMS_CHANGED,
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
  categoryId,
}: {
  categories: Category[];
  profile: Profile;
  close: () => void;
  saved: () => void;
  categoryId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [pendingTag, setPendingTag] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<SubmissionAttempt | null>(null);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || pendingTag) return;
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
      ...(tags.length ? { tags } : {}),
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
            <select name="category" required defaultValue={categoryId || categories[0]?.id}>
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
        <TagPicker value={tags} onChange={setTags} pendingChanged={setPendingTag} disabled={busy} />
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
          <button className="button primary" disabled={busy || pendingTag}>
            {busy ? "Saving…" : "Save want"}
            <Icon name="plus" size={18} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
export function WantsScreen({ profile, categories }: { profile: Profile; categories: Category[] }) {
  const [add, setAdd] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [tagFilters, setTagFilters] = useState<Tag[]>([]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("priority");
  const key = JSON.stringify([offset, refresh, category, search, sort, tagFilters]);
  const [completed, setCompleted] = useState<{
    key: string;
    result?: WantsResponse;
    error?: string;
  } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(query); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "12", offset: String(offset), q: search, sort });
    if (category) params.set("categoryId", category);
    tagFilters.forEach(tag => params.append("tagId", tag.id));
    api<WantsResponse>(`/wants?${params}`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setCompleted({ key, result });
          setSelected(current => current && !result.data.some(item => item.id === current) ? null : current);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setCompleted({ key, error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [key, offset, category, search, sort, tagFilters]);
  const ready = completed?.key === key && query === search;
  const result = ready ? completed?.result : undefined;
  const activeName = categories.find((c) => c.id === category)?.name ?? "All wants";
  useEffect(() => {
    const changed = () => { setRefresh(value => value + 1); setOffset(0); };
    window.addEventListener(TAGS_CHANGED, changed);
    window.addEventListener(ITEMS_CHANGED, changed);
    return () => { window.removeEventListener(TAGS_CHANGED, changed); window.removeEventListener(ITEMS_CHANGED, changed); };
  }, []);
  function filter(id: string) {
    setCategory(id);
    setOffset(0);
    setSelected(null);
  }
  function changePage(value: number) {
    setOffset(value);
    setSelected(null);
  }
  return (
    <div className="wants-workbench">
      {notice && <div className="notice" role="status">
        {notice}
        <button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice("")}><Icon name="close" size={16} /></button>
      </div>}
      <div className="collection-workbench">
        <WorkbenchSidebar categories={categories} category={category} filter={filter} allLabel="All wants" />
        <div className="workbench-workspace">
          <WorkbenchInspector selected={selected} categories={categories} profile={profile} close={() => setSelected(null)} wants />
          <section className="workbench-results" aria-label="Future Wants">
            <header className="results-heading">
              <h2>Future Wants <span>/ {activeName}</span></h2>
              <button className="button secondary" onClick={() => setAdd(true)} disabled={!categories.length}><Icon name="plus" size={16} />Add want</button>
            </header>
            <div className="results-toolbar">
              <label className="workbench-search">
                <Icon name="search" size={16} />
                <input aria-label="Search future wants" placeholder="Search future wants…" value={query} maxLength={200} onChange={(e) => { setQuery(e.target.value); setSelected(null); }} />
              </label>
              <select className="workbench-mobile-category" aria-label="Filter category" value={category} onChange={(e) => filter(e.target.value)}>
                <option value="">All wants</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <TagFilter value={tagFilters} onChange={tags => { setTagFilters(tags); setOffset(0); setSelected(null); }} />
              <select aria-label="Sort future wants" value={sort} onChange={(e) => { setSort(e.target.value); setOffset(0); setSelected(null); }}>
                <option value="priority">High priority first</option>
                <option value="newest">Recently added</option>
                <option value="name">Name A–Z</option>
              </select>
            </div>
            <div className="results-scroll" aria-busy={!ready}>
              {!ready ? <p className="results-message" role="status">Loading future wants…</p> : completed.error ? (
                <div className="empty-state" role="alert"><h2>Future Wants couldn’t load.</h2><p>{completed.error}</p><button className="button secondary" onClick={() => setRefresh((v) => v + 1)}>Try again</button></div>
              ) : !result?.data.length ? (
                <div className="empty-state">
                  <h2>{search || category || tagFilters.length ? "No future wants found." : "A little room for possibility."}</h2>
                  <p>{search || category || tagFilters.length ? "Try a different search, collection, or tag." : "Save something you’re considering, with a link or an estimated price."}</p>
                  <button className="button secondary" disabled={!categories.length && !search && !category && !tagFilters.length} onClick={() => {
                    if (search || category || tagFilters.length) { setQuery(""); filter(""); setTagFilters([]); } else setAdd(true);
                  }}>{search || category || tagFilters.length ? "Clear filters" : "Add your first want"}</button>
                </div>
              ) : (
                <>
                  <div className="register-columns wants-columns" aria-hidden="true"><span>Item</span><span>Collection</span><span>Estimated price</span><span>Priority</span></div>
                  <ul className="collection-register wants-register" aria-label="Future wants">
                    {result.data.map((item) => {
                      const name = categories.find((c) => c.id === item.categoryId)?.name ?? "Other";
                      const price = item.targetAmountMinor === null ? "Price not estimated" : formatMoney(item.targetAmountMinor, profile.currency);
                      const priority = item.priority === 1 ? "High" : item.priority === 3 ? "Low" : "Medium";
                      return <li key={item.id}>
                        <button className="collection-register-row wants-register-row" aria-pressed={selected === item.id} aria-label={`${item.name}, ${name}, ${price}, ${priority} priority`} onClick={() => setSelected(item.id)}>
                          <span className="register-item"><h2 className="register-name">{item.name}</h2><TagChips tags={item.tags} compact /></span>
                          <span className="register-category">{name}</span>
                          <span className="register-price" aria-label={price}>{item.targetAmountMinor === null ? "—" : price}</span>
                          <span className="register-date">{priority}</span>
                        </button>
                      </li>;
                    })}
                  </ul>
                </>
              )}
            </div>
            <footer className="workbench-status">
              <span className="collection-count" role="status">{!ready ? "Loading future wants…" : `${result?.total ?? 0} ${result?.total === 1 ? "want" : "wants"}`}</span>
              {result && <WorkbenchPagination offset={offset} total={result.total} changePage={changePage} />}
              <span className="status-hint">Estimated prices don’t count as spending.</span>
            </footer>
          </section>
        </div>
      </div>
      {add && <AddWant categories={categories} categoryId={category} profile={profile} close={() => setAdd(false)} saved={() => {
        setAdd(false);
        setQuery("");
        setSearch("");
        setTagFilters([]);
        window.dispatchEvent(new CustomEvent(TAGS_CHANGED));
        setOffset(0);
        setSelected(null);
        setRefresh((v) => v + 1);
        setNotice("Saved to Future Wants.");
      }} />}
    </div>
  );
}
