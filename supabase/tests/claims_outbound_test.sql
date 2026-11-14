-- Outbound (migration *_claims_outbound.sql, docs/plans/C-claims.md C3).
begin;
select plan(32);

-- New messages columns, all nullable so C2's and C7's rows stay valid.
select has_column('public', 'messages', c, 'messages.' || c)
from unnest(array['template', 'failure_reason', 'provider_id', 'sent_at', 'thread_references',
  'delivered_to', 'send_claimed_at']) as c;
select col_is_null('public', 'messages', c, 'messages.' || c || ' is nullable')
from unnest(array['template', 'failure_reason', 'provider_id', 'sent_at', 'thread_references',
  'delivered_to', 'send_claimed_at']) as c;

-- The generated documents bucket is private, and the API roles can't read its objects.
select is((select public from storage.buckets where id = 'claim-documents'), false,
  'the claim-documents bucket is private');
insert into storage.objects (bucket_id, name) values ('claim-documents', 'test-c3/eu_form.pdf');
set local role anon;
select is((select count(*) from storage.objects where bucket_id = 'claim-documents'), 0::bigint,
  'anon cannot see generated documents');
reset role;
set local role authenticated;
select is((select count(*) from storage.objects where bucket_id = 'claim-documents'), 0::bigint,
  'authenticated cannot see generated documents');
reset role;

-- Server only: the API roles can't call the function; the service role can.
create function pg_temp.sig() returns text language sql as $$
  select 'public.claims_send_initial_claim(uuid, timestamptz, integer, timestamptz, jsonb, jsonb)'
$$;
select ok(not has_function_privilege('anon', pg_temp.sig(), 'execute'), 'anon cannot call it');
select ok(not has_function_privilege('authenticated', pg_temp.sig(), 'execute'),
  'authenticated cannot call it');
select ok(has_function_privilege('service_role', pg_temp.sig(), 'execute'),
  'service_role can call it');

-- A ready case. Nothing here is real data.
insert into public.cases (id, public_ref, operator, status, submission, user_email,
  earliest_send_at, next_action_at)
values ('00000000-0000-0000-0000-0000000003c1', 'RTN-00C30001', 'iryo', 'waiting_period', '{}',
  'user@example.test', '2026-01-17T13:30:00Z', '2026-01-17T13:30:00Z');

create function pg_temp.msg() returns jsonb language sql as $$
  select '{"from":"reclamaciones@retren.example","to":"op@example.test",
    "subject":"[RTN-00C30001] Reclamación","body_text":"Texto",
    "message_id":"<rtn-00c30001.a@retren.example>"}'::jsonb
$$;
create function pg_temp.atts() returns jsonb language sql as $$
  select '[{"kind":"eu_form","storage_path":"claim-documents/c/eu.pdf","filename":"eu.pdf","content_type":"application/pdf","size_bytes":10},
    {"kind":"mandate","storage_path":"claim-documents/c/m.pdf","filename":"m.pdf","content_type":"application/pdf","size_bytes":10},
    {"kind":"ticket","storage_path":"tickets/t.png","filename":"t.png","content_type":"image/png","size_bytes":10}]'::jsonb
$$;
create function pg_temp.send(p_now timestamptz, p_atts jsonb default null) returns jsonb
language sql as $$
  select public.claims_send_initial_claim('00000000-0000-0000-0000-0000000003c1', p_now, 6,
    p_now + interval '12 days', pg_temp.msg(), coalesce(p_atts, pg_temp.atts()))
$$;

-- Refusals write nothing.
select is(pg_temp.send('2026-01-17T13:29:59Z'), '{"ok":false,"reason":"too_early"}'::jsonb,
  'refused before earliest_send_at');
update public.cases set send_count = 6 where id = '00000000-0000-0000-0000-0000000003c1';
select is(pg_temp.send('2026-01-18T09:00:00Z'), '{"ok":false,"reason":"send_cap_reached"}'::jsonb,
  'refused at the send cap');
update public.cases set send_count = 0, earliest_send_at = null
  where id = '00000000-0000-0000-0000-0000000003c1';
select is(pg_temp.send('2026-01-18T09:00:00Z'), '{"ok":false,"reason":"no_earliest_send_at"}'::jsonb,
  'refused when earliest_send_at is null');
update public.cases set earliest_send_at = '2026-01-17T13:30:00Z'
  where id = '00000000-0000-0000-0000-0000000003c1';
select throws_ok(
  $$select pg_temp.send('2026-01-18T09:00:00Z', (pg_temp.atts() - 2))$$, '22023', null,
  'a claim without its ticket raises');
select throws_ok(
  $$select pg_temp.send('2026-01-18T09:00:00Z',
    pg_temp.atts() - 2 || '[{"kind":"user_document","storage_path":"x","filename":"x","content_type":"x"}]'::jsonb)$$,
  '22023', null, 'a claim with an attachment that is not the ticket raises');
select is((select count(*) from public.messages where case_id = '00000000-0000-0000-0000-0000000003c1'),
  0::bigint, 'nothing was written by the refusals');

-- Sent: the row, its 3 attachments, the case and the event, at once.
select is((pg_temp.send('2026-01-18T09:00:00Z') ->> 'ok'), 'true', 'the claim is recorded');
select results_eq(
  $$select status::text, template, to_address, message_id from public.messages
    where case_id = '00000000-0000-0000-0000-0000000003c1'$$,
  $$values ('queued', 'initial_claim', 'op@example.test', '<rtn-00c30001.a@retren.example>')$$,
  'one queued initial_claim row');
select is(
  (select count(*) from public.attachments a join public.messages m on m.id = a.message_id
   where m.case_id = '00000000-0000-0000-0000-0000000003c1'),
  3::bigint, 'its 3 attachments are linked to it');
select results_eq(
  $$select status::text, sent_at, next_action_at, send_count from public.cases
    where id = '00000000-0000-0000-0000-0000000003c1'$$,
  $$values ('sent', '2026-01-18T09:00:00Z'::timestamptz, '2026-01-30T09:00:00Z'::timestamptz, 1)$$,
  'the case is sent, with sent_at, next_action_at and the send counted');
select results_eq(
  $$select kind, from_status::text, to_status::text from public.case_events
    where case_id = '00000000-0000-0000-0000-0000000003c1'$$,
  $$values ('claim_sent', 'waiting_period', 'sent')$$,
  'a claim_sent event');
select is(pg_temp.send('2026-01-18T09:00:00Z'), '{"ok":false,"reason":"not_waiting_period"}'::jsonb,
  'a second call is refused');

select * from finish();
rollback;
