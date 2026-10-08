"use client";

import { useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Icon } from "@/components/icon";
import { api, errorMessage } from "@/lib/api";
import { getBrowserClient } from "@/lib/supabase-browser";
import { Dialog } from "@/components/dialog";
import { CategoryArtwork as Artwork } from "@/components/category-artwork";
import { CollectionOverviewScreen } from "./collection-overview";
import { WantsScreen } from "@/features/wants/wants-screen";
import { SpendingScreen } from "@/features/spending/spending-screen";
import { currencies } from "@/shared/contracts";
import {
  getSubmissionAttempt,
  type SubmissionAttempt,
} from "@/shared/submission";
import {
  formatDate,
  formatMoney,
  parsePrice,
  type Category,
  type CollectionResponse,
  type ItemDetail,
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
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name")).trim();
    const common = {
      name,
      categoryId: String(form.get("category")),
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
          <button className="button primary" disabled={busy}>
            {busy ? "Adding…" : "Add item"}
            <Icon name="plus" size={18} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function Details({
  id,
  categories,
  close,
  profile,
}: {
  profile: Profile;
  id: string;
  categories: Category[];
  close: () => void;
}) {
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<ItemDetail>(`/items/${id}`, {
      signal: controller.signal,
    })
      .then(setDetail)
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [id, retry]);
  const category =
    categories.find((c) => c.id === detail?.item.categoryId)?.name ?? "Other";
  return (
    <Dialog title="Item details" close={close} drawer>
      {error ? (
        <div role="alert" className="form-message error">
          {error}
          <button
            className="text-button"
            onClick={() => {
              setError("");
              setRetry((v) => v + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : !detail ? (
        <p role="status">Loading item…</p>
      ) : (
        <>
          <Artwork category={category} />
          <p className="eyebrow detail-category">{category}</p>
          <h3 className="detail-name">{detail.item.name}</h3>
          <p className="muted">
            {detail.item.state === "wishlist"
              ? "Future want"
              : `Owned · ${formatDate(detail.item.acquiredOn)}`}
          </p>
          {detail.item.state === "wishlist" && (
            <div className="want-detail">
              <p>
                {detail.item.targetAmountMinor === null
                  ? "Price not estimated"
                  : `${formatMoney(detail.item.targetAmountMinor, profile.currency)} estimated`}
              </p>
              <p>
                Priority:{" "}
                {detail.item.priority === 1
                  ? "High"
                  : detail.item.priority === 3
                    ? "Low"
                    : "Medium"}
              </p>
              {detail.item.productUrl && (
                <a
                  className="text-button"
                  href={detail.item.productUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View product <Icon name="arrow" size={16} />
                </a>
              )}
            </div>
          )}
          {detail.item.description && (
            <p className="detail-note">{detail.item.description}</p>
          )}
          <section className="purchase-history">
            <h4>Purchase record</h4>
            {detail.transactions.length ? (
              detail.transactions.map((t) => (
                <article key={t.id} className="receipt">
                  <div>
                    <strong>{formatMoney(t.amountMinor, t.currency)}</strong>
                    <span>{formatDate(t.occurredOn)}</span>
                  </div>
                  {t.merchant && <p>{t.merchant}</p>}
                  {t.note && <p className="detail-note muted">{t.note}</p>}
                </article>
              ))
            ) : (
              <p className="muted">
                {detail.item.state === "wishlist"
                  ? "This is a future want. Its estimated price does not count as spending."
                  : "No purchase recorded. This item is part of your collection without adding to your spending."}
              </p>
            )}
          </section>
        </>
      )}
    </Dialog>
  );
}
export function CollectionScreen({ user }: { user: User }) {
  const [screen, setScreen] = useState<"collection" | "spending" | "wants">(
    "collection",
  );
  const [browsing, setBrowsing] = useState(false);
  const [addCategory, setAddCategory] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [setupError, setSetupError] = useState("");
  const [setupRetry, setSetupRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("newest");
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState("grid");
  const [completedRequest, setCompletedRequest] = useState<{
    key: string;
    result: CollectionResponse | null;
    error: string;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
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
    refresh,
  ]);
  const requestPending = completedRequest?.key !== requestKey;
  const loading = query !== search || requestPending;
  const result = completedRequest?.result ?? null;
  const error = loading ? "" : (completedRequest?.error ?? "");
  useEffect(() => {
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
    if (!profile || !browsing || screen !== "collection") return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      q: search,
      sort,
      limit: "12",
      offset: String(offset),
    });
    if (category) params.set("categoryId", category);
    api<CollectionResponse>(`/collection?${params}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) {
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
  }, [profile, search, sort, offset, category, requestKey, browsing, screen]);
  function filter(id: string) {
    setCategory(id);
    setOffset(0);
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
    <div className="collection-shell">
      <header className="space-header">
        <button
          className="space-brand"
          onClick={() => {
            setScreen("collection");
            setBrowsing(false);
          }}
        >
          My space
        </button>
        <div className="space-account">
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
        </div>
      </header>
      <nav className="space-tabs" aria-label="Main navigation">
        <button
          aria-current={screen === "collection" ? "page" : undefined}
          onClick={() => {
            setScreen("collection");
            setBrowsing(false);
          }}
        >
          Collections
        </button>
        <button
          aria-current={screen === "spending" ? "page" : undefined}
          onClick={() => setScreen("spending")}
        >
          Spending
        </button>
        <button
          aria-current={screen === "wants" ? "page" : undefined}
          onClick={() => setScreen("wants")}
        >
          Future Wants
        </button>
      </nav>
      <main className="collection-main">
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
        ) : !profile ? (
          <p role="status">Opening your space…</p>
        ) : screen === "spending" ? (
          <SpendingScreen profile={profile} openItem={setSelected} />
        ) : screen === "wants" ? (
          <WantsScreen
            profile={profile}
            categories={categories}
            openItem={setSelected}
          />
        ) : !browsing ? (
          <CollectionOverviewScreen
            profile={profile}
            refresh={refresh}
            openItem={setSelected}
            openCollection={(id) => {
              filter(id);
              setQuery("");
              setSearch("");
              setBrowsing(true);
            }}
            addItem={(id) => {
              setAddCategory(id);
              setAdd(true);
            }}
          />
        ) : (
          <>
            <header className="collection-heading">
              <div>
                <button
                  className="text-button back-to-collections"
                  onClick={() => setBrowsing(false)}
                >
                  <Icon name="arrow" className="previous-arrow" size={16} /> All
                  collections
                </button>
                <h1>
                  {categories.find((c) => c.id === category)?.name ??
                    "All items"}
                </h1>
                <p className="muted">Everything in your collection.</p>
              </div>
              <button
                className="button secondary"
                onClick={() => {
                  setAddCategory(category);
                  setAdd(true);
                }}
              >
                <Icon name="plus" size={18} /> Add item
              </button>
            </header>
            <div className="collection-toolbar">
              <label className="search-field">
                <Icon name="search" />
                <input
                  aria-label="Search your collection"
                  placeholder="Search your collection…"
                  value={query}
                  maxLength={200}
                  onChange={(e) => {
                    setQuery(e.target.value);
                  }}
                />
              </label>
              <select
                className="mobile-category"
                aria-label="Filter category"
                value={category}
                onChange={(e) => filter(e.target.value)}
              >
                <option value="">All items</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Sort collection"
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="newest">Recently added</option>
                <option value="name">Name A–Z</option>
                <option value="purchased">Purchase date</option>
              </select>
              <div className="view-switch">
                <button
                  className="icon-button"
                  aria-label="Grid view"
                  aria-pressed={view === "grid"}
                  onClick={() => setView("grid")}
                >
                  <Icon name="grid" />
                </button>
                <button
                  className="icon-button"
                  aria-label="List view"
                  aria-pressed={view === "list"}
                  onClick={() => setView("list")}
                >
                  <Icon name="list" />
                </button>
              </div>
            </div>
            <div className="collection-count" role="status">
              {loading
                ? "Loading your collection…"
                : `${result?.total ?? 0} ${(result?.total ?? 0) === 1 ? "item" : "items"}`}
            </div>
            {error ? (
              <div className="empty-state" role="alert">
                <h2>Something didn’t load.</h2>
                <p>{error}</p>
                <button
                  className="button secondary"
                  onClick={() => {
                    setRefresh((v) => v + 1);
                  }}
                >
                  Try again
                </button>
              </div>
            ) : loading ? (
              <div className="item-grid" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div className="skeleton" key={i} />
                ))}
              </div>
            ) : !result?.data.length ? (
              <div className="empty-state">
                <span className="empty-icon">
                  <Icon name="box" size={44} />
                </span>
                <h2>
                  {search || category
                    ? "No items found."
                    : "A little space for your things."}
                </h2>
                <p>
                  {search || category
                    ? "Try a different search or category."
                    : "Start with something you love, or your most recent purchase."}
                </p>
                <button
                  className="button secondary"
                  onClick={() => {
                    if (search || category) {
                      setQuery("");
                      filter("");
                    } else setAdd(true);
                  }}
                >
                  {search || category ? "Clear filters" : "Add your first item"}
                </button>
              </div>
            ) : (
              <div className={view === "grid" ? "item-grid" : "item-list"}>
                {result.data.map((item) => {
                  const cat =
                    categories.find((c) => c.id === item.categoryId)?.name ??
                    "Other";
                  return (
                    <button
                      className="item-card"
                      key={item.id}
                      onClick={() => setSelected(item.id)}
                    >
                      <Artwork category={cat} small={view === "list"} />
                      <div className="item-copy">
                        <h2>{item.name}</h2>
                        <p>{cat}</p>
                        <div className="item-footer">
                          <span>
                            {item.recordedCostMinor === null
                              ? "Price not recorded"
                              : formatMoney(
                                  item.recordedCostMinor,
                                  profile!.currency,
                                )}
                          </span>
                          <span>{formatDate(item.acquiredOn)}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {!loading && result && result.total > 12 && (
              <div className="pagination">
                <span>
                  {offset + 1}–{Math.min(offset + 12, result.total)} of{" "}
                  {result.total}
                </span>
                <button
                  className="button secondary"
                  disabled={offset === 0}
                  onClick={() => {
                    setOffset((v) => v - 12);
                  }}
                >
                  Previous
                </button>
                <button
                  className="button secondary"
                  disabled={offset + 12 >= result.total}
                  onClick={() => {
                    setOffset((v) => v + 12);
                  }}
                >
                  Next
                </button>
              </div>
            )}
          </>
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
            setSort("newest");
            setOffset(0);
            setRefresh((v) => v + 1);
            setNotice(`${name} was added to your collection.`);
          }}
        />
      )}
      {selected && profile && (
        <Details
          key={selected}
          id={selected}
          profile={profile}
          categories={categories}
          close={() => setSelected(null)}
        />
      )}
    </div>
  );
}
