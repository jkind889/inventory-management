ALTER TABLE "app"."operations"
  DROP CONSTRAINT "operations_operation_type_check";

ALTER TABLE "app"."operations"
  ADD CONSTRAINT "operations_operation_type_check"
    CHECK
    ((operation_type = ANY (ARRAY['purchase'::text, 'existing_item'::text, 'item_review'::text, 'photo_upload'::text, 'photo_complete'::text, 'photo_remove'::text,
    'photo_import'::text])));
