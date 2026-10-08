"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import type { Category, Profile } from "@/shared/collection";
import { ItemDetails } from "./item-details";

export function WorkbenchSidebar({
  categories, category, filter, counts, allLabel = "All items",
}: {
  categories: Category[];
  category: string;
  filter: (id: string) => void;
  counts?: Map<string, number> | null;
  allLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const matching = categories.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <aside className="workbench-sidebar" aria-label="Collections">
      <h2>Collections</h2>
      <label className="workbench-search sidebar-search">
        <Icon name="search" size={16} />
        <input aria-label="Filter collections" placeholder="Filter collections…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <nav className="collection-tree" aria-label="Collection navigation">
        <button className="tree-root" aria-current={!category ? "true" : undefined} onClick={() => filter("")}>
          <Icon name="grid" size={16} /><span>{allLabel}</span>
          {counts && <span className="tree-count">{Array.from(counts.values()).reduce((total, count) => total + count, 0)}</span>}
        </button>
        {matching.map((c) => (
          <button key={c.id} aria-current={category === c.id ? "true" : undefined} onClick={() => filter(c.id)}>
            <Icon name="chevron" className="tree-chevron" size={12} /><Icon name="box" size={16} /><span>{c.name}</span>
            {counts?.has(c.id) && <span className="tree-count">{counts.get(c.id)}</span>}
          </button>
        ))}
        {query && !matching.length && <p className="tree-empty">No collections found.</p>}
      </nav>
      <div className="sidebar-footer"><span>Collection</span><strong>{categories.find((c) => c.id === category)?.name ?? allLabel}</strong></div>
    </aside>
  );
}

export function WorkbenchInspector({ selected, categories, profile, close, wants = false }: {
  selected: string | null;
  categories: Category[];
  profile: Profile;
  close: () => void;
  wants?: boolean;
}) {
  return (
    <section className="workbench-detail" aria-label="Item details">
      <header className="inspector-tab">
        <span><Icon name="receipt" size={16} /> Item details</span>
        {selected && <button className="icon-button" aria-label="Close item details" onClick={close}><Icon name="close" size={16} /></button>}
      </header>
      <div className="inspector-scroll" aria-live="polite">
        {selected ? <ItemDetails key={selected} id={selected} categories={categories} profile={profile} /> : (
          <div className="inspector-empty">
            <Icon name="box" size={32} />
            <h1>{wants ? "Select a future want" : "Select an item"}</h1>
            <p>{wants ? "Choose a row below to view its estimated price, priority, notes, and product link." : "Choose a row below to view its information and purchase record."}</p>
          </div>
        )}
      </div>
    </section>
  );
}

export function WorkbenchPagination({ offset, total, changePage }: {
  offset: number;
  total: number;
  changePage: (offset: number) => void;
}) {
  if (total <= 12) return null;
  return (
    <div className="workbench-pagination">
      <span>{offset + 1}–{Math.min(offset + 12, total)} of {total}</span>
      <button aria-label="Previous" disabled={offset === 0} onClick={() => changePage(offset - 12)}><Icon name="arrow" className="previous-arrow" size={14} /></button>
      <button aria-label="Next" disabled={offset + 12 >= total} onClick={() => changePage(offset + 12)}><Icon name="arrow" size={14} /></button>
    </div>
  );
}
