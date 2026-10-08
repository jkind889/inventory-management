-- Add the category for existing accounts without changing any item or expense.
insert into app.categories (user_id, name)
select user_id, 'Subscriptions' from app.profiles
on conflict do nothing;

-- Append-only check-ins preserve how an item's perceived value changes over time.
create table app.item_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles(user_id) on delete cascade,
  item_id uuid not null,
  verdict text not null check (verdict in ('worth_it', 'not_worth_it', 'unsure')),
  usage_frequency text check (usage_frequency in ('daily', 'weekly', 'monthly', 'rarely', 'never')),
  would_buy_again boolean,
  note text check (char_length(note) <= 5000),
  created_at timestamptz not null default now(),
  foreign key (user_id, item_id) references app.items(user_id, id) on delete cascade
);
create index item_reviews_owner_item_date on app.item_reviews(user_id, item_id, created_at desc, id desc);
alter table app.item_reviews enable row level security;
alter table app.item_reviews force row level security;
revoke all on app.item_reviews from public, anon, authenticated;
grant select, insert on app.item_reviews to inventory_runtime;
create policy owner_access on app.item_reviews for all to inventory_runtime
  using (user_id = (select nullif(current_setting('app.user_id', true), '')::uuid))
  with check (user_id = (select nullif(current_setting('app.user_id', true), '')::uuid));

alter table app.operations
  drop constraint operations_operation_type_check,
  add constraint operations_operation_type_check
    check (operation_type in ('purchase', 'existing_item', 'item_review'));
