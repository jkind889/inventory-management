"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatMoney, type Category, type ItemDetail, type Profile } from "@/shared/collection";
import { ItemPhoto } from "./item-photo";
import { ItemTags } from "@/features/tags/item-tags";
import { ItemWorth } from "./item-worth";
import { ItemSubscription } from "@/features/subscriptions/subscriptions";

export function ItemDetails({ id, categories, profile }: { id: string; categories: Category[]; profile: Profile }) {
  const [response, setResponse] = useState<{ detail?: ItemDetail; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const refreshPhoto = useCallback(() => setRetry(v => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    api<ItemDetail>(`/items/${id}`, { signal: controller.signal })
      .then((detail) => { if (!controller.signal.aborted) setResponse({ detail }); })
      .catch((err) => { if (!controller.signal.aborted) setResponse({ error: errorMessage(err) }); });
    return () => controller.abort();
  }, [id, retry]);
  if (response?.error) return <div className="inspector-message" role="alert"><p>{response.error}</p><button className="button secondary" onClick={() => { setResponse(null); setRetry((v) => v + 1); }}>Try again</button></div>;
  if (!response?.detail) return <p className="inspector-message" role="status">Loading item…</p>;
  const { item, transactions, reviews } = response.detail;
  const category = categories.find((c) => c.id === item.categoryId)?.name ?? "Other";
  return <article className="item-inspector">
    <h1>{item.name}</h1>
    <p className="inspector-meta">{category}<span aria-hidden="true"> / </span>{item.state === "wishlist" ? "Future want" : "Owned"}</p>
    <ItemTags key={item.id} itemId={item.id} initial={item.tags ?? []} />
    <ItemPhoto itemId={item.id} name={item.name} category={category} cover={response.detail.cover ?? null} pending={response.detail.pendingPhoto ?? null} refresh={refreshPhoto} />
    <dl className="inspector-fields">
      <div><dt>Collection</dt><dd>{category}</dd></div>
      {item.state !== "wishlist" && <div><dt>Acquired on</dt><dd>{formatDate(item.acquiredOn)}</dd></div>}
      {item.state === "wishlist" && <>
        <div><dt>Estimated price</dt><dd>{item.targetAmountMinor === null ? "Price not estimated" : `${formatMoney(item.targetAmountMinor, profile.currency)} estimated`}</dd></div>
        <div><dt>Priority</dt><dd>{item.priority === 1 ? "High" : item.priority === 3 ? "Low" : "Medium"}</dd></div>
      </>}
      {item.description && <div><dt>Notes</dt><dd className="inspector-note">{item.description}</dd></div>}
    </dl>
    {item.productUrl && <a className="text-button" href={item.productUrl} target="_blank" rel="noopener noreferrer">View product <Icon name="arrow" size={16} /></a>}
    {item.state === "owned" && <ItemSubscription itemId={item.id} profile={profile} categories={categories} />}
    {item.state !== "wishlist" && <ItemWorth itemId={item.id} reviews={reviews} timezone={profile.timezone} />}
    <section className="inspector-purchases">
      <h2>Purchase record</h2>
      {transactions.length ? transactions.map((transaction) => <dl className="inspector-fields" key={transaction.id}>
        <div><dt>Amount</dt><dd>{formatMoney(transaction.amountMinor, transaction.currency)}</dd></div>
        <div><dt>Date</dt><dd>{formatDate(transaction.occurredOn)}</dd></div>
        {transaction.merchant && <div><dt>Store</dt><dd>{transaction.merchant}</dd></div>}
        {transaction.note && <div><dt>Notes</dt><dd className="inspector-note">{transaction.note}</dd></div>}
      </dl>) : <p className="muted">{item.state === "wishlist" ? "This is a future want. Its estimated price does not count as spending." : "No purchase recorded. This item is part of your collection without adding to your spending."}</p>}
    </section>
  </article>;
}
