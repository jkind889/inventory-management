-- Standalone spending keeps its own label without requiring an inventory item.
-- Existing transactions and saved purchase receipts remain unchanged.
alter table app.transactions add column name text;
alter table app.transactions add constraint transactions_name_check
  check (name is null or (name = btrim(name) and char_length(name) between 1 and 200));

alter table app.operations drop constraint operations_operation_type_check;
alter table app.operations add constraint operations_operation_type_check
  check (operation_type in ('purchase', 'expense', 'existing_item', 'item_review', 'photo_upload', 'photo_complete', 'photo_remove', 'photo_import', 'item_tags', 'subscription_create', 'subscription_edit', 'subscription_advance', 'subscription_stop', 'reminder_preferences', 'item_edit', 'bulk_edit', 'preferences', 'collection_import', 'collection_restore'));
