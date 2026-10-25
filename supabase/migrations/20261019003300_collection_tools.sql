-- Private, account-scoped preferences; financial records remain immutable.
create table app.collection_preferences (
  user_id uuid primary key references app.profiles(user_id) on delete cascade,
  saved_views jsonb not null default '[]'::jsonb check (jsonb_typeof(saved_views) = 'array' and jsonb_array_length(saved_views) <= 30),
  recent_category_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(recent_category_ids) = 'array' and jsonb_array_length(recent_category_ids) <= 6),
  updated_at timestamptz not null default now()
);
alter table app.collection_preferences enable row level security;
alter table app.collection_preferences force row level security;
revoke all on app.collection_preferences from public, anon, authenticated;
create policy owner_access on app.collection_preferences for all to inventory_runtime
  using (user_id = (select nullif(current_setting('app.user_id', true), '')::uuid))
  with check (user_id = (select nullif(current_setting('app.user_id', true), '')::uuid));
grant select, insert, update on app.collection_preferences to inventory_runtime;
create trigger collection_preferences_updated before update on app.collection_preferences
  for each row execute function app.touch_updated_at();
alter table app.operations drop constraint operations_operation_type_check;
alter table app.operations add constraint operations_operation_type_check
  check (operation_type in ('purchase', 'existing_item', 'item_review', 'photo_upload', 'photo_complete', 'photo_remove', 'photo_import', 'item_tags', 'subscription_create', 'subscription_edit', 'subscription_advance', 'subscription_stop', 'reminder_preferences', 'item_edit', 'bulk_edit', 'preferences', 'collection_import', 'collection_restore'));
