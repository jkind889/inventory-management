"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Icon, categoryIcon } from "@/components/icon";
import { CategoryArtwork } from "@/components/category-artwork";
import {
  formatDate,
  formatMoney,
  type CollectionOverview,
  type Profile,
} from "@/shared/collection";
export function CollectionOverviewScreen({
  profile,
  refresh,
  openItem,
  openCollection,
  addItem,
}: {
  profile: Profile;
  refresh: number;
  openItem: (id: string) => void;
  openCollection: (id: string) => void;
  addItem: (category: string) => void;
}) {
  const [retry, setRetry] = useState(0);
  const key = `${refresh}:${retry}`;
  const [completed, setCompleted] = useState<{
    key: string;
    result?: CollectionOverview;
    error?: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<CollectionOverview>("/collections/overview", {
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
  }, [key]);
  const ready = completed?.key === key;
  return (
    <>
      <header className="collection-heading overview-heading">
        <div>
          <h1>Your collections</h1>
          <p className="muted">Two latest purchases from each collection.</p>
        </div>
        <button className="button secondary" onClick={() => addItem("")}>
          <span>Add item</span>
          <Icon name="plus" size={18} />
        </button>
      </header>
      {!ready ? (
        <div
          className="collection-blocks"
          role="status"
          aria-label="Loading collections"
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton" />
          ))}
        </div>
      ) : completed.error ? (
        <div className="empty-state" role="alert">
          <h2>Collections couldn’t load.</h2>
          <p>{completed.error}</p>
          <button
            className="button secondary"
            onClick={() => setRetry((v) => v + 1)}
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="collection-blocks">
          {completed.result?.data.map(({ category, total, latest }) => (
            <section
              className="collection-block"
              key={category.id}
              aria-label={`${category.name} collection`}
            >
              <div className="block-body">
                <header className="block-heading">
                  <h2>{category.name}</h2>
                  <span>
                    {total} {total === 1 ? "item" : "items"}
                  </span>
                </header>
                <p className="block-date">
                  {latest[0]
                    ? `Latest purchase · ${formatDate(latest[0].purchasedOn)}`
                    : "No purchases yet"}
                </p>
                {latest.length ? (
                  <div className="purchase-pair">
                    {latest.map((item) => (
                      <button
                        className="purchase-preview"
                        key={item.id}
                        onClick={() => openItem(item.id)}
                      >
                        <CategoryArtwork category={category.name} />
                        <h3>{item.name}</h3>
                        <p>
                          {item.recordedCostMinor === null
                            ? "Price not recorded"
                            : formatMoney(
                                item.recordedCostMinor,
                                profile.currency,
                              )}{" "}
                          · {formatDate(item.purchasedOn)}
                        </p>
                      </button>
                    ))}
                    {latest.length === 1 && (
                      <button
                        className="next-purchase"
                        onClick={() => addItem(category.id)}
                      >
                        <span>
                          <Icon name="plus" size={38} />
                        </span>
                        <p>Your next purchase</p>
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="block-empty">
                    <Icon name={categoryIcon(category.name)} size={54} />
                    <p>
                      {total
                        ? "Your items are here. No purchases recorded yet."
                        : "No purchases yet"}
                    </p>
                    <button
                      className="button secondary"
                      onClick={() => addItem(category.id)}
                    >
                      Add item <Icon name="plus" size={16} />
                    </button>
                  </div>
                )}
              </div>
              <footer className="block-footer">
                <button onClick={() => openCollection(category.id)}>
                  View collection <Icon name="arrow" size={20} />
                </button>
                <button
                  aria-label={`Add item to ${category.name}`}
                  onClick={() => addItem(category.id)}
                >
                  <Icon name="plus" size={20} />
                </button>
              </footer>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
