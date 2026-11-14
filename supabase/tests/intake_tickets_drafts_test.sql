-- Ticket storage and intake drafts (migration *_intake_tickets_drafts.sql, docs/plans/A-intake.md A1).
begin;
select plan(48);

-- The table exists, RLS is on, and no policy opens it: only the service role reaches it.
select has_table('public', 'intake_drafts', 'intake_drafts exists');
select ok((select relrowsecurity from pg_class where oid = 'public.intake_drafts'::regclass),
  'RLS is on for intake_drafts');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'intake_drafts'),
  0::bigint, 'no RLS policy opens intake_drafts to anyone');

select has_column('public', 'intake_drafts', c, 'intake_drafts.' || c)
from unnest(array['id', 'created_at', 'updated_at', 'expires_at', 'status', 'ticket_path',
  'ticket_content_type', 'ticket_filename', 'ticket_size_bytes', 'data']) as c;

-- expires_at is required (no default, not null).
select col_not_null('public', 'intake_drafts', 'expires_at', 'expires_at is NOT NULL');
select col_hasnt_default('public', 'intake_drafts', 'expires_at',
  'expires_at has no default: the server always sets it');
select throws_ok($$insert into public.intake_drafts (data) values ('{}')$$, '23502', null,
  'a draft without expires_at is refused');

-- status: an enum that later tasks can grow, starting at uploaded.
select col_type_is('public', 'intake_drafts', 'status', 'intake_draft_status',
  'status is intake_draft_status');
select ok('uploaded' = any(enum_range(null::public.intake_draft_status)::text[]),
  'intake_draft_status has the upload state');
select col_default_is('public', 'intake_drafts', 'status', 'uploaded', 'a new draft is uploaded');

-- Fixtures, inserted as the owner. Nothing here is real data.
insert into public.intake_drafts (id, created_at, expires_at, ticket_path, ticket_content_type,
  ticket_filename, ticket_size_bytes)
values ('00000000-0000-0000-0000-0000000000a1', now(), now() + interval '1 day',
  'drafts/test-a1.png', 'image/png', 'billete.png', 10);

select is((select data from public.intake_drafts where id = '00000000-0000-0000-0000-0000000000a1'),
  '{}'::jsonb, 'data defaults to an empty object');
select throws_ok($$insert into public.intake_drafts (expires_at, data) values (now() + interval '1 day', '[]')$$,
  '23514', null, 'data must be a JSON object');
select throws_ok($$insert into public.intake_drafts (created_at, expires_at) values (now(), now() - interval '1 second')$$,
  '23514', null, 'expires_at must be after created_at');
select throws_ok($$insert into public.intake_drafts (expires_at, ticket_path) values (now() + interval '1 day', 'drafts/x.png')$$,
  '23514', null, 'the ticket columns are all set or all empty');
select throws_ok($$insert into public.intake_drafts (expires_at, ticket_path, ticket_content_type, ticket_filename, ticket_size_bytes)
    values (now() + interval '1 day', 'drafts/x.gif', 'image/gif', 'x.gif', 10)$$,
  '23514', null, 'the ticket content type is one of the accepted ones');
select throws_ok($$insert into public.intake_drafts (expires_at, ticket_path, ticket_content_type, ticket_filename, ticket_size_bytes)
    values (now() + interval '1 day', 'drafts/x.png', 'image/png', 'x.png', 10485761)$$,
  '23514', null, 'the ticket is at most 10 MB');

-- anon and authenticated can't read or write drafts at all.
set local role anon;
select throws_ok($$select count(*) from public.intake_drafts$$, '42501', null, 'anon cannot read drafts');
select throws_ok($$insert into public.intake_drafts (expires_at) values (now() + interval '1 day')$$,
  '42501', null, 'anon cannot create drafts');
select throws_ok($$update public.intake_drafts set data = '{"x":1}'$$, '42501', null, 'anon cannot update drafts');
select throws_ok($$delete from public.intake_drafts$$, '42501', null, 'anon cannot delete drafts');
reset role;
set local role authenticated;
select throws_ok($$select count(*) from public.intake_drafts$$, '42501', null,
  'authenticated cannot read drafts');
select throws_ok($$insert into public.intake_drafts (expires_at) values (now() + interval '1 day')$$,
  '42501', null, 'authenticated cannot create drafts');
select throws_ok($$update public.intake_drafts set data = '{"x":1}'$$, '42501', null,
  'authenticated cannot update drafts');
select throws_ok($$delete from public.intake_drafts$$, '42501', null, 'authenticated cannot delete drafts');
reset role;

-- intake_merge_draft_data: merges a patch into data, only for the service role, only unexpired.
select ok(not has_function_privilege('anon',
  'public.intake_merge_draft_data(uuid, jsonb, public.intake_draft_status, timestamptz)', 'execute'),
  'anon cannot merge into a draft');
select ok(not has_function_privilege('authenticated',
  'public.intake_merge_draft_data(uuid, jsonb, public.intake_draft_status, timestamptz)', 'execute'),
  'authenticated cannot merge into a draft');
select ok(has_function_privilege('service_role',
  'public.intake_merge_draft_data(uuid, jsonb, public.intake_draft_status, timestamptz)', 'execute'),
  'the service role can merge into a draft');

select is((select data from public.intake_merge_draft_data('00000000-0000-0000-0000-0000000000a1',
    '{"a": 1, "b": {"c": 2}}', null, now())),
  '{"a": 1, "b": {"c": 2}}'::jsonb, 'a patch is merged into an empty draft');
select is((select data from public.intake_merge_draft_data('00000000-0000-0000-0000-0000000000a1',
    '{"b": {"d": 3}}', 'uploaded', now())),
  '{"a": 1, "b": {"d": 3}}'::jsonb, 'top-level keys of the patch replace, the others stay');
select is((select count(*) from public.intake_merge_draft_data('00000000-0000-0000-0000-0000000000a1',
    '{"late": true}', null, now() + interval '2 days')),
  0::bigint, 'an expired draft is not merged into');
select throws_ok($$select public.intake_merge_draft_data('00000000-0000-0000-0000-0000000000a1', '[1]', null, now())$$,
  '22023', null, 'a patch must be a JSON object');

-- The tickets bucket is private and limited to the accepted types and 10 MB.
select is((select public from storage.buckets where id = 'tickets'), false, 'the tickets bucket is private');
select is((select file_size_limit from storage.buckets where id = 'tickets'), 10485760::bigint,
  'the tickets bucket takes files up to 10 MB');
select is((select allowed_mime_types from storage.buckets where id = 'tickets'),
  array['image/jpeg', 'image/png', 'image/heic', 'application/pdf'],
  'the tickets bucket takes only the accepted types');
select is((select count(*) from pg_policies where schemaname = 'storage'
    and (coalesce(qual, '') ilike '%tickets%' or coalesce(with_check, '') ilike '%tickets%')),
  0::bigint, 'no storage policy names the tickets bucket');

-- anon and authenticated can't see or add ticket objects.
insert into storage.objects (bucket_id, name) values ('tickets', 'drafts/test-a1.png');
set local role anon;
select is((select count(*) from storage.objects where bucket_id = 'tickets'), 0::bigint,
  'anon cannot see tickets');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('tickets', 'drafts/anon.png')$$,
  '42501', null, 'anon cannot upload tickets');
reset role;
set local role authenticated;
select is((select count(*) from storage.objects where bucket_id = 'tickets'), 0::bigint,
  'authenticated cannot see tickets');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('tickets', 'drafts/auth.png')$$,
  '42501', null, 'authenticated cannot upload tickets');
reset role;

select * from finish();
rollback;
