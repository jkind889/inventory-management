-- Preserve existing purchase receipts and allow existing-item replay receipts.
alter table app.operations
  drop constraint operations_operation_type_check,
  add constraint operations_operation_type_check
    check (operation_type in ('purchase', 'existing_item'));
