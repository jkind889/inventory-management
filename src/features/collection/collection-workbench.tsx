"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { api } from "@/lib/api";
import { isCollectionCategory, type Category, type CollectionOverview, type CollectionResponse, type Profile } from "@/shared/collection";
import { CollectionList } from "./collection-list";
import { WorkbenchInspector, WorkbenchPagination, WorkbenchSidebar } from "./workbench-panels";

type WorkbenchProps = {
  profile: Profile; categories: Category[]; result: CollectionResponse | null;
  loading: boolean; error: string; query: string; category: string; sort: string;
  offset: number; selected: string | null; refresh: number;
  openItem: (id: string | null) => void; filter: (id: string) => void;
  changeQuery: (value: string) => void; changeSort: (value: string) => void;
  changePage: (offset: number) => void; retry: () => void; addItem: () => void;
};

export function CollectionWorkbench(props: WorkbenchProps) {
  const { profile, categories, result, loading, error, query, category, sort, offset, selected, refresh, openItem, filter, changeQuery, changeSort, changePage, retry, addItem } = props;
  const [overview, setOverview] = useState<{ refresh: number; data: CollectionOverview } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<CollectionOverview>("/collections/overview", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setOverview({ refresh, data }); })
      .catch(() => { /* Counts are optional; the collection table reports its own errors. */ });
    return () => controller.abort();
  }, [refresh]);
  const available = categories.filter(isCollectionCategory);
  const counts = overview?.refresh === refresh ? new Map(overview.data.data.map((entry) => [entry.category.id, entry.total])) : null;
  const activeName = categories.find((c) => c.id === category)?.name ?? "All items";
  return <div className="collection-workbench">
    <WorkbenchSidebar categories={available} category={category} filter={filter} counts={counts} />
    <div className="workbench-workspace">
      <WorkbenchInspector selected={selected} categories={categories} profile={profile} close={() => openItem(null)} />
      <section className="workbench-results" aria-label="Items">
        <header className="results-heading"><h2>Items <span>/ {activeName}</span></h2><button className="button secondary" onClick={addItem}><Icon name="plus" size={16} />Add item</button></header>
        <div className="results-toolbar">
          <label className="workbench-search"><Icon name="search" size={16} /><input aria-label="Search your collection" placeholder="Search your collection…" maxLength={200} value={query} onChange={(e) => changeQuery(e.target.value)} /></label>
          <select className="workbench-mobile-category" aria-label="Filter category" value={category} onChange={(e) => filter(e.target.value)}><option value="">All items</option>{available.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select aria-label="Sort collection" value={sort} onChange={(e) => changeSort(e.target.value)}><option value="newest">Recently added</option><option value="name">Name A–Z</option><option value="purchased">Purchase date</option></select>
        </div>
        <div className="results-scroll" aria-busy={loading}>
          {error ? <div className="empty-state" role="alert"><h2>Something didn’t load.</h2><p>{error}</p><button className="button secondary" onClick={retry}>Try again</button></div> : loading ? <p className="results-message">Loading your collection…</p> : !result?.data.length ? <div className="empty-state"><h2>No items found.</h2><p>{query || category ? "Try a different search or collection." : "Add your first item to get started."}</p><button className="button secondary" onClick={() => { if (query || category) { changeQuery(""); filter(""); } else addItem(); }}>{query || category ? "Clear filters" : "Add your first item"}</button></div> : <>
            <div className="register-columns" aria-hidden="true"><span>Item</span><span>Collection</span><span>Cost</span><span>Acquired on</span></div>
            <CollectionList items={result.data} categories={categories} currency={profile.currency} openItem={openItem} selected={selected} />
          </>}
        </div>
        <footer className="workbench-status"><span className="collection-count" role="status">{loading ? "Loading your collection…" : `${result?.total ?? 0} ${(result?.total ?? 0) === 1 ? "item" : "items"}`}</span>{!loading && result && <WorkbenchPagination offset={offset} total={result.total} changePage={changePage} />}<span className="status-hint">{selected ? "Item selected" : "Select a row to inspect"}</span></footer>
      </section>
    </div>
  </div>;
}
