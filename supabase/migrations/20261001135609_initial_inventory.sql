-- SQL migrations are authoritative. Drizzle mirrors this schema for typed queries.
create schema app;
revoke all on schema app from public, anon, authenticated;

create role inventory_runtime login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant inventory_runtime to postgres;
grant usage on schema app to inventory_runtime;
alter default privileges in schema app revoke execute on functions from public;

create type app.item_state as enum ('wishlist', 'owned', 'sold', 'returned', 'donated');

create table app.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  currency text not null default 'USD' check (currency in ('USD','EUR','GBP','CAD','AUD')),
  timezone text not null default 'America/New_York',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, currency),
  check (display_name is null or char_length(display_name) <= 120)
);

create table app.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles(user_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);
create unique index categories_owner_name on app.categories(user_id, lower(name));

create table app.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles(user_id) on delete cascade,
  category_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  description text check (char_length(description) <= 5000),
  state app.item_state not null default 'owned',
  acquired_on date,
  condition text check (char_length(condition) <= 120),
  product_url text check (product_url is null or (char_length(product_url) <= 2048 and product_url ~ '^https?://')),
  target_amount_minor bigint check (target_amount_minor between 0 and 999999999999),
  priority smallint check (priority between 1 and 3),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, category_id) references app.categories(user_id, id)
);
create index items_owner_state on app.items(user_id, state, created_at desc, id);
create index items_owner_category on app.items(user_id, category_id);

-- This first slice accepts expenses only. Refund/sale semantics arrive with their own migration.
create table app.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles(user_id) on delete cascade,
  category_id uuid not null,
  item_id uuid,
  kind text not null default 'expense' check (kind = 'expense'),
  amount_minor bigint not null check (amount_minor between 1 and 999999999999),
  currency text not null,
  occurred_on date not null,
  merchant text check (char_length(merchant) <= 200),
  note text check (char_length(note) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, currency) references app.profiles(user_id, currency),
  foreign key (user_id, category_id) references app.categories(user_id, id),
  foreign key (user_id, item_id) references app.items(user_id, id)
);
create index transactions_owner_date on app.transactions(user_id, occurred_on desc, id);
create index transactions_owner_item on app.transactions(user_id, item_id);
create index transactions_owner_category on app.transactions(user_id, category_id);
create index transactions_owner_currency on app.transactions(user_id, currency);

create table app.operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles(user_id) on delete cascade,
  idempotency_key uuid not null,
  operation_type text not null check (operation_type = 'purchase'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create function app.touch_updated_at() returns trigger
language plpgsql security invoker set search_path = pg_catalog as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function app.touch_updated_at() from public;

create trigger profiles_updated before update on app.profiles for each row execute function app.touch_updated_at();
create trigger categories_updated before update on app.categories for each row execute function app.touch_updated_at();
create trigger items_updated before update on app.items for each row execute function app.touch_updated_at();
create trigger transactions_updated before update on app.transactions for each row execute function app.touch_updated_at();

grant select, insert, update on app.profiles, app.categories, app.items to inventory_runtime;
grant select, insert on app.transactions, app.operations to inventory_runtime;

-- Identity is set with set_config(..., true) by the trusted Hono server in each transaction.
-- The login has no access to auth.users, no DDL rights, and cannot bypass RLS.
do $$
declare table_name text;
begin
  foreach table_name in array array['profiles','categories','items','transactions','operations'] loop
    execute format('alter table app.%I enable row level security', table_name);
    execute format('alter table app.%I force row level security', table_name);
    execute format(
      'create policy owner_access on app.%I for all to inventory_runtime using (user_id = (select nullif(current_setting(''app.user_id'', true), '''')::uuid)) with check (user_id = (select nullif(current_setting(''app.user_id'', true), '''')::uuid))',
      table_name
    );
  end loop;
end;
$$;
