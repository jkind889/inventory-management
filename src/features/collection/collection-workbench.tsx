"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { api } from "@/lib/api";
import { isCollectionCategory, type Category, type CollectionOverview, type CollectionResponse, type Profile } from "@/shared/collection";
import { TagFilter } from "@/features/tags/tag-controls";
import type { Tag } from "@/shared/tags";
import { CollectionList } from "./collection-list";
import { WorkbenchInspector, WorkbenchPagination, WorkbenchSidebar } from "./workbench-panels";
import { RenewalsPanel, useSubscriptions } from "@/features/subscriptions/subscriptions";

type WorkbenchProps = {
  profile: Profile | null; categories: Category[]; result: CollectionResponse | null;
  loading: boolean; error: string; query: string; category: string; sort: string;
  tagFilters: Tag[]; changeTags: (tags: Tag[]) => void;
  offset: number; selected: string | null; refresh: number;
  openItem: (id: string | null) => void; filter: (id: string) => void;
  changeQuery: (value: string) => void; changeSort: (value: string) => void;
  changePage: (offset: number) => void; retry: () => void; addItem: () => void;
};

export function CollectionWorkbench(props: WorkbenchProps) {
  const { tagFilters, changeTags, profile, categories, result, loading, error, query, category, sort, offset, selected, refresh, openItem, filter, changeQuery, changeSort, changePage, retry, addItem } = props;
  const [overview, setOverview] = useState<{ refresh: number; data: CollectionOverview } | null>(null);
  const reminders = useSubscriptions(!!profile);
  const [renewalsOpen, setRenewalsOpen] = useState(false);
  function showRenewals() { setRenewalsOpen(true); openItem(null); }
  useEffect(() => {
    if (!profile) return;
    const controller = new AbortController();
    api<CollectionOverview>("/collections/overview", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setOverview({ refresh, data }); })
      .catch(() => { /* Counts are optional; the collection table reports its own errors. */ });
    return () => controller.abort();
  }, [profile, refresh]);
  const available = categories.filter(isCollectionCategory);
  const counts = !profile ? new Map(categories.map((c) => [c.id, 0])) : overview?.refresh === refresh ? new Map(overview.data.data.map((entry) => [entry.category.id, entry.total])) : null;
  const activeName = categories.find((c) => c.id === category)?.name ?? "All items";
  return <div className="collection-workbench">
    <WorkbenchSidebar categories={available} category={category} filter={id => { setRenewalsOpen(false); filter(id); }} counts={counts} />
    <div className="workbench-workspace">
      <WorkbenchInspector selected={selected} categories={categories} profile={profile} close={() => openItem(null)}
        emptyContent={profile && (renewalsOpen || activeName.toLowerCase() === "subscriptions") ? <RenewalsPanel {...reminders} profile={profile} categories={categories} openItem={openItem} /> : reminders.data?.attentionCount ? <div className="inspector-empty"><div className="renewal-home-alert"><h2>{reminders.data.attentionCount} {reminders.data.attentionCount === 1 ? "renewal needs" : "renewals need"} attention</h2><p>Review upcoming and unresolved subscription dates.</p><button className="button secondary" onClick={showRenewals}>View renewals</button></div><h1>Select an item</h1><p>Choose a row below to view its information and purchase record.</p></div> : undefined} />
      <section className="workbench-results" aria-label="Items">
        <header className="results-heading"><h2>Items <span>/ {activeName}</span></h2><div className="worth-actions">{profile && <button className="button secondary" onClick={showRenewals}>Renewals{reminders.data?.attentionCount ? ` (${reminders.data.attentionCount})` : ""}</button>}<button className="button secondary" onClick={addItem}><Icon name="plus" size={16} />Add item</button></div></header>
        <div className="results-toolbar">
          <label className="workbench-search"><Icon name="search" size={16} /><input aria-label="Search your collection" placeholder="Search your collection…" maxLength={200} value={query} onChange={(e) => changeQuery(e.target.value)} /></label>
          <select className="workbench-mobile-category" aria-label="Filter category" value={category} onChange={(e) => { setRenewalsOpen(false); filter(e.target.value); }}><option value="">All items</option>{available.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          {profile && <TagFilter value={tagFilters} onChange={changeTags} />}
          <select aria-label="Sort collection" value={sort} onChange={(e) => changeSort(e.target.value)}><option value="newest">Recently added</option><option value="name">Name A–Z</option><option value="purchased">Purchase date</option></select>
        </div>
        <div className="results-scroll" aria-busy={loading}>
          {error ? <div className="empty-state" role="alert"><h2>Something didn’t load.</h2><p>{error}</p><button className="button secondary" onClick={retry}>Try again</button></div> : loading ? <p className="results-message">Loading your collection…</p> : !result?.data.length ? <div className="empty-state"><h2>{!profile && !query && !category ? "Your collection starts here." : "No items found."}</h2><p>{query || category || tagFilters.length ? "Try a different search, collection, or tag." : !profile ? "Create an account or sign in to save and manage your inventory." : "Add your first item to get started."}</p><button className="button secondary" onClick={() => { if (query || category || tagFilters.length) { changeQuery(""); filter(""); changeTags([]); } else addItem(); }}>{query || category || tagFilters.length ? "Clear filters" : !profile ? "Create account" : "Add your first item"}</button></div> : <>
            <div className="register-columns" aria-hidden="true"><span>Item</span><span>Collection</span><span>Cost</span><span>Acquired on</span></div>
            <CollectionList items={result.data} categories={categories} currency={profile?.currency ?? "USD"} openItem={openItem} selected={selected} />
          </>}
        </div>
        <footer className="workbench-status"><span className="collection-count" role="status">{loading ? "Loading your collection…" : `${result?.total ?? 0} ${(result?.total ?? 0) === 1 ? "item" : "items"}`}</span>{!loading && result && <WorkbenchPagination offset={offset} total={result.total} changePage={changePage} />}<span className="status-hint">{selected ? "Item selected" : "Select a row to inspect"}</span></footer>
      </section>
    </div>
  </div>;
}
