-- Account-owned reusable tags and a database-enforced five-tag limit.
BEGIN;
create table app.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles(user_id) on delete cascade,
  name text not null,
  unique (user_id, id),
  unique (user_id, name),
  constraint tag_name_valid check (
    char_length(name) between 1 and 30
    and name = lower(name)
    and name !~ U&'[\0001-\001F\007F-\009F]'
    and name = btrim(regexp_replace(name, U&'[\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g'))
  )
);
create table app.item_tags (
  user_id uuid not null,
  item_id uuid not null,
  tag_id uuid not null,
  slot smallint not null check (slot between 1 and 5),
  primary key (user_id, item_id, tag_id),
  unique (user_id, item_id, slot),
  foreign key (user_id, item_id) references app.items(user_id, id) on delete cascade,
  foreign key (user_id, tag_id) references app.tags(user_id, id) on delete cascade
);
create index item_tags_owner_tag on app.item_tags(user_id, tag_id, item_id);
alter table app.tags enable row level security;
alter table app.tags force row level security;
alter table app.item_tags enable row level security;
alter table app.item_tags force row level security;
create policy owner_access on app.tags for all to inventory_runtime
  using (user_id = nullif((select current_setting('app.user_id', true)), '')::uuid)
  with check (user_id = nullif((select current_setting('app.user_id', true)), '')::uuid);
create policy owner_access on app.item_tags for all to inventory_runtime
  using (user_id = nullif((select current_setting('app.user_id', true)), '')::uuid)
  with check (user_id = nullif((select current_setting('app.user_id', true)), '')::uuid);
grant select, insert, update on app.tags to inventory_runtime;
grant select, insert, delete on app.item_tags to inventory_runtime;
alter table app.operations drop constraint operations_operation_type_check;
alter table app.operations add constraint operations_operation_type_check check (operation_type in (
  'purchase', 'existing_item', 'item_review', 'photo_upload', 'photo_complete', 'photo_remove', 'photo_import', 'item_tags'
));
COMMIT;
