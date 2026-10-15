"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { Icon } from "@/components/icon";
import { api, errorMessage } from "@/lib/api";
import { getBrowserClient } from "@/lib/supabase-browser";
import { TagPicker } from "@/features/tags/tag-controls";
import { TAGS_CHANGED, type Tag } from "@/shared/tags";
import { Dialog } from "@/components/dialog";
import { CollectionWorkbench } from "./collection-workbench";
import { ItemDetails } from "./item-details";
import { WantsScreen } from "@/features/wants/wants-screen";
import { SpendingScreen } from "@/features/spending/spending-screen";
import { SUBSCRIPTIONS_CHANGED } from "@/features/subscriptions/subscriptions";
import { currencies } from "@/shared/contracts";
import {
  getSubmissionAttempt,
  type SubmissionAttempt,
} from "@/shared/submission";
import {
  parsePrice,
  starterCategories,
  type Category,
  type CollectionResponse,
  type Profile,
} from "@/shared/collection";
function AddItem({
  categories,
  profile,
  close,
  saved,
  categoryId,
}: {
  categories: Category[];
  profile: Profile;
  close: () => void;
  saved: (name: string) => void;
  categoryId: string;
}) {
  const [purchase, setPurchase] = useState(true);
  const [tags, setTags] = useState<string[]>([]);
  const [pendingTag, setPendingTag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<SubmissionAttempt | null>(null);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: profile.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || pendingTag) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name")).trim();
    const common = {
      name,
      categoryId: String(form.get("category")),
      ...(tags.length ? { tags } : {}),
    };
    const note = String(form.get("note") || "").trim() || null;
    const amountMinor = parsePrice(String(form.get("price") || ""));
    if (purchase && amountMinor === null) {
      setError(
        "Enter a price greater than zero, with up to two decimal places.",
      );
      return;
    }
    const payload = purchase
      ? {
          ...common,
          amountMinor,
          currency: profile.currency,
          occurredOn: String(form.get("date")),
          merchant: String(form.get("merchant") || "").trim() || null,
          note,
        }
      : {
          ...common,
          acquiredOn: String(form.get("date") || "") || null,
          description: note,
        };
    const body = JSON.stringify(payload);
    const path = purchase ? "/purchases" : "/items";
    attempt.current = getSubmissionAttempt(attempt.current, path, body);
    setBusy(true);
    setError("");
    try {
      await api(path, {
        method: "POST",
        body,
        headers: {
          "Idempotency-Key": attempt.current.key,
        },
      });
      attempt.current = null;
      saved(name);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <Dialog title="Add to your collection" close={close} busy={busy}>
      <p className="muted">Give the things you own a home.</p>
      <div className="segmented">
        <button
          aria-pressed={purchase}
          disabled={busy}
          onClick={() => {
            setPurchase(true);
            setError("");
          }}
        >
          New purchase
        </button>
        <button
          aria-pressed={!purchase}
          disabled={busy}
          onClick={() => {
            setPurchase(false);
            setError("");
          }}
        >
          Already owned
        </button>
      </div>
      <p className="field-help">
        {purchase
          ? "Record an item and its purchase together."
          : "Add something you own without recording new spending."}
      </p>
      <form onSubmit={submit} className="item-form">
        <fieldset disabled={busy} key={String(purchase)}>
          <label className="field">
            Item name
            <input
              name="name"
              required
              maxLength={200}
              placeholder="e.g. Everyday headphones"
              autoFocus
            />
          </label>
          <label className="field">
            Category
            <select
              name="category"
              required
              defaultValue={categoryId || categories[0]?.id}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-row">
            {purchase && (
              <label className="field">
                Price ({profile.currency})
                <input
                  name="price"
                  required
                  inputMode="decimal"
                  placeholder="0.00"
                  maxLength={13}
                />
              </label>
            )}
            <label className="field">
              {purchase ? "Purchase date" : "Acquired on (optional)"}
              <input
                name="date"
                type="date"
                min="1900-01-01"
                required={purchase}
                defaultValue={purchase ? today : ""}
              />
            </label>
          </div>
          {purchase && (
            <label className="field">
              Store (optional)
              <input
                name="merchant"
                maxLength={200}
                placeholder="Where did you find it?"
              />
            </label>
          )}
          <label className="field">
            Notes (optional)
            <textarea
              name="note"
              maxLength={5000}
              rows={3}
              placeholder="Anything you’d like to remember."
            />
          </label>
        </fieldset>
        <TagPicker value={tags} onChange={setTags} pendingChanged={setPendingTag} disabled={busy} />
        {error && (
          <p className="form-message error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy || pendingTag}>
            {busy ? "Adding…" : "Add item"}
            <Icon name="plus" size={18} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
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
  }, [profile, search, sort, offset, category, tagFilters, requestKey, screen]);
  useEffect(() => {
    const changed = () => { setRefresh(value => value + 1); setOffset(0); };
    window.addEventListener(TAGS_CHANGED, changed);
    return () => window.removeEventListener(TAGS_CHANGED, changed);
  }, []);
  function filter(id: string) {
    setCategory(id);
    setOffset(0);
    setSelected(null);
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
          onClick={() => {
            setScreen("collection");
            setSelected(null);
          }}
        >
          marscorp
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
          <SpendingScreen profile={profile} openItem={setSelected} />
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
            changeTags={(tags) => { setTagFilters(tags); setOffset(0); setSelected(null); }}
            sort={sort}
            offset={offset}
            selected={selected}
            refresh={refresh}
            openItem={setSelected}
            filter={filter}
            changeQuery={(value) => {
              setQuery(value);
              setSelected(null);
            }}
            changeSort={(value) => {
              setSort(value);
              setOffset(0);
              setSelected(null);
            }}
            changePage={(value) => {
              setOffset(value);
              setSelected(null);
            }}
            retry={() => setRefresh((v) => v + 1)}
            addItem={() => {
              if (!user) { onAuthenticate("signup"); return; }
              setAddCategory(category);
              setAdd(true);
            }}
          />
        )}
      </main>
      {add && profile && (
        <AddItem
          categories={categories}
          categoryId={addCategory}
          profile={profile}
          close={() => setAdd(false)}
          saved={(name) => {
            setAdd(false);
            setQuery("");
            setSearch("");
            setCategory("");
            setTagFilters([]);
            window.dispatchEvent(new CustomEvent(TAGS_CHANGED));
            setSort("newest");
            setOffset(0);
            setRefresh((v) => v + 1);
            setSelected(null);
            setNotice(`${name} was added to your collection.`);
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
