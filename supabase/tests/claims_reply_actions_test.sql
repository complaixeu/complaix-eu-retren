-- Actions per reply category (migration *_claims_reply_actions.sql, docs/plans/C-claims.md C6).
-- Nothing here is real data. op@operator.example is the operator, user@example.test the user.
begin;
select plan(81);

-- Server only: the API roles can't call any of the functions; the service role can.
create function pg_temp.sigs() returns setof text language sql as $$
  values
    ('public.claims_max_sends_per_case()'),
    ('public.claims_case_operator_address(uuid)'),
    ('public.claims_apply_reply_action(uuid, uuid, public.reply_category, public.case_status, integer, jsonb)'),
    ('public.claims_queue_for_team(uuid, uuid, public.reply_category, text)'),
    ('public.claims_forward_user_document(uuid, uuid, integer, jsonb, timestamptz)'),
    ('public.claims_mark_forwarded_documents_deleted(uuid)')
$$;
select ok(not has_function_privilege('anon', s, 'execute'), 'anon cannot call ' || s) from pg_temp.sigs() s;
select ok(not has_function_privilege('authenticated', s, 'execute'), 'authenticated cannot call ' || s)
  from pg_temp.sigs() s;
select ok(has_function_privilege('service_role', s, 'execute'), 'service_role can call ' || s)
  from pg_temp.sigs() s;

-- Every function runs as the caller (no SECURITY DEFINER) with an empty search_path.
select ok(not p.prosecdef and p.proconfig @> array['search_path=""'],
  p.proname || ' is security invoker with an empty search_path')
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('claims_max_sends_per_case', 'claims_case_operator_address',
    'claims_apply_reply_action', 'claims_queue_for_team', 'claims_forward_user_document',
    'claims_mark_forwarded_documents_deleted');

select is(public.claims_max_sends_per_case(), 6, 'the send cap is MAX_SENDS_PER_CASE (6)');
select has_index('public', 'case_events', 'case_events_insistence_once', 'the one-insistence index exists');

-- The user-document bucket: private, and no storage policy opens it to the API roles.
select results_eq(
  $$select public from storage.buckets where id = 'claims-user-documents'$$,
  $$values (false)$$,
  'the claims-user-documents bucket exists and is private'
);
select is(
  (select count(*) from pg_policies where schemaname = 'storage'
    and (coalesce(qual, '') || coalesce(with_check, '')) like '%claims-user-documents%'),
  0::bigint, 'no storage policy names the user-document bucket'
);
insert into storage.objects (bucket_id, name) values ('claims-user-documents', 'case/doc.pdf');
-- Lift Supabase's own guard against direct deletes, so only RLS and grants decide below.
set local storage.allow_delete_query = 'true';

set local role anon;
select is((select count(*) from storage.objects where bucket_id = 'claims-user-documents'), 0::bigint,
  'anon sees no user document');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('claims-user-documents', 'anon.pdf')$$,
  '42501', null, 'anon cannot upload a user document');
do $$ begin
  delete from storage.objects where bucket_id = 'claims-user-documents';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update storage.objects set name = 'moved-by-anon.pdf' where bucket_id = 'claims-user-documents';
exception when insufficient_privilege then null; end $$;
reset role;
select results_eq(
  $$select name from storage.objects where bucket_id = 'claims-user-documents'$$,
  $$values ('case/doc.pdf')$$, 'anon cannot delete or update a user document');

set local role authenticated;
select is((select count(*) from storage.objects where bucket_id = 'claims-user-documents'), 0::bigint,
  'authenticated sees no user document');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('claims-user-documents', 'auth.pdf')$$,
  '42501', null, 'authenticated cannot upload a user document');
do $$ begin
  delete from storage.objects where bucket_id = 'claims-user-documents';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update storage.objects set name = 'moved-by-auth.pdf' where bucket_id = 'claims-user-documents';
exception when insufficient_privilege then null; end $$;
reset role;
select results_eq(
  $$select name from storage.objects where bucket_id = 'claims-user-documents'$$,
  $$values ('case/doc.pdf')$$, 'authenticated cannot delete or update a user document');
set local storage.allow_delete_query = 'false';

-- A case with an operator reply; a002 is the initial claim, which fixes the operator address.
insert into public.cases (id, operator, submission, user_email, status, send_count)
values ('00000000-0000-4000-8000-0000000000c6', 'iryo', '{}', 'user@example.test', 'reply_received', 1);
insert into public.messages (id, case_id, direction, from_address, to_address, subject, status, created_at)
values
  ('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-0000000000c6', 'outbound',
   'retren@example.test', 'op@operator.example', '[RTN-X] claim', 'sent', now() - interval '10 days'),
  ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-0000000000c6', 'inbound',
   'op@operator.example', 'retren@example.test', '[RTN-X] denied', 'received', now());

create function pg_temp.insist(expected_status text, expected_count int,
  recipient text default 'op@operator.example') returns jsonb language sql as $$
  select public.claims_apply_reply_action(
    '00000000-0000-4000-8000-0000000000c6', '00000000-0000-4000-8000-00000000a001', 'denied',
    expected_status::public.case_status, expected_count,
    jsonb_build_object(
      'steps', '[{"event":"rejected","from":"reply_received","to":"denied"},
                 {"event":"insistence_sent","from":"denied","to":"sent"}]'::jsonb,
      'outbox', jsonb_build_array(jsonb_build_object(
        'audience', 'operator', 'template', 'insistence_after_denial',
        'from', 'retren@example.test', 'to', recipient,
        'subject', '[RTN-X] insistence', 'body_text', 'text')),
      'next_action_at', '2030-01-01T00:00:00Z'))
$$;

-- Rules a plan can't break. Each one rolls back everything (the case stays as it was).
select throws_ok($$select pg_temp.insist('sent', 1)$$, '40001', null,
  'a case read in another status is refused (the caller re-plans)');
select throws_ok($$select pg_temp.insist('reply_received', 0)$$, '40001', null,
  'a case read with another send_count is refused');
select throws_ok($$
  select public.claims_apply_reply_action('00000000-0000-4000-8000-0000000000c6',
    '00000000-0000-4000-8000-00000000a002', 'approved', 'reply_received', 1,
    '{"steps":[{"event":"approved","from":"reply_received","to":"resolved"}]}')
$$, '22023', null, 'the reply must be an inbound message of the case');
select throws_ok($$
  select public.claims_apply_reply_action('00000000-0000-4000-8000-0000000000c6',
    '00000000-0000-4000-8000-00000000a001', 'approved', 'reply_received', 1,
    '{"steps":[{"event":"approved","from":"sent","to":"resolved"}]}')
$$, '22023', null, 'steps must chain from the case status');
select throws_ok($$
  select public.claims_apply_reply_action('00000000-0000-4000-8000-0000000000c6',
    '00000000-0000-4000-8000-00000000a001', 'approved', 'reply_received', 1,
    '{"steps":[{"event":"approved","from":"reply_received","to":"resolved"}],
      "outbox":[{"audience":"user","template":"user_final_result","from":"retren@example.test",
                 "to":"other@example.test","subject":"[RTN-X] r","body_text":"t"}]}')
$$, '22023', null, 'a notice to anyone but the case user is refused');
select throws_ok($$
  select public.claims_apply_reply_action('00000000-0000-4000-8000-0000000000c6',
    '00000000-0000-4000-8000-00000000a001', 'approved', 'reply_received', 1,
    '{"steps":[{"event":"approved","from":"reply_received","to":"resolved"}],
      "outbox":[{"audience":"user","template":"reminder_d12","from":"retren@example.test",
                 "to":"user@example.test","subject":"[RTN-X] r","body_text":"t"}]}')
$$, '22023', null, 'a notice kind outside the user allowlist is refused');
select throws_ok($$
  select public.claims_apply_reply_action('00000000-0000-4000-8000-0000000000c6',
    '00000000-0000-4000-8000-00000000a001', 'approved', 'reply_received', 1,
    '{"steps":[{"event":"approved","from":"reply_received","to":"resolved"}],
      "outbox":[{"audience":"operator","template":"insistence_after_denial","from":"retren@example.test",
                 "to":"op@operator.example","subject":"[RTN-X] r","body_text":"t"}]}')
$$, '22023', null, 'an operator mail without the insistence step is refused');
select throws_ok($$
  select public.claims_apply_reply_action('00000000-0000-4000-8000-0000000000c6',
    '00000000-0000-4000-8000-00000000a001', 'denied', 'reply_received', 1,
    '{"steps":[{"event":"rejected","from":"reply_received","to":"denied"},
               {"event":"insistence_sent","from":"denied","to":"sent"}]}')
$$, '22023', null, 'an insistence without its mail is refused');
select throws_ok($$
  select public.claims_apply_reply_action('00000000-0000-4000-8000-0000000000c6',
    '00000000-0000-4000-8000-00000000a001', 'approved', 'reply_received', 1,
    '{"team_queue_reason":"other",
      "outbox":[{"audience":"user","template":"user_final_result","from":"retren@example.test",
                 "to":"user@example.test","subject":"[RTN-X] r","body_text":"t"}]}')
$$, '22023', null, 'a team queue item queues no mail');
select throws_ok($$
  select public.claims_apply_reply_action('00000000-0000-4000-8000-0000000000c6',
    '00000000-0000-4000-8000-00000000a001', 'denied', 'reply_received', 1,
    '{"steps":[{"event":"rejected","from":"reply_received","to":"denied"},
               {"event":"insistence_sent","from":"denied","to":"sent"}],
      "outbox":[{"audience":"operator","template":"insistence_after_denial","to":"op@operator.example",
                 "subject":"[RTN-X] insistence","body_text":"text"}]}')
$$, '23502', null, 'a broken mail (no from) fails the whole action');
select throws_ok($$select pg_temp.insist('reply_received', 1, 'x@evil.example')$$, 'RT403', null,
  'an insistence to any address but the claim''s is refused');
select results_eq(
  $$select status::text, send_count from public.cases where id = '00000000-0000-4000-8000-0000000000c6'$$,
  $$values ('reply_received', 1)$$, 'refused actions changed nothing on the case');
select is((select count(*) from public.case_events where case_id = '00000000-0000-4000-8000-0000000000c6'),
  0::bigint, 'refused actions wrote no event');
select is((select count(*) from public.messages where case_id = '00000000-0000-4000-8000-0000000000c6'
  and status = 'queued'), 0::bigint, 'refused actions queued no mail');

-- A denial that can't be answered still moves the case to denied, with its team queue item.
insert into public.cases (id, operator, submission, user_email, status, send_count)
values ('00000000-0000-4000-8000-0000000000c8', 'iryo', '{}', 'user@example.test', 'reply_received', 5);
insert into public.messages (id, case_id, direction, from_address, to_address, subject, status)
values ('00000000-0000-4000-8000-00000000a008', '00000000-0000-4000-8000-0000000000c8', 'inbound',
  'op@operator.example', 'retren@example.test', '[RTN-Z] denied', 'received');
select lives_ok($$
  select public.claims_apply_reply_action('00000000-0000-4000-8000-0000000000c8',
    '00000000-0000-4000-8000-00000000a008', 'denied', 'reply_received', 5,
    '{"steps":[{"event":"rejected","from":"reply_received","to":"denied"}],
      "team_queue_reason":"send_cap"}')
$$, 'a team queue reason may come with state changes');
select results_eq(
  $$select c.status::text, e.kind, coalesce(e.data ->> 'event', e.data ->> 'reason')
    from public.cases c join public.case_events e on e.case_id = c.id
    where c.id = '00000000-0000-4000-8000-0000000000c8' order by e.created_at$$,
  $$values ('denied', 'reply_action', 'rejected'), ('denied', 'team_queue', 'send_cap')$$,
  'denied, with the rejected event and the team queue item'
);

-- The insistence: two events, one queued mail, send_count + 1, category on the reply.
select lives_ok($$select pg_temp.insist('reply_received', 1)$$, 'the first insistence is applied');
select results_eq(
  $$select status::text, send_count, next_action_at from public.cases
    where id = '00000000-0000-4000-8000-0000000000c6'$$,
  $$values ('sent', 2, '2030-01-01T00:00:00Z'::timestamptz)$$, 'the case is back in sent, one more send');
select results_eq(
  $$select kind, from_status::text, to_status::text, data ->> 'event' from public.case_events
    where case_id = '00000000-0000-4000-8000-0000000000c6' and kind = 'reply_action' order by created_at$$,
  $$values ('reply_action', 'reply_received', 'denied', 'rejected'),
           ('reply_action', 'denied', 'sent', 'insistence_sent')$$,
  'rejected and insistence_sent events'
);
select is((select category::text from public.messages where id = '00000000-0000-4000-8000-00000000a001'),
  'denied', 'the reply carries its category');
select results_eq(
  $$select to_address, status::text from public.messages
    where case_id = '00000000-0000-4000-8000-0000000000c6' and status = 'queued'$$,
  $$values ('op@operator.example', 'queued')$$, 'the insistence is queued to the operator');

-- A second insistence is refused, by the function and by the index.
update public.cases set status = 'reply_received' where id = '00000000-0000-4000-8000-0000000000c6';
select throws_ok($$select pg_temp.insist('reply_received', 2)$$, '23505', null,
  'a second insistence is refused');
select throws_ok($$
  insert into public.case_events (case_id, kind, data)
  values ('00000000-0000-4000-8000-0000000000c6', 'reply_action', '{"event":"insistence_sent"}')
$$, '23505', null, 'the index refuses a second insistence_sent event');

-- The send cap: the last slot (6) is reserved for the d45 escalation, so a reply's operator mail
-- needs send_count < 5. A fresh case (no insistence yet), so only the cap can refuse it.
insert into public.cases (id, operator, submission, user_email, status, send_count)
values ('00000000-0000-4000-8000-0000000000c7', 'iryo', '{}', 'user@example.test', 'reply_received', 5);
insert into public.messages (id, case_id, direction, from_address, to_address, subject, status, created_at)
values
  ('00000000-0000-4000-8000-00000000a004', '00000000-0000-4000-8000-0000000000c7', 'outbound',
   'retren@example.test', 'op@operator.example', '[RTN-Y] claim', 'sent', now() - interval '1 day'),
  ('00000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-0000000000c7', 'inbound',
   'op@operator.example', 'retren@example.test', '[RTN-Y] denied', 'received', now());
select throws_ok($$
  select public.claims_apply_reply_action('00000000-0000-4000-8000-0000000000c7',
    '00000000-0000-4000-8000-00000000a003', 'denied', 'reply_received', 5,
    '{"steps":[{"event":"rejected","from":"reply_received","to":"denied"},
               {"event":"insistence_sent","from":"denied","to":"sent"}],
      "outbox":[{"audience":"operator","template":"insistence_after_denial",
                 "from":"retren@example.test","to":"op@operator.example",
                 "subject":"[RTN-Y] insistence","body_text":"text"}]}')
$$, '22023', null, 'an operator mail at send_count 5 is refused (the last slot is for d45)');

-- The team queue fallback: once per reply and reason, without touching the case.
select ok(public.claims_queue_for_team('00000000-0000-4000-8000-0000000000c6',
  '00000000-0000-4000-8000-00000000a001', 'denied', 'retry_exhausted'), 'a reply is put in the team queue');
select ok(not public.claims_queue_for_team('00000000-0000-4000-8000-0000000000c6',
  '00000000-0000-4000-8000-00000000a001', 'denied', 'retry_exhausted'), 'the same item is not recorded twice');
select is((select count(*) from public.case_events where case_id = '00000000-0000-4000-8000-0000000000c6'
  and kind = 'team_queue' and data ->> 'reason' = 'retry_exhausted'), 1::bigint, 'one retry_exhausted item');

-- Forwarding a user document.
update public.cases set send_count = 6 where id = '00000000-0000-4000-8000-0000000000c6';
select throws_ok($$
  select public.claims_forward_user_document('00000000-0000-4000-8000-0000000000c6',
    gen_random_uuid(), 6, '{}', null)
$$, '22023', null, 'forwarding needs a case waiting on the user');

update public.cases set status = 'waiting_user', send_count = 2
  where id = '00000000-0000-4000-8000-0000000000c6';
insert into public.attachments (id, case_id, kind, storage_path, filename, content_type)
values
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-0000000000c6', 'user_document',
   'case/doc.pdf', 'doc.pdf', 'application/pdf'),
  ('00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-0000000000c6', 'ticket',
   'case/ticket.png', 'ticket.png', 'image/png');

create function pg_temp.forward(case_id uuid, attachment uuid, expected_count int,
  recipient text default 'op@operator.example') returns jsonb language sql as $$
  select public.claims_forward_user_document(case_id, attachment, expected_count,
    jsonb_build_object('from', 'retren@example.test', 'to', recipient,
      'subject', '[RTN-X] data', 'body_text', 'text'), '2030-01-02T00:00:00Z')
$$;
select throws_ok($$select pg_temp.forward('00000000-0000-4000-8000-0000000000c6',
  '00000000-0000-4000-8000-00000000d002', 2)$$, '22023', null, 'only a user document can be forwarded');
select throws_ok($$select pg_temp.forward('00000000-0000-4000-8000-0000000000c6',
  '00000000-0000-4000-8000-00000000d001', 1)$$, '40001', null, 'a case read with another send_count is refused');
select throws_ok($$select pg_temp.forward('00000000-0000-4000-8000-0000000000c6',
  '00000000-0000-4000-8000-00000000d001', 2, 'x@evil.example')$$, 'RT403', null,
  'a document to any address but the claim''s is refused');
select lives_ok($$select set_config('test.fwd', pg_temp.forward('00000000-0000-4000-8000-0000000000c6',
  '00000000-0000-4000-8000-00000000d001', 2) ->> 'message_id', true)$$, 'the user document is forwarded');
select results_eq(
  $$select status::text, send_count from public.cases where id = '00000000-0000-4000-8000-0000000000c6'$$,
  $$values ('sent', 3)$$, 'waiting_user → sent, one more send');
select is((select message_id from public.attachments where id = '00000000-0000-4000-8000-00000000d001'),
  current_setting('test.fwd')::uuid, 'the attachment is linked to the queued mail');
select is((select count(*) from public.case_events where case_id = '00000000-0000-4000-8000-0000000000c6'
  and kind = 'user_document_forwarded'), 1::bigint, 'a user_document_forwarded event');
select ok((select deleted_at is null from public.attachments where id = '00000000-0000-4000-8000-00000000d001'),
  'the document is kept until its mail is sent');

update public.cases set status = 'waiting_user' where id = '00000000-0000-4000-8000-0000000000c6';
select throws_ok($$select pg_temp.forward('00000000-0000-4000-8000-0000000000c6',
  '00000000-0000-4000-8000-00000000d001', 3)$$, '22023', null, 'a document is forwarded only once');

-- At send_count 5 nothing is queued: the team queue, once per attachment.
update public.cases set send_count = 5 where id = '00000000-0000-4000-8000-0000000000c6';
insert into public.attachments (id, case_id, kind, storage_path, filename, content_type)
values ('00000000-0000-4000-8000-00000000d003', '00000000-0000-4000-8000-0000000000c6', 'user_document',
  'case/doc2.pdf', 'doc2.pdf', 'application/pdf');
select is(pg_temp.forward('00000000-0000-4000-8000-0000000000c6', '00000000-0000-4000-8000-00000000d003', 5),
  '{"team_queue":"send_cap"}'::jsonb, 'forwarding at send_count 5 goes to the team queue');
select is(pg_temp.forward('00000000-0000-4000-8000-0000000000c6', '00000000-0000-4000-8000-00000000d003', 5),
  '{"team_queue":"send_cap"}'::jsonb, 'and again');
select is((select count(*) from public.case_events where case_id = '00000000-0000-4000-8000-0000000000c6'
  and kind = 'team_queue' and data ->> 'reason' = 'send_cap'), 1::bigint, 'one send_cap item, not two');

-- No claim went out yet: there is no operator address to forward to.
insert into public.cases (id, operator, submission, user_email, status, send_count)
values ('00000000-0000-4000-8000-0000000000c9', 'iryo', '{}', 'user@example.test', 'waiting_user', 1);
insert into public.attachments (id, case_id, kind, storage_path, filename, content_type)
values ('00000000-0000-4000-8000-00000000d004', '00000000-0000-4000-8000-0000000000c9', 'user_document',
  'case/doc3.pdf', 'doc3.pdf', 'application/pdf');
select throws_ok($$select pg_temp.forward('00000000-0000-4000-8000-0000000000c9',
  '00000000-0000-4000-8000-00000000d004', 1)$$, 'RT403', null, 'no forward before the claim went out');

-- Marking the documents of a sent mail deleted: never while it is queued or failed.
select throws_ok($$select public.claims_mark_forwarded_documents_deleted(current_setting('test.fwd')::uuid)$$,
  '22023', null, 'a queued mail keeps its document');
update public.messages set status = 'failed' where id = current_setting('test.fwd')::uuid;
select throws_ok($$select public.claims_mark_forwarded_documents_deleted(current_setting('test.fwd')::uuid)$$,
  '22023', null, 'a failed mail keeps its document');
update public.messages set status = 'sent' where id = current_setting('test.fwd')::uuid;
select is(public.claims_mark_forwarded_documents_deleted(current_setting('test.fwd')::uuid), 1,
  'the document of a sent mail is marked deleted');
select is(public.claims_mark_forwarded_documents_deleted(current_setting('test.fwd')::uuid), 0,
  'it is marked only once');
select is((select count(*) from public.case_events where case_id = '00000000-0000-4000-8000-0000000000c6'
  and kind = 'user_document_deleted'), 1::bigint, 'one user_document_deleted event');
select ok((select deleted_at is not null from public.attachments where id = '00000000-0000-4000-8000-00000000d001'),
  'deleted_at is set');

select * from finish();
rollback;
