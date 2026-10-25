"use client";
import { useEffect, useState } from "react";
import { ItemEditor } from "@/features/collection/item-editor";
import { Icon, categoryIcon } from "@/components/icon";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatMoney, type Category, type Profile } from "@/shared/collection";
import {
  currentMonth,
  monthRange,
  shiftMonth,
  spendingShare,
  type SpendingSummary,
  type TransactionHistory,
} from "@/shared/spending";
const PAGE_SIZE = 10;
export function SpendingScreen({
  profile,
  categories,
  openItem,
}: {
  profile: Profile;
  categories: Category[];
  openItem: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const [month, setMonth] = useState(() => currentMonth(profile.timezone));
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    summary: SpendingSummary;
    history: TransactionHistory;
  } | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const { from, to } = monthRange(month);
  const requestKey = `${month}:${offset}:${retry}`;
  const loading = result?.key !== requestKey && failure?.key !== requestKey;
  const error = failure?.key === requestKey ? failure.message : "";
  const label = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${from}T12:00:00Z`));
  useEffect(() => {
    const controller = new AbortController();
    const range = new URLSearchParams({ from, to });
    const page = new URLSearchParams({
      from,
      to,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    Promise.all([
      api<SpendingSummary>(`/spending/summary?${range}`, {
        signal: controller.signal,
      }),
      api<TransactionHistory>(`/transactions?${page}`, {
        signal: controller.signal,
      }),
    ])
      .then(([summary, history]) => {
        if (!controller.signal.aborted) {
          setResult({ key: requestKey, summary, history });
          setFailure(null);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setFailure({ key: requestKey, message: errorMessage(err) });
      });
    return () => controller.abort();
  }, [from, to, offset, requestKey]);
  function selectMonth(value: string) {
    if (!value) return;
    try {
      monthRange(value);
    } catch {
      return;
    }
    setMonth(value);
    setOffset(0);
  }
  const summary = result?.summary;
  const history = result?.history;
  const breakdown = summary?.breakdown.toSorted((a, b) =>
    BigInt(a.amountMinor) > BigInt(b.amountMinor)
      ? -1
      : BigInt(a.amountMinor) < BigInt(b.amountMinor)
        ? 1
        : a.categoryId.localeCompare(b.categoryId),
  );
  return (
    <>
      <header className="collection-heading spending-heading">
        <div>
          <h1>Spending</h1>
          <p className="muted">A clearer picture of your purchases.</p>
        </div>
        <div className="spending-actions">
          <button className="button primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={18} /> Add purchase
          </button>
        <div className="month-control">
          <button
            className="icon-button"
            aria-label="Previous month"
            disabled={month === "1900-01"}
            onClick={() => selectMonth(shiftMonth(month, -1))}
          >
            <Icon name="arrow" className="previous-arrow" />
          </button>
          <input
            type="month"
            aria-label="Spending month"
            min="1900-01"
            max="9999-12"
            value={month}
            onChange={(e) => selectMonth(e.target.value)}
          />
          <button
            className="icon-button"
            aria-label="Next month"
            disabled={month === "9999-12"}
            onClick={() => selectMonth(shiftMonth(month, 1))}
          >
            <Icon name="arrow" />
          </button>
        </div>
        </div>
      </header>
      {notice && <p className="form-message" role="status">{notice}</p>}
      {adding && <ItemEditor
        profile={profile}
        categories={categories}
        categoryId={categories.find(category => category.name.toLowerCase() === "groceries")?.id ?? categories[0]?.id ?? ""}
        initialEntry="expense"
        close={() => setAdding(false)}
        saved={(name, another, entry) => {
          if (!another) setAdding(false);
          if (entry.kind !== "owned") selectMonth(entry.occurredOn.slice(0, 7));
          setOffset(0);
          setRetry(value => value + 1);
          setNotice(entry.kind === "owned" ? `${name} was added to your collection.` : `${name} was recorded in Spending.`);
        }}
      />}
      {error ? (
        <div className="empty-state" role="alert">
          <h2>We couldn’t load your spending.</h2>
          <p>{error}</p>
          <button
            className="button secondary"
            onClick={() => setRetry((v) => v + 1)}
          >
            Try again
          </button>
        </div>
      ) : loading ? (
        <div className="spending-loading" role="status">
          <p className="muted">Loading spending for {label}…</p>
          <div className="skeleton" aria-hidden="true" />
        </div>
      ) : summary && history ? (
        <>
          <section
            className="spending-overview"
            aria-label={`Spending summary for ${label}`}
          >
            <div className="spending-total">
              <p className="muted">Total spent</p>
              <p className="spending-amount">
                {formatMoney(summary.grossSpendingMinor, summary.currency)}
              </p>
              <p className="muted">
                {history.total} recorded{" "}
                {history.total === 1 ? "purchase" : "purchases"}
              </p>
              <p className="field-help">
                {label} · {profile.currency}
              </p>
            </div>
            <div className="spending-breakdown">
              <h2>By category</h2>
              {breakdown?.length ? (
                breakdown.map((row) => {
                  const name = row.categoryName;
                  return (
                    <div className="category-spend" key={row.categoryId}>
                      <div>
                        <span>{name}</span>
                        <strong>
                          {formatMoney(row.amountMinor, summary.currency)}
                        </strong>
                      </div>
                      <div className="spending-bar" aria-hidden="true">
                        <span
                          style={{
                            width: `${spendingShare(row.amountMinor, summary.grossSpendingMinor)}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="muted">
                  Your category breakdown will appear when you record a
                  purchase.
                </p>
              )}
            </div>
          </section>
          <section className="spending-history">
            <header>
              <h2>Purchase history</h2>
              <p className="muted">
                {formatDate(from)} – {formatDate(to)}
              </p>
            </header>
            {history.total === 0 ? (
              <div className="empty-state">
                <Icon name="calendar" size={40} />
                <h2>No purchases this month.</h2>
                <p>
                  Record a purchase with or without a collection item. It will
                  appear here on its purchase date.
                </p>
              </div>
            ) : (
              <>
                <div className="spending-table-wrap">
                  <table className="spending-table">
                    <thead>
                      <tr>
                        <th scope="col">Purchase</th>
                        <th scope="col">Category</th>
                        <th scope="col">Date</th>
                        <th scope="col">Amount</th>
                        <th scope="col">
                          <span className="sr-only">Item details</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.data.map((t) => (
                        <tr key={t.id}>
                          <td>
                            <div className="purchase-name">
                              <span
                                className={`purchase-icon tone-${t.categoryName.toLowerCase()}`}
                              >
                                <Icon
                                  name={categoryIcon(t.categoryName)}
                                  size={20}
                                />
                              </span>
                              <div>
                                <strong>
                                  {t.itemName ?? t.name ?? t.merchant ?? "Expense"}
                                </strong>
                                <span className="mobile-transaction-meta">
                                  {t.categoryName} · {formatDate(t.occurredOn)}
                                </span>
                                {(t.itemName || t.name) && t.merchant && (
                                  <span>{t.merchant}</span>
                                )}
                                {!t.itemId && <span>Purchase only</span>}
                                {t.note && (
                                  <span className="transaction-note">
                                    {t.note}
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td>{t.categoryName}</td>
                          <td>{formatDate(t.occurredOn)}</td>
                          <td className="transaction-amount">
                            {formatMoney(t.amountMinor, t.currency)}
                          </td>
                          <td>
                            {t.itemId && !t.itemArchivedAt && (
                              <button
                                className="icon-button"
                                aria-label={`Open ${t.itemName ?? "item"} details`}
                                onClick={() => openItem(t.itemId!)}
                              >
                                <Icon name="arrow" size={18} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {history.total > PAGE_SIZE && (
                  <div className="pagination">
                    <span>
                      {offset + 1}–{Math.min(offset + PAGE_SIZE, history.total)}{" "}
                      of {history.total}
                    </span>
                    <button
                      className="button secondary"
                      disabled={offset === 0}
                      onClick={() => setOffset((v) => v - PAGE_SIZE)}
                    >
                      Previous
                    </button>
                    <button
                      className="button secondary"
                      disabled={offset + PAGE_SIZE >= history.total}
                      onClick={() => setOffset((v) => v + PAGE_SIZE)}
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
            <p className="spending-footnote">
              Recorded purchases only. Items added as already owned do not count
              toward spending.
            </p>
          </section>
        </>
      ) : null}
    </>
  );
}
