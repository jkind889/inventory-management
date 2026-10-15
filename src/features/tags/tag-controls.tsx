"use client";

import { useEffect, useId, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { MAX_ITEM_TAGS, TAGS_CHANGED, normalizeTag, tagLength, tagNameInput, type Tag, type TagsResponse } from "@/shared/tags";

function useTagSearch(query: string, enabled = true) {
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{ key: string; response?: TagsResponse; error?: string } | null>(null);
  const key = JSON.stringify([query, refresh, page]);
  useEffect(() => {
    const changed = () => setRefresh(value => value + 1);
    window.addEventListener(TAGS_CHANGED, changed);
    return () => window.removeEventListener(TAGS_CHANGED, changed);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query, limit: "20", offset: String(page * 20) });
      api<TagsResponse>(`/tags?${params}`, { signal: controller.signal })
        .then(response => { if (!controller.signal.aborted) setResult({ key, response }); })
        .catch(error => { if (!controller.signal.aborted) setResult({ key, error: errorMessage(error) }); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, query, page, enabled]);
  return {
    response: result?.key === key ? result.response : undefined,
    error: result?.key === key ? result.error : undefined,
    page,
    reset: () => setPage(0),
    previous: () => setPage(value => Math.max(0, value - 1)),
    next: () => setPage(value => value + 1),
    retry: () => setRefresh(value => value + 1),
  };
}

function SuggestionPages({ search }: { search: ReturnType<typeof useTagSearch> }) {
  if (!search.response || (!search.page && search.response.total <= 20)) return null;
  return <div className="tag-page-actions">
    <button type="button" disabled={!search.page} onClick={search.previous}>Previous tags</button>
    <button type="button" disabled={(search.page + 1) * 20 >= search.response.total} onClick={search.next}>Next tags</button>
  </div>;
}

export function TagChips({ tags = [], compact = false }: { tags?: Tag[]; compact?: boolean }) {
  if (!tags.length) return null;
  return <span className="tag-chips">{(compact ? tags.slice(0, 2) : tags).map(tag => <span className="tag-chip" key={tag.id}>{tag.name}</span>)}
    {compact && tags.length > 2 && <span className="tag-chip" aria-label={`${tags.length - 2} more tags`}>+{tags.length - 2}</span>}
  </span>;
}

export function TagPicker({ value, onChange, disabled = false, pendingChanged }: {
  value: string[]; onChange: (tags: string[]) => void; disabled?: boolean; pendingChanged: (pending: boolean) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const normalized = normalizeTag(query);
  const parsed = tagNameInput.safeParse(query);
  const validation = query && !parsed.success ? parsed.error.issues[0].message : "";
  const full = value.length >= MAX_ITEM_TAGS;
  const search = useTagSearch(normalized, !disabled && !full);
  const suggestions = search.response?.data.filter(tag => !value.includes(tag.name)) ?? [];
  function changeQuery(text: string) {
    setQuery(text); setError(""); search.reset(); pendingChanged(!!text);
  }
  function add(name: string) {
    const checked = tagNameInput.safeParse(name);
    if (!checked.success) { setError(checked.error.issues[0].message); return; }
    if (value.includes(checked.data)) { setError("This tag is already on the item."); return; }
    if (full) { setError("An item can have up to 5 tags."); return; }
    onChange([...value, checked.data].sort());
    changeQuery("");
  }
  return <fieldset className="tag-picker" disabled={disabled}>
    <legend>Tags (optional)</legend>
    <div className="tag-chips">{value.map(name => <span className="tag-chip" key={name}>{name}<button type="button" aria-label={`Remove tag ${name}`} onClick={() => onChange(value.filter(tag => tag !== name))}>×</button></span>)}</div>
    <label className="field" htmlFor={id}>Add a tag
      <input id={id} value={query} disabled={full || disabled} placeholder={full ? "Five-tag limit reached" : "Search or create a tag…"}
        aria-describedby={`${id}-help ${id}-error`} aria-invalid={!!(validation || error)}
        onChange={event => changeQuery(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); if (query) add(query); }
        }} />
    </label>
    <p id={`${id}-help`} className="field-help">{value.length}/5 tags · {tagLength(query)}/30 characters{query ? " · Select a tag or choose Create before saving." : ""}</p>
    {(validation || error) && <p id={`${id}-error`} role="alert" className="form-message error">{validation || error}</p>}
    {!full && !disabled && <div className="tag-suggestions" aria-label="Tag suggestions">
      {search.error ? <p role="alert">{search.error} <button type="button" onClick={search.retry}>Retry tags</button></p> : !search.response ? <p role="status">Loading tags…</p> : <>
        {suggestions.map(tag => <button type="button" key={tag.id} onClick={() => add(tag.name)}>Use {tag.name}</button>)}
        {parsed.success && normalized && !value.includes(normalized) && !search.response.data.some(tag => tag.name === normalized) && <button type="button" onClick={() => add(query)}>Create “{normalized}”</button>}
        <SuggestionPages search={search} />
      </>}
    </div>}
  </fieldset>;
}

export function TagFilter({ value, onChange }: { value: Tag[]; onChange: (tags: Tag[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const search = useTagSearch(normalizeTag(query), open);
  return <div className="tag-filter">
    <button type="button" className="button secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>Tags{value.length ? ` (${value.length})` : ""}</button>
    {open && <div className="tag-filter-panel">
      <label className="field">Filter tags<input aria-label="Filter tags" placeholder="Search tags…" value={query} maxLength={200} onChange={event => { setQuery(event.target.value); search.reset(); }} /></label>
      <p className="field-help">Match all selected tags.</p>
      <div className="tag-chips">{value.map(tag => <span className="tag-chip" key={tag.id}>{tag.name}<button type="button" aria-label={`Remove filter ${tag.name}`} onClick={() => onChange(value.filter(selected => selected.id !== tag.id))}>×</button></span>)}</div>
      {value.length > 0 && <button type="button" className="text-button" onClick={() => onChange([])}>Clear tags</button>}
      {search.error ? <p role="alert">{search.error} <button type="button" onClick={search.retry}>Retry tags</button></p> : !search.response ? <p role="status">Loading tags…</p> : <>
        <div className="tag-filter-options">{search.response.data.map(tag => <label key={tag.id}><input type="checkbox" checked={value.some(selected => selected.id === tag.id)} disabled={value.length >= 5 && !value.some(selected => selected.id === tag.id)} onChange={event => onChange(event.target.checked ? [...value, tag] : value.filter(selected => selected.id !== tag.id))} />{tag.name}</label>)}</div>
        {!search.response.data.length && <p className="field-help">No tags found.</p>}
        <SuggestionPages search={search} />
      </>}
      <button type="button" className="text-button" onClick={() => setOpen(false)}>Done</button>
    </div>}
    {!open && value.length > 0 && <div className="tag-chips">{value.map(tag => <span key={tag.id} className="tag-chip">{tag.name}<button type="button" aria-label={`Remove filter ${tag.name}`} onClick={() => onChange(value.filter(selected => selected.id !== tag.id))}>×</button></span>)}<button type="button" className="text-button" onClick={() => onChange([])}>Clear tags</button></div>}
  </div>;
}
