begin;
-- Keyset pagination keeps skipped accounts from monopolizing the first page.
create or replace function app.reminder_accounts(as_of timestamptz, after_user_id uuid) returns table(user_id uuid)
language sql stable security definer set search_path = pg_catalog as $$
  select p.user_id from app.profiles p
  left join app.reminder_preferences r on r.user_id = p.user_id
  where (after_user_id is null or p.user_id > after_user_id)
  and (exists (select 1 from app.reminder_digests d where d.user_id=p.user_id and d.status in ('pending','processing')
    and (d.lease_until is null or d.lease_until <= as_of) and (d.retry_after is null or d.retry_after <= as_of))
  or (r.enabled and not r.blocked and extract(hour from as_of at time zone p.timezone) >= 9
    and not exists(select 1 from app.reminder_digests d where d.user_id=p.user_id and d.local_date=(as_of at time zone p.timezone)::date)
    and exists(select 1 from app.subscriptions s join app.items i on i.user_id=s.user_id and i.id=s.item_id
      join app.categories c on c.user_id=i.user_id and c.id=i.category_id
      where s.user_id=p.user_id and s.status <> 'stopped' and s.email_enabled and s.reminder_days is not null
      and i.state='owned' and i.archived_at is null and c.archived_at is null
      and (s.ends_on is null or s.next_due_on <= s.ends_on)
      and s.next_due_on between (as_of at time zone p.timezone)::date and (as_of at time zone p.timezone)::date+s.reminder_days
      and not exists(select 1 from app.reminder_deliveries e where e.user_id=s.user_id and e.subscription_id=s.id and e.due_on=s.next_due_on))))
  order by p.user_id limit 50;
$$;
revoke all on function app.reminder_accounts(timestamptz,uuid) from public,anon,authenticated;
grant execute on function app.reminder_accounts(timestamptz,uuid) to inventory_runtime;

-- Keep the original first-page signature for existing callers during rollout.
create or replace function app.reminder_accounts(as_of timestamptz) returns table(user_id uuid)
language sql stable security definer set search_path = pg_catalog as $$
  select * from app.reminder_accounts(as_of, null::uuid);
$$;
revoke all on function app.reminder_accounts(timestamptz) from public,anon,authenticated;
grant execute on function app.reminder_accounts(timestamptz) to inventory_runtime;
commit;
