-- Stream invoice status changes to authenticated merchant dashboards.
-- RLS continues to restrict delivered rows to the owning merchant.
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'invoices'
  ) then
    alter publication supabase_realtime add table public.invoices;
  end if;
end
$$;
