-- Repo-wide database guards (docs/plans/README.md §3). Every domain's pgTAP files run next to it.
begin;
select plan(3);

select has_schema('public', 'public schema exists');

-- CLAUDE.md §3: RLS on for every table in exposed schemas.
select is(
  (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity),
  0::bigint,
  'every table in public has row level security enabled'
);

-- No table in public may be readable by anon without a policy that says so explicitly:
-- RLS enabled + zero policies means anon/authenticated see nothing.
select is(
  (
    select count(*)
    from pg_tables t
    where t.schemaname = 'public'
      and t.rowsecurity
      and exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = t.tablename
          and 'anon' = any (p.roles) and p.cmd in ('ALL', 'SELECT')
          and p.qual = 'true'
      )
  ),
  0::bigint,
  'no public table has an unconditional anon read policy'
);

select * from finish();
rollback;
