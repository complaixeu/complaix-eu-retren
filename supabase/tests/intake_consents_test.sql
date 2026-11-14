-- Consent evidence (migration *_intake_consents.sql, docs/plans/A-intake.md A6).
begin;
select plan(43);

-- The table exists, RLS is on, and no policy opens it.
select has_table('public', 'consents', 'consents exists');
select ok((select relrowsecurity from pg_class where oid = 'public.consents'::regclass),
  'RLS is on for consents');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'consents'),
  0::bigint, 'no RLS policy opens consents to anyone');

select has_column('public', 'consents', c, 'consents.' || c)
from unnest(array['id', 'draft_id', 'accepted_at', 'text_version', 'ip', 'trip_snapshot', 'created_at']) as c;

-- The evidence the legal section asks for: when, which text, from where, which trip.
select col_not_null('public', 'consents', 'accepted_at', 'accepted_at is NOT NULL');
select col_not_null('public', 'consents', 'text_version', 'text_version is NOT NULL');
select col_not_null('public', 'consents', 'trip_snapshot', 'trip_snapshot is NOT NULL');
-- created_at orders consents with the same accepted_at (latestConsent): set by the database.
select col_not_null('public', 'consents', 'created_at', 'created_at is NOT NULL');
select col_default_is('public', 'consents', 'created_at', 'clock_timestamp()',
  'created_at defaults to clock_timestamp(), so rows in one transaction still differ');
select col_is_null('public', 'consents', 'ip', 'ip may be null (no address in the headers)');
select col_type_is('public', 'consents', 'ip', 'inet', 'ip is an inet');
select col_type_is('public', 'consents', 'trip_snapshot', 'jsonb', 'trip_snapshot is jsonb');
select fk_ok('public', 'consents', 'draft_id', 'public', 'intake_drafts', 'id',
  'draft_id references intake_drafts');

-- Fixtures, inserted as the owner. Nothing here is real data.
insert into public.intake_drafts (id, created_at, expires_at, data)
values ('00000000-0000-0000-0000-0000000000c1', now(), now() + interval '1 day', '{}');
insert into public.consents (id, draft_id, accepted_at, text_version, ip, trip_snapshot)
values ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000000c1', now(),
  'mandato-test', '203.0.113.7', '{"ticket": {"bookingRef": "TEST01"}}');

select throws_ok($$insert into public.consents (draft_id, accepted_at, text_version, trip_snapshot)
    values ('00000000-0000-0000-0000-0000000000c1', null, 'mandato-test', '{}')$$,
  '23502', null, 'a consent without accepted_at is refused');
select throws_ok($$insert into public.consents (draft_id, accepted_at, text_version, trip_snapshot)
    values ('00000000-0000-0000-0000-0000000000c1', now(), null, '{}')$$,
  '23502', null, 'a consent without text_version is refused');
select throws_ok($$insert into public.consents (draft_id, accepted_at, text_version, trip_snapshot)
    values ('00000000-0000-0000-0000-0000000000c1', now(), '', '{}')$$,
  '23514', null, 'text_version is not empty');
select throws_ok($$insert into public.consents (draft_id, accepted_at, text_version, trip_snapshot)
    values ('00000000-0000-0000-0000-0000000000c1', now(), 'mandato-test', '[]')$$,
  '23514', null, 'trip_snapshot is a JSON object');
select throws_ok($$insert into public.consents (draft_id, accepted_at, text_version, ip, trip_snapshot)
    values ('00000000-0000-0000-0000-0000000000c1', now(), 'mandato-test', 'not-an-ip', '{}')$$,
  '22P02', null, 'ip must be an address');
select throws_ok($$insert into public.consents (draft_id, accepted_at, text_version, trip_snapshot)
    values ('00000000-0000-0000-0000-0000000000ff', now(), 'mandato-test', '{}')$$,
  '23503', null, 'a consent needs an existing draft');

-- Insert-only, even for the owner: no UPDATE, no DELETE, no TRUNCATE.
select throws_ok($$update public.consents set text_version = 'otra' where id = '00000000-0000-0000-0000-00000000c0a1'$$,
  'P0001', 'consents is insert-only', 'the owner cannot update a consent');
select throws_ok($$update public.consents set created_at = now() where id = '00000000-0000-0000-0000-00000000c0a1'$$,
  'P0001', 'consents is insert-only', 'the owner cannot change created_at');
select throws_ok($$update public.consents set draft_id = null where id = '00000000-0000-0000-0000-00000000c0a1'$$,
  'P0001', 'consents is insert-only', 'the owner cannot unlink a consent from a live draft');
select throws_ok($$delete from public.consents where id = '00000000-0000-0000-0000-00000000c0a1'$$,
  'P0001', 'consents is insert-only', 'the owner cannot delete a consent');
select throws_ok($$truncate public.consents$$,
  'P0001', 'consents is insert-only', 'the owner cannot truncate consents');

-- anon and authenticated can't read or write consents at all.
set local role anon;
select throws_ok($$select count(*) from public.consents$$, '42501', null, 'anon cannot read consents');
select throws_ok($$insert into public.consents (draft_id, accepted_at, text_version, trip_snapshot)
    values ('00000000-0000-0000-0000-0000000000c1', now(), 'x', '{}')$$,
  '42501', null, 'anon cannot create consents');
select throws_ok($$update public.consents set text_version = 'x'$$, '42501', null, 'anon cannot update consents');
select throws_ok($$delete from public.consents$$, '42501', null, 'anon cannot delete consents');
reset role;
set local role authenticated;
select throws_ok($$select count(*) from public.consents$$, '42501', null,
  'authenticated cannot read consents');
select throws_ok($$insert into public.consents (draft_id, accepted_at, text_version, trip_snapshot)
    values ('00000000-0000-0000-0000-0000000000c1', now(), 'x', '{}')$$,
  '42501', null, 'authenticated cannot create consents');
select throws_ok($$update public.consents set text_version = 'x'$$, '42501', null,
  'authenticated cannot update consents');
select throws_ok($$delete from public.consents$$, '42501', null, 'authenticated cannot delete consents');
reset role;

-- The service role only inserts and reads.
select ok(has_table_privilege('service_role', 'public.consents', 'insert'), 'the service role can insert');
select ok(has_table_privilege('service_role', 'public.consents', 'select'), 'the service role can read');
select ok(not has_table_privilege('service_role', 'public.consents', 'update'),
  'the service role has no UPDATE privilege');
select ok(not has_table_privilege('service_role', 'public.consents', 'delete'),
  'the service role has no DELETE privilege');

-- The evidence outlives its draft (A7 deletes the draft after submit, the purge deletes expired
-- ones): deleting the draft unlinks the consent and keeps everything else.
set local role service_role;
delete from public.intake_drafts where id = '00000000-0000-0000-0000-0000000000c1';
reset role;
select results_eq(
  $$select draft_id, text_version, host(ip), trip_snapshot, created_at is not null from public.consents
    where id = '00000000-0000-0000-0000-00000000c0a1'$$,
  $$values (null::uuid, 'mandato-test'::text, '203.0.113.7'::text, '{"ticket": {"bookingRef": "TEST01"}}'::jsonb, true)$$,
  'deleting the draft keeps the consent, unlinked');

select * from finish();
rollback;
