-- Keep current_setting directly inside the init-plan subquery for the advisor
-- and evaluate the stable account identity once per SQL statement.
do $$
declare table_name text;
begin
  foreach table_name in array array['profiles','categories','items','transactions','operations'] loop
    execute format(
      'alter policy owner_access on app.%I using (user_id = nullif((select current_setting(''app.user_id'', true)), '''')::uuid) with check (user_id = nullif((select current_setting(''app.user_id'', true)), '''')::uuid)',
      table_name
    );
  end loop;
end;
$$;
