-- Item rows must exist before Storage accepts bytes. No domain tables are exposed.
create table app.item_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles(user_id) on delete cascade,
  item_id uuid not null,
  storage_path text not null unique,
  status text not null default 'pending' check (status in ('pending', 'active', 'retired')),
  byte_size integer not null check (byte_size between 1 and 5000000),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  expected_cover_id uuid,
  width integer check (width > 0), height integer check (height > 0),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  cleanup_checked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (user_id, item_id) references app.items(user_id, id) on delete cascade,
  check (storage_path = user_id::text || '/' || item_id::text || '/' || id::text),
  check (status <> 'active' or (width is not null and height is not null)),
  check (width is null or height is null or width::bigint * height::bigint <= 40000000)
);
create unique index item_photos_one_active on app.item_photos(user_id, item_id) where status = 'active';
-- Expired reservations are retired before issuing a new one.
create unique index item_photos_one_pending on app.item_photos(user_id, item_id) where status = 'pending';
create index item_photos_cleanup on app.item_photos(user_id, status, cleanup_checked_at, expires_at);
alter table app.item_photos enable row level security;
alter table app.item_photos force row level security;
revoke all on app.item_photos from public, anon, authenticated;
grant select, insert, update on app.item_photos to inventory_runtime;
create policy owner_access on app.item_photos for all to inventory_runtime
  using (user_id = (select nullif(current_setting('app.user_id', true), '')::uuid))
  with check (user_id = (select nullif(current_setting('app.user_id', true), '')::uuid));

alter table app.operations drop constraint operations_operation_type_check,
  add constraint operations_operation_type_check check (operation_type in
    ('purchase', 'existing_item', 'item_review', 'photo_upload', 'photo_complete', 'photo_remove'));

-- The helper can only read owner-filtered reservations/items; it cannot bypass RLS.
-- Read the verified Storage request JWT context (the same source as auth.uid()).
-- No new grants on the Supabase-managed auth schema are required.
create role inventory_photo_policy nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
grant inventory_photo_policy to postgres;
grant usage on schema app to inventory_photo_policy;
grant select on app.item_photos to inventory_photo_policy;
grant select (id, user_id, archived_at) on app.items to inventory_photo_policy;
create policy storage_identity on app.item_photos for select to inventory_photo_policy
  using (user_id = (select coalesce(nullif(current_setting('request.jwt.claim.sub', true), '')::uuid, (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid)));
create policy photo_storage_identity on app.items for select to inventory_photo_policy
  using (user_id = (select coalesce(nullif(current_setting('request.jwt.claim.sub', true), '')::uuid, (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid)));

create function app.photo_storage_allowed(object_path text, action text) returns boolean
language sql stable security definer set search_path = pg_catalog as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), '')::uuid, (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid) is not null and exists (
    select 1 from app.item_photos p
    where p.user_id = coalesce(nullif(current_setting('request.jwt.claim.sub', true), '')::uuid, (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid) and p.storage_path = object_path
      and case action
        when 'insert' then p.status = 'pending' and p.expires_at > now()
          and exists (select 1 from app.items i where i.id = p.item_id and i.user_id = p.user_id and i.archived_at is null)
        when 'select' then true
        when 'delete' then p.status = 'retired' or (p.status = 'pending' and p.expires_at <= now())
        else false
      end
  );
$$;
-- Changing function ownership requires temporary CREATE; revoke it immediately.
grant create on schema app to inventory_photo_policy;
alter function app.photo_storage_allowed(text, text) owner to inventory_photo_policy;
revoke create on schema app from inventory_photo_policy;
revoke all on function app.photo_storage_allowed(text, text) from public, anon;
grant execute on function app.photo_storage_allowed(text, text) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', false, 5000000, array['image/jpeg','image/png','image/webp']);
create policy item_photo_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'item-photos' and app.photo_storage_allowed(name, 'insert'));
create policy item_photo_read on storage.objects for select to authenticated
  using (bucket_id = 'item-photos' and app.photo_storage_allowed(name, 'select'));
create policy item_photo_delete on storage.objects for delete to authenticated
  using (bucket_id = 'item-photos' and app.photo_storage_allowed(name, 'delete'));
-- No UPDATE policy: upsert, replacement-in-place, and moving paths are forbidden.
