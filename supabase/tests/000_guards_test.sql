-- Repo-wide database guards (docs/plans/README.md §3). Every domain's pgTAP files run next to it.
begin;
select plan(6);

-- Policies that let anon read rows unconditionally. `public` (the default when a policy has no
-- TO clause) includes anon. The condition is normalised, so `true`, `(true)` and ` TRUE ` all count.
create function pg_temp.unconditional_anon_reads() returns bigint language sql stable as $$
  select count(*)
  from pg_policies p
  where p.schemaname = 'public'
    and p.cmd in ('ALL', 'SELECT')
    and p.permissive = 'PERMISSIVE'
    and p.roles && array['anon', 'public']::name[]
    and regexp_replace(lower(coalesce(p.qual, '')), '[\s()]', '', 'g') = 'true'
$$;

select has_schema('public', 'public schema exists');

-- CLAUDE.md §3: RLS on for every table in exposed schemas.
select is(
  (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity),
  0::bigint,
  'every table in public has row level security enabled'
);

select is(pg_temp.unconditional_anon_reads(), 0::bigint, 'no public table has an unconditional anon read policy');

-- Self-test: the guard really catches what it claims to (all rolled back below).
create table public.zz_guard_probe (id int);
alter table public.zz_guard_probe enable row level security;

create policy zz_p1 on public.zz_guard_probe for select using (true); -- TO public (default)
select is(pg_temp.unconditional_anon_reads(), 1::bigint, 'guard catches USING (true) granted to public');

create policy zz_p2 on public.zz_guard_probe for all to anon using ((TRUE));
select is(pg_temp.unconditional_anon_reads(), 2::bigint, 'guard catches USING ((TRUE)) granted to anon');

create policy zz_p3 on public.zz_guard_probe for select to authenticated using (id > 0);
select is(pg_temp.unconditional_anon_reads(), 2::bigint, 'guard ignores conditional policies for other roles');

select * from finish();
rollback;
