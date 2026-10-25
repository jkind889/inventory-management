"use client";

import { useEffect, useState, type ReactNode } from "react";
import Image from "next/image";
import type { User } from "@supabase/supabase-js";
import { Icon } from "@/components/icon";
import { api, errorMessage } from "@/lib/api";
import { getBrowserClient } from "@/lib/supabase-browser";
import { TAGS_CHANGED, type Tag } from "@/shared/tags";
import { Dialog } from "@/components/dialog";
import { CollectionWorkbench } from "./collection-workbench";
import { ItemDetails } from "./item-details";
import { WantsScreen } from "@/features/wants/wants-screen";
import { SpendingScreen } from "@/features/spending/spending-screen";
import { SUBSCRIPTIONS_CHANGED } from "@/features/subscriptions/subscriptions";
import { currencies } from "@/shared/contracts";
import { ItemEditor } from "./item-editor";
import { CollectionTools, type FilterDraft, emptyFilters } from "./collection-tools";
import type { items } from "@/server/db/schema";
import {
  starterCategories,
  ITEMS_CHANGED,
  type Category,
  type CollectionResponse,
  type Profile,
} from "@/shared/collection";
// Display-only starter collections. Guest actions never submit these IDs.
const guestCategories: Category[] = starterCategories.map((name) => ({
  id: `guest-${name.toLowerCase()}`,
  name,
  userId: "",
  archivedAt: null,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
}));

export function CollectionScreen({ user, onAuthenticate, children }: {
  user: User | null;
  onAuthenticate: (mode: "signin" | "signup") => void;
  children?: ReactNode;
}) {
  const [screen, setScreen] = useState<"collection" | "spending" | "wants">(
    "collection",
  );
  const [addCategory, setAddCategory] = useState("");
  const [recentCategoryIds, setRecentCategoryIds] = useState<string[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [categories, setCategories] = useState<Category[]>(user ? [] : guestCategories);
  const [setupError, setSetupError] = useState("");
  const [setupRetry, setSetupRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [tagFilters, setTagFilters] = useState<Tag[]>([]);
  const [sort, setSort] = useState("newest");
  const [offset, setOffset] = useState(0);
  const [completedRequest, setCompletedRequest] = useState<{
    key: string;
    result: CollectionResponse | null;
    error: string;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [linkedItem, setLinkedItem] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const id = new URLSearchParams(window.location.search).get("item");
    return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
  });
  useEffect(() => {
    const refreshPhotos = () => setRefresh(v => v + 1);
    window.addEventListener('inventory:photos-changed', refreshPhotos);
    window.addEventListener(SUBSCRIPTIONS_CHANGED, refreshPhotos);
    return () => { window.removeEventListener('inventory:photos-changed', refreshPhotos); window.removeEventListener(SUBSCRIPTIONS_CHANGED, refreshPhotos); };
  }, []);
  const [add, setAdd] = useState(false);
  const [editor, setEditor] = useState<{item: typeof items.$inferSelect; mode: "edit" | "duplicate"} | null>(null);
  const [filters, setFilters] = useState<FilterDraft>(emptyFilters);
  const [checked, setChecked] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  // A selection is pending until its matching request settles. Query changes
  // also remain pending through the debounce, without a separate loading flag.
  const requestKey = JSON.stringify([
    profile,
    search,
    sort,
    offset,
    category,
    tagFilters,
    refresh,
    filters,
  ]);
  const requestPending = completedRequest?.key !== requestKey;
  const loading = !!user && (query !== search || requestPending);
  const result = completedRequest?.result ?? null;
  const error = loading ? "" : (completedRequest?.error ?? "");
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    (async () => {
      const preferred =
        currencies.find((c) => c === user.user_metadata.preferred_currency) ??
        "USD";
      const p = await api<{
        profile: Profile;
      }>("/profile/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          currency: preferred,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
        signal: controller.signal,
      });
      const c = await api<{
        data: Category[];
      }>("/categories", {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setCategories(c.data);
        setProfile(p.profile);
      }
    })().catch((err) => {
      if (!controller.signal.aborted) setSetupError(errorMessage(err));
    });
    return () => controller.abort();
  }, [user, setupRetry]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!profile || screen !== "collection") return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      q: search,
      sort,
      limit: "12",
      offset: String(offset),
    });
    if (category) params.set("categoryId", category);
    tagFilters.forEach(tag => params.append("tagId", tag.id));
    for (const [key,value] of Object.entries(filters)) if (value !== "") params.set(key,value);
    api<CollectionResponse>(`/collection?${params}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) {
          // Renewal links may select an item outside the current results page.
          // Filter and pagination handlers clear selection when their inputs change.
          setCompletedRequest({
            key: requestKey,
            result: data,
            error: "",
          });
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setCompletedRequest({
            key: requestKey,
            result: null,
            error: errorMessage(err),
          });
        }
      });
    return () => controller.abort();
  }, [profile, search, sort, offset, category, tagFilters, requestKey, screen, filters]);
  useEffect(() => {
    const changed = () => { setRefresh(value => value + 1); setOffset(0); setChecked([]); };
    window.addEventListener(TAGS_CHANGED, changed);
    window.addEventListener(ITEMS_CHANGED, changed);
    return () => { window.removeEventListener(TAGS_CHANGED, changed); window.removeEventListener(ITEMS_CHANGED, changed); };
  }, []);
  function filter(id: string) {
    setCategory(id);
    setOffset(0);
    setSelected(null);
    setChecked([]);
  }
  function collectionChanged(message: string, refreshAccount = false) {
    setOffset(0); setRefresh(value => value + 1); setChecked([]); setSelected(null); setNotice(message);
    if (refreshAccount) {
      // A transfer can change currency, timezone, and the available categories.
      // Hide stale data until canonical account state reloads. A failed reload
      // uses setup's retry screen, without resubmitting the completed transfer.
      setProfile(null); setCompletedRequest(null); setSetupError(""); setSetupRetry(value => value + 1);
    }
  }
  async function signOut() {
    setSigningOut(true);
    try {
      const { error } = await getBrowserClient().auth.signOut();
      if (error) throw error;
    } catch (err) {
      setNotice(errorMessage(err));
      setSigningOut(false);
    }
  }
  return (
    <div className="collection-shell workbench-shell">
      <header className="space-header">
        <button
          className="space-brand"
          aria-label="Marscorp inventory home"
          onClick={() => {
            setScreen("collection");
            setSelected(null);
          }}
        >
          <Image src="/marscorp-logo.png" alt="Marscorp" width={1877} height={838} sizes="(max-width: 700px) 90px, 104px" className="space-logo" preload />
        </button>
        <nav className="space-account" aria-label="Account navigation">
          {user ? <>
            <span className="space-avatar" title={user.email}>
              {(user.email?.[0] ?? "Y").toUpperCase()}
            </span>
            <button
              className="text-button signout"
              onClick={signOut}
              disabled={signingOut}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </> : <>
            <button className="text-button" onClick={() => onAuthenticate("signin")}>Sign in</button>
            <button className="button primary" onClick={() => onAuthenticate("signup")}>Create account</button>
          </>}
        </nav>
      </header>
      <nav className="space-tabs" aria-label="Main navigation">
        <button
          aria-current={screen === "collection" ? "page" : undefined}
          onClick={() => {
            setScreen("collection");
            setSelected(null);
          }}
        >
          Collections
        </button>
        <button
          aria-current={screen === "spending" ? "page" : undefined}
          onClick={() => {
            if (!user) { onAuthenticate("signin"); return; }
            setScreen("spending");
            setSelected(null);
          }}
        >
          Spending
        </button>
        <button
          aria-current={screen === "wants" ? "page" : undefined}
          onClick={() => {
            if (!user) { onAuthenticate("signin"); return; }
            setScreen("wants");
            setSelected(null);
          }}
        >
          Future Wants
        </button>
      </nav>
      <main className={`collection-main ${screen !== "spending" ? "workbench-main" : "workbench-other"}`}>
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
        {setupError ? (
          <div className="empty-state" role="alert">
            <h2>We couldn’t open your space.</h2>
            <p>{setupError}</p>
            <button
              className="button secondary"
              onClick={() => {
                setSetupError("");
                setSetupRetry((v) => v + 1);
              }}
            >
              Try again
            </button>
          </div>
        ) : !profile && user ? (
          <p role="status">Opening your space…</p>
        ) : screen === "spending" && profile ? (
          <SpendingScreen profile={profile} categories={categories} openItem={setSelected} />
        ) : screen === "wants" && profile ? (
          <WantsScreen
            profile={profile}
            categories={categories}
          />
        ) : (
          <CollectionWorkbench
            profile={profile}
            categories={categories}
            result={result}
            loading={loading}
            error={error}
            query={query}
            category={category}
            tagFilters={tagFilters}
            changeTags={(tags) => { setTagFilters(tags); setOffset(0); setSelected(null); setChecked([]); }}
            sort={sort}
            offset={offset}
            selected={selected}
            refresh={refresh}
            openItem={setSelected}
            hasFilters={filters.state !== "owned" || !!filters.from || !!filters.to || !!filters.minAmountMinor || !!filters.maxAmountMinor}
            clearFilters={() => { setQuery("");setSearch("");setCategory("");setFilters(emptyFilters);setOffset(0);setChecked([]);setSelected(null); }}
            checked={checked}
            toggleChecked={(id) => setChecked(v => v.includes(id) ? v.filter(x => x !== id) : [...v,id])}
            editItem={(item) => setEditor({item,mode:"edit"})}
            duplicateItem={(item) => setEditor({item,mode:"duplicate"})}
            tools={profile && <CollectionTools recentCategory={setRecentCategoryIds} profile={profile} categories={categories} query={query} category={category} sort={sort} filters={filters} checked={checked} applyView={(v) => { setQuery(v.q); setSearch(v.q); setCategory(v.categoryId ?? ""); setSort(v.sort); setFilters(v.filters); setOffset(0); setSelected(null); setChecked([]); }} changeFilters={(v) => { setFilters(v); setOffset(0); setSelected(null); setChecked([]); }} changed={collectionChanged} clearChecked={() => setChecked([])} refresh={refresh} />}
            filter={filter}
            changeQuery={(value) => {
              setQuery(value);
              setSelected(null);
              setChecked([]);
            }}
            changeSort={(value) => {
              setChecked([]);
              setSort(value);
              setOffset(0);
              setSelected(null);
            }}
            changePage={(value) => {
              setChecked([]);
              setOffset(value);
              setSelected(null);
            }}
            retry={() => setRefresh((v) => v + 1)}
            addItem={() => {
              if (!user) { onAuthenticate("signup"); return; }
              setAddCategory(category || recentCategoryIds[0] || "");
              setAdd(true);
            }}
          />
        )}
      </main>
      {(add || editor) && profile && (
        <ItemEditor
          recentCategoryIds={recentCategoryIds}
          mode={editor?.mode ?? "create"}
          source={editor?.item}
          categories={categories}
          categoryId={addCategory}
          profile={profile}
          close={() => {setAdd(false);setEditor(null);}}
          saved={(name, another, entry) => {
            if (!another) {setAdd(false);setEditor(null);}
            const wasEdit=editor?.mode === "edit";
            setFilters(emptyFilters);
            setQuery("");
            setSearch("");
            setCategory("");
            setTagFilters([]);
            window.dispatchEvent(new CustomEvent(TAGS_CHANGED));
            setSort("newest");
            setOffset(0);
            setRefresh((v) => v + 1);
            setSelected(null);
            setChecked([]);
            setNotice(wasEdit ? `${name} was updated.` : entry.kind === "expense" ? `${name} was recorded in Spending.` : `${name} was added to your collection.`);
          }}
        />
      )}
      {selected && profile && screen === "spending" && (
        <Dialog title="Item details" close={() => setSelected(null)} drawer>
          <ItemDetails
            key={selected}
            id={selected}
            profile={profile}
            categories={categories}
          />
        </Dialog>
      )}
      {linkedItem && profile && <Dialog title="Subscription details" close={() => { setLinkedItem(null); const url = new URL(window.location.href); url.searchParams.delete("item"); window.history.replaceState(null, "", url); }} drawer><ItemDetails key={linkedItem} id={linkedItem} profile={profile} categories={categories} /></Dialog>}
      {children}
    </div>
  );
}
