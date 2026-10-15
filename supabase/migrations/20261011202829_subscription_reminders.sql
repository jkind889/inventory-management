begin;
create table app.subscriptions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references app.profiles(user_id) on delete cascade,
  item_id uuid not null, amount_minor bigint not null check (amount_minor between 0 and 999999999999), currency text not null,
  interval_unit text not null check (interval_unit in ('month','year')),
  billing_anchor_on date not null check (billing_anchor_on between '1900-01-01' and '9999-12-31'),
  next_period integer not null check (next_period between 0 and 10000), next_due_on date not null check (next_due_on between '1900-01-01' and '9999-12-31'),
  reminder_days smallint check (reminder_days in (0,1,3,7,14,30)),
  service_url text check (service_url is null or (char_length(service_url) <= 2048 and service_url ~ '^https://')),
  email_enabled boolean not null default true, status text not null default 'active' check (status in ('active','ending','stopped')),
  ends_on date check (ends_on between '1900-01-01' and '9999-12-31'), revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id,id), unique(user_id,item_id),
  foreign key (user_id,item_id) references app.items(user_id,id) on delete cascade,
  foreign key (user_id,currency) references app.profiles(user_id,currency),
  check ((status = 'ending') = (ends_on is not null)),
  check (next_due_on = (billing_anchor_on + (next_period * case interval_unit when 'month' then interval '1 month' else interval '1 year' end))::date)
);
create index subscriptions_owner_status_due on app.subscriptions(user_id,status,next_due_on,id);
create index subscriptions_owner_currency on app.subscriptions(user_id,currency);
create trigger subscriptions_updated before update on app.subscriptions for each row execute function app.touch_updated_at();
create table app.renewal_resolutions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, subscription_id uuid not null, due_on date not null,
  created_at timestamptz not null default now(), unique(user_id,subscription_id,due_on),
  foreign key (user_id,subscription_id) references app.subscriptions(user_id,id) on delete cascade
);
create table app.reminder_preferences (
  user_id uuid primary key references app.profiles(user_id) on delete cascade, enabled boolean not null default false,
  blocked boolean not null default false, revision integer not null default 1 check (revision > 0), unsubscribe_nonce uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create trigger reminder_preferences_updated before update on app.reminder_preferences for each row execute function app.touch_updated_at();
create table app.reminder_digests (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references app.profiles(user_id) on delete cascade,
  local_date date not null, recipient text not null,
  status text not null default 'pending' check (status in ('pending','processing','accepted','delivered','suppressed','failed','uncertain','bounced','complained')),
  payload jsonb, entries jsonb not null check (jsonb_typeof(entries) = 'array'), lease_until timestamptz, first_attempt_at timestamptz,
  retry_after timestamptz, attempts integer not null default 0 check (attempts >= 0), provider_id text unique, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,id), unique(user_id,local_date), check (first_attempt_at is null or payload is not null)
);
create index reminder_digests_pending on app.reminder_digests(status,retry_after,lease_until) where status in ('pending','processing');
create trigger reminder_digests_updated before update on app.reminder_digests for each row execute function app.touch_updated_at();
create table app.reminder_deliveries (
  user_id uuid not null, subscription_id uuid not null, due_on date not null, reminder_days smallint not null check (reminder_days in (0,1,3,7,14,30)),
  digest_id uuid not null,
  primary key (user_id,subscription_id,due_on),
  foreign key (user_id,subscription_id) references app.subscriptions(user_id,id) on delete cascade,
  foreign key (user_id,digest_id) references app.reminder_digests(user_id,id) on delete cascade
);
create index reminder_deliveries_digest on app.reminder_deliveries(user_id,digest_id);
create table app.reminder_webhook_events (
  event_id text primary key check (char_length(event_id) between 1 and 200), received_at timestamptz not null default now()
);
alter table app.reminder_webhook_events enable row level security;
alter table app.reminder_webhook_events force row level security;
revoke all on app.reminder_webhook_events from public,anon,authenticated;
-- No direct runtime grants: a narrow function below claims verified event IDs.
do $$ declare relation text; begin
  foreach relation in array array['subscriptions','renewal_resolutions','reminder_preferences','reminder_digests','reminder_deliveries'] loop
    execute format('alter table app.%I enable row level security',relation);
    execute format('alter table app.%I force row level security',relation);
    execute format('revoke all on app.%I from public,anon,authenticated',relation);
    execute format('create policy owner_access on app.%I for all to inventory_runtime using (user_id = nullif((select current_setting(''app.user_id'',true)),'''')::uuid) with check (user_id = nullif((select current_setting(''app.user_id'',true)),'''')::uuid)',relation);
  end loop;
end $$;
grant select,insert,update on app.subscriptions,app.reminder_preferences,app.reminder_digests to inventory_runtime;
grant select,insert on app.renewal_resolutions to inventory_runtime;
grant select,insert,delete on app.reminder_deliveries to inventory_runtime;

-- Worker discovery is deliberately narrow. Domain mutations still use the existing RLS role.
-- These functions live in an unexposed schema and cannot be called by API clients.
create function app.reminder_accounts(as_of timestamptz) returns table(user_id uuid)
language sql stable security definer set search_path = pg_catalog as $$
  select p.user_id from app.profiles p
  left join app.reminder_preferences r on r.user_id = p.user_id
  where exists (select 1 from app.reminder_digests d where d.user_id=p.user_id and d.status in ('pending','processing')
    and (d.lease_until is null or d.lease_until <= as_of) and (d.retry_after is null or d.retry_after <= as_of))
  or (r.enabled and not r.blocked and extract(hour from as_of at time zone p.timezone) >= 9
    and not exists(select 1 from app.reminder_digests d where d.user_id=p.user_id and d.local_date=(as_of at time zone p.timezone)::date)
    and exists(select 1 from app.subscriptions s join app.items i on i.user_id=s.user_id and i.id=s.item_id
      join app.categories c on c.user_id=i.user_id and c.id=i.category_id
      where s.user_id=p.user_id and s.status <> 'stopped' and s.email_enabled and s.reminder_days is not null
      and i.state='owned' and i.archived_at is null and c.archived_at is null
      and (s.ends_on is null or s.next_due_on <= s.ends_on)
      and s.next_due_on between (as_of at time zone p.timezone)::date and (as_of at time zone p.timezone)::date+s.reminder_days
      and not exists(select 1 from app.reminder_deliveries e where e.user_id=s.user_id and e.subscription_id=s.id and e.due_on=s.next_due_on)))
  order by p.user_id limit 50;
$$;
create function app.reminder_identity() returns table(email text, verified boolean)
language sql stable security definer set search_path = pg_catalog as $$
  select u.email::text, (u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false))
  from auth.users u where u.id=nullif(current_setting('app.user_id',true),'')::uuid;
$$;
create function app.reminder_event_owner(provider_email_id text, digest_id uuid default null) returns uuid
language sql stable security definer set search_path = pg_catalog as $$
  select user_id from app.reminder_digests where provider_id=provider_email_id
    or (id=digest_id and first_attempt_at is not null) limit 1;
$$;
create function app.claim_reminder_webhook(event_key text) returns boolean
language plpgsql security definer set search_path = pg_catalog as $$
begin
  insert into app.reminder_webhook_events(event_id) values(event_key) on conflict do nothing;
  return found;
end $$;
revoke all on function app.reminder_accounts(timestamptz),app.reminder_identity(),app.reminder_event_owner(text,uuid),app.claim_reminder_webhook(text) from public,anon,authenticated;
grant execute on function app.reminder_accounts(timestamptz),app.reminder_identity(),app.reminder_event_owner(text,uuid),app.claim_reminder_webhook(text) to inventory_runtime;

alter table app.operations drop constraint operations_operation_type_check;
alter table app.operations add constraint operations_operation_type_check check (operation_type in (
  'purchase','existing_item','item_review','photo_upload','photo_complete','photo_remove','photo_import','item_tags',
  'subscription_create','subscription_edit','subscription_advance','subscription_stop','reminder_preferences'
));
commit;
