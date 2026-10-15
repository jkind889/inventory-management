"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatMoney, parsePrice, type Category, type Profile } from "@/shared/collection";
import { getSubmissionAttempt, type SubmissionAttempt } from "@/shared/submission";
import { isAttention, reminderDays, renewalOn, renewalState, renewalStateLabels, calendarToday, type Subscription, type SubscriptionsResponse } from "@/shared/subscriptions";

export const SUBSCRIPTIONS_CHANGED = "inventory:subscriptions-changed";
function changed() { window.dispatchEvent(new Event(SUBSCRIPTIONS_CHANGED)); }
export function useSubscriptions(enabled = true) {
  const [data, setData] = useState<SubscriptionsResponse | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    api<SubscriptionsResponse>("/subscriptions", { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setData(value); setError(""); } })
      .catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [revision, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const focus = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener(SUBSCRIPTIONS_CHANGED, refresh);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    const timer = window.setInterval(focus, 60000);
    return () => { window.removeEventListener(SUBSCRIPTIONS_CHANGED, refresh); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); window.clearInterval(timer); };
  }, [refresh, enabled]);
  return { data, error, refresh };
}
function useSubmission() {
  const attempt = useRef<SubmissionAttempt | null>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit<T>(path: string, input: unknown): Promise<T | undefined> {
    if (pending.current) return;
    const body = JSON.stringify(input);
    attempt.current = getSubmissionAttempt(attempt.current, path, body);
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await api<T>(path, { method: "POST", body, headers: { "Idempotency-Key": attempt.current.key } });
      attempt.current = null; changed(); return result;
    } catch (reason) { setError(errorMessage(reason)); }
    finally { pending.current = false; setBusy(false); }
  }
  return { submit, busy, error, clear: () => { attempt.current = null; setError(""); } };
}
function SubscriptionForm({ initial, itemId, categories, profile, saved, cancel }: {
  initial?: Subscription; itemId?: string; categories: Category[]; profile: Profile;
  saved: (subscription: Subscription) => void; cancel: () => void;
}) {
  const { submit, busy, error } = useSubmission();
  const [validation, setValidation] = useState("");
  const [anchor, setAnchor] = useState(initial?.billingAnchorOn ?? "");
  const [unit, setUnit] = useState<"month" | "year">(initial?.intervalUnit ?? "month");
  const [period, setPeriod] = useState(initial?.nextPeriod ?? 0);
  const [requestedDue, setRequestedDue] = useState(initial?.nextDueOn ?? "");
  let nextDate = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(anchor)) { try { nextDate = renewalOn(anchor, unit, period); } catch { /* Form validation explains the invalid date. */ } }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setValidation("");
    if (nextDate !== requestedDue) { setValidation("The next renewal must follow the billing anchor and schedule. Adjust the anchor for a new schedule."); return; }
    const fields = new FormData(event.currentTarget);
    const price = String(fields.get("price"));
    const amountMinor = /^0(?:\.0{1,2})?$/.test(price.trim()) ? 0 : parsePrice(price);
    if (amountMinor === null) { setValidation("Enter an expected price with up to two decimal places."); return; }
    const schedule = { amountMinor, intervalUnit: unit, billingAnchorOn: anchor, nextPeriod: period,
      reminderDays: fields.get("reminderDays") === "off" ? null : Number(fields.get("reminderDays")),
      serviceUrl: String(fields.get("serviceUrl") ?? "").trim() || null, emailEnabled: fields.get("emailEnabled") === "on" };
    const path = initial ? `/subscriptions/${initial.id}/edit` : "/subscriptions";
    const input = initial ? { revision: initial.revision, schedule } : itemId ? { itemId, schedule } : { name: fields.get("name"), categoryId: fields.get("categoryId"), schedule };
    const result = await submit<{ subscription: Subscription }>(path, input);
    if (result) saved(result.subscription);
  }
  return <form className="subscription-form" onSubmit={save}>
    <fieldset disabled={busy}><legend>{initial ? "Edit renewal tracking" : "Set up renewal tracking"}</legend>
      {!initial && !itemId && <>
        <label>Service name<input name="name" required maxLength={200} placeholder="e.g. Music subscription" /></label>
        <label>Collection<select name="categoryId" defaultValue={categories.find(row => row.name.toLowerCase() === "subscriptions")?.id ?? categories[0]?.id}>{categories.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
      </>}
      <div className="subscription-form-grid">
        <label>Expected price ({profile.currency})<input name="price" inputMode="decimal" required defaultValue={initial ? (initial.amountMinor / 100).toFixed(2) : ""} placeholder="0.00" /></label>
        <label>Billing schedule<select value={unit} onChange={event => { setUnit(event.target.value as "month" | "year"); setPeriod(0); setRequestedDue(anchor); }}><option value="month">Monthly</option><option value="year">Yearly</option></select></label>
      </div>
      <label>Billing anchor date<input type="date" required min="1900-01-01" max="9999-12-31" value={anchor} onChange={event => { setAnchor(event.target.value); setPeriod(0); setRequestedDue(event.target.value); }} /></label>
      <p className="muted">Use the original billing day to preserve month-end and leap-year renewals. For a new schedule, enter the next renewal date here.</p>
      <label>Next renewal date<input type="date" required min={anchor || "1900-01-01"} max="9999-12-31" value={requestedDue} onChange={event => {
        const due = event.target.value; setRequestedDue(due);
        if (anchor && due) {
          const [anchorYear, anchorMonth] = anchor.split("-").map(Number), [dueYear, dueMonth] = due.split("-").map(Number);
          const months = (dueYear - anchorYear) * 12 + dueMonth - anchorMonth;
          const candidate = unit === "year" ? months / 12 : months;
          if (Number.isInteger(candidate) && candidate >= 0 && candidate <= 10000) setPeriod(candidate);
        }
      }} /></label>
      <p className="subscription-preview" role="status">Next renewal: <strong>{nextDate ? formatDate(nextDate) : "Choose a billing date"}</strong></p>
      <label>Remind me<select name="reminderDays" defaultValue={initial?.reminderDays === null ? "off" : String(initial?.reminderDays ?? 7)}>
        {reminderDays.map(days => <option key={days} value={days}>{days === 0 ? "On renewal day" : `${days} ${days === 1 ? "day" : "days"} before`}</option>)}<option value="off">Reminders off</option>
      </select></label>
      <label>Manage subscription link <span className="muted">(optional)</span><input name="serviceUrl" type="url" pattern="https://.*" maxLength={2048} placeholder="https://…" defaultValue={initial?.serviceUrl ?? ""} /></label>
      <label className="subscription-check"><input type="checkbox" name="emailEnabled" defaultChecked={initial?.emailEnabled ?? true} />Include in reminder emails when account email is enabled</label>
    </fieldset>
    <p className="muted">This saves expected renewals. It does not add a payment to Spending.</p>
    {(error || validation) && <p role="alert" className="form-message error">{error || validation}</p>}
    <div className="worth-actions"><button className="button" disabled={busy || !nextDate}>{busy ? "Saving…" : "Save tracking"}</button><button className="button secondary" type="button" disabled={busy} onClick={cancel}>Cancel</button></div>
  </form>;
}

export function SubscriptionControls({ subscription: initial, profile, categories }: { subscription: Subscription; profile: Profile; categories: Category[] }) {
  const [subscription, setSubscription] = useState(initial);
  const [mode, setMode] = useState<"view" | "edit" | "advance" | "stop">("view");
  const [message, setMessage] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const { submit, busy, error, clear } = useSubmission();
  const state = renewalState(subscription, calendarToday(profile.timezone));
  async function action(kind: "advance" | "stop") {
    const input = kind === "advance" ? { revision: subscription.revision, dueOn: subscription.nextDueOn } : { revision: subscription.revision, endsOn: endsOn || null };
    const result = await submit<{ subscription: Subscription }>(`/subscriptions/${subscription.id}/${kind}`, input);
    if (result) { setSubscription(result.subscription); setMode("view"); setMessage(kind === "advance" ? "Renewal advanced. No payment recorded." : "Tracking updated. Cancel the service with its provider if needed."); }
  }
  const switchMode = (value: typeof mode) => { clear(); setMode(value); setMessage(""); };
  return <section className="subscription-controls" aria-label="Subscription tracking">
    <div className="subscription-title"><h2>Renewal tracking</h2><span className={`renewal-badge state-${state}`}>{renewalStateLabels[state]}</span></div>
    <dl className="inspector-fields"><div><dt>Expected price</dt><dd>{formatMoney(subscription.amountMinor, subscription.currency)} / {subscription.intervalUnit}</dd></div><div><dt>Next renewal</dt><dd>{formatDate(subscription.nextDueOn)}</dd></div>
      <div><dt>Reminder</dt><dd>{subscription.reminderDays === null ? "Off" : subscription.reminderDays === 0 ? "On renewal day" : `${subscription.reminderDays} days before`}</dd></div>
      {subscription.endsOn && <div><dt>Track through</dt><dd>{formatDate(subscription.endsOn)}</dd></div>}
    </dl>
    {subscription.serviceUrl && <a className="text-button" href={subscription.serviceUrl} target="_blank" rel="noopener noreferrer">Manage with provider ↗</a>}
    {message && <p role="status" className="worth-saved">{message}</p>}
    {mode === "edit" ? <SubscriptionForm initial={subscription} profile={profile} categories={categories} cancel={() => switchMode("view")} saved={value => { setSubscription(value); setMode("view"); setMessage("Tracking saved."); }} /> : mode === "advance" ? <div className="subscription-confirm">
      <p>Resolve the renewal dated {formatDate(subscription.nextDueOn)} and advance one billing period? This only updates tracking and records no payment.</p>
      <div className="worth-actions"><button className="button" disabled={busy} onClick={() => action("advance")}>Confirm advance</button><button className="button secondary" disabled={busy} onClick={() => switchMode("view")}>Cancel</button></div>
    </div> : mode === "stop" ? <div className="subscription-confirm">
      <p>This stops reminders in this app. Cancel the service with its provider separately.</p>
      <label>Last renewal date to track <span className="muted">(leave blank to stop now)</span><input type="date" min="1900-01-01" max="9999-12-31" value={endsOn} onChange={event => setEndsOn(event.target.value)} /></label>
      <div className="worth-actions"><button className="button" disabled={busy} onClick={() => action("stop")}>Save stop date</button><button className="button secondary" disabled={busy} onClick={() => switchMode("view")}>Cancel</button></div>
    </div> : state !== "stopped" ? <div className="worth-actions"><button className="button secondary" onClick={() => switchMode("edit")}>Edit tracking</button><button className="button secondary" onClick={() => switchMode("advance")}>Advance to next renewal</button><button className="text-button" onClick={() => switchMode("stop")}>Stop tracking</button></div> : null}
    {error && <p role="alert" className="form-message error">{error} <button className="text-button" onClick={changed}>Reload reminders</button></p>}
  </section>;
}

export function ItemSubscription({ itemId, profile, categories }: { itemId: string; profile: Profile; categories: Category[] }) {
  const [result, setResult] = useState<{ subscription: Subscription | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision(value => value + 1);
    window.addEventListener(SUBSCRIPTIONS_CHANGED, update);
    return () => window.removeEventListener(SUBSCRIPTIONS_CHANGED, update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<{ subscription: Subscription | null }>(`/subscriptions/items/${itemId}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) { setResult(value); setError(""); } }).catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [itemId, revision]);
  if (error) return <section className="subscription-controls"><p role="alert">{error}</p><button className="button secondary" onClick={() => setRevision(value => value + 1)}>Reload tracking</button></section>;
  if (!result) return <p className="muted">Loading renewal tracking…</p>;
  if (result.subscription) return <SubscriptionControls key={`${result.subscription.id}:${result.subscription.revision}`} subscription={result.subscription} profile={profile} categories={categories} />;
  return <section className="subscription-controls"><h2>Renewal tracking</h2>{editing ? <SubscriptionForm itemId={itemId} profile={profile} categories={categories} cancel={() => setEditing(false)} saved={subscription => { setResult({ subscription }); setEditing(false); }} /> : <><p className="muted">Track this item’s subscription renewal and get a reminder before it renews.</p><button className="button secondary" onClick={() => setEditing(true)}>Set up renewal tracking</button></>}</section>;
}

export function RenewalsPanel({ data, error, refresh, profile, categories, openItem }: {
  data: SubscriptionsResponse | null; error: string; refresh: () => void; profile: Profile; categories: Category[]; openItem: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const { submit, busy, error: preferenceError } = useSubmission();
  async function toggleEmail() {
    if (!data) return;
    await submit("/reminders/preferences", { enabled: !data.preferences.enabled, revision: data.preferences.revision });
  }
  const active = data?.data.filter(row => row.state !== "stopped") ?? [];
  const stopped = data?.data.filter(row => row.state === "stopped") ?? [];
  return <section className="renewals-panel" aria-label="Upcoming renewals">
    <div className="subscription-title"><div><p className="eyebrow">SUBSCRIPTIONS</p><h1>Upcoming renewals</h1></div><button className="button secondary" onClick={() => setAdding(true)}>Add subscription</button></div>
    <p className="muted">A little time to decide what you want to keep. Expected prices stay separate from Spending.</p>
    {adding && <SubscriptionForm profile={profile} categories={categories} cancel={() => setAdding(false)} saved={value => { setAdding(false); openItem(value.itemId); }} />}
    {error ? <p role="alert">{error} <button className="text-button" onClick={refresh}>Try again</button></p> : !data ? <p role="status">Loading renewals…</p> : <>
      <div className="reminder-email-settings"><div><h2>Reminder emails</h2><p>{data.preferences.enabled ? `On · Daily digest around 9 a.m. (${profile.timezone}) when there are new reminders.` : "Off · Enable a daily digest when there are new reminders."}</p>{data.preferences.emailReason && <p>{data.preferences.emailReason}</p>}{data.preferences.blocked && <p>Email paused after a delivery problem.</p>}</div>
        <button className="button secondary" disabled={busy || (!data.preferences.enabled && (!data.preferences.emailAvailable || data.preferences.blocked))} onClick={toggleEmail}>{busy ? "Saving…" : data.preferences.enabled ? "Turn email off" : "Enable email reminders"}</button>
      </div>
      {preferenceError && <p role="alert" className="form-message error">{preferenceError}</p>}
      {!active.length ? <div className="renewals-empty"><h2>No upcoming renewals yet.</h2><p>Add a subscription, or open an existing item and choose “Set up renewal tracking.”</p></div> : <div className="renewal-list">{active.map(row => <button className="renewal-row" key={row.id} onClick={() => openItem(row.itemId)}><span><strong>{row.name}</strong><small>{formatMoney(row.amountMinor, row.currency)} expected / {row.intervalUnit}</small></span><span><time>{formatDate(row.nextDueOn)}</time><small className={`renewal-badge state-${row.state}`}>{renewalStateLabels[row.state]}</small></span></button>)}</div>}
      {stopped.length > 0 && <details className="worth-history"><summary>Stopped tracking ({stopped.length})</summary>{stopped.map(row => <button className="renewal-row" key={row.id} onClick={() => openItem(row.itemId)}>{row.name}<span>Tracking stopped</span></button>)}</details>}
      {data.data.some(row => isAttention(row.state) && row.state === "overdue") && <p className="muted">Past due means the tracked date has passed. It does not indicate whether the service charged you.</p>}
    </>}
  </section>;
}
