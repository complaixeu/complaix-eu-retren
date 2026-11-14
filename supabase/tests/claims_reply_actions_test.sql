-- Actions per reply category (migration *_claims_reply_actions.sql, docs/plans/C-claims.md C6).
-- Nothing here is real data.
begin;
select plan(58);

-- Server only: the API roles can't call any of the functions; the service role can.
create function pg_temp.sigs() returns setof text language sql as $$
  values
    ('public.claims_max_sends_per_case()'),
    ('public.claims_apply_reply_action(uuid, uuid, public.reply_category, public.case_status, integer, jsonb)'),
    ('public.claims_forward_user_document(uuid, uuid, integer, jsonb, timestamptz)'),
    ('public.claims_mark_user_document_deleted(uuid)')
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
  and p.proname in ('claims_max_sends_per_case', 'claims_apply_reply_action',
    'claims_forward_user_document', 'claims_mark_user_document_deleted');

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
set local role anon;
select is((select count(*) from storage.objects where bucket_id = 'claims-user-documents'), 0::bigint,
  'anon sees no user document');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('claims-user-documents', 'anon.pdf')$$,
  '42501', null, 'anon cannot upload a user document');
reset role;
set local role authenticated;
select is((select count(*) from storage.objects where bucket_id = 'claims-user-documents'), 0::bigint,
  'authenticated sees no user document');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('claims-user-documents', 'auth.pdf')$$,
  '42501', null, 'authenticated cannot upload a user document');
update storage.objects set name = 'moved.pdf' where bucket_id = 'claims-user-documents';
reset role;
select is((select name from storage.objects where bucket_id = 'claims-user-documents'), 'case/doc.pdf',
  'authenticated cannot change a user document');

-- A case with an operator reply. user@example.test is the case user.
insert into public.cases (id, operator, submission, user_email, status, send_count)
values ('00000000-0000-4000-8000-0000000000c6', 'iryo', '{}', 'user@example.test', 'reply_received', 1);
insert into public.messages (id, case_id, direction, from_address, to_address, subject, status)
values
  ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-0000000000c6', 'inbound',
   'op@operator.example', 'retren@example.test', '[RTN-X] denied', 'received'),
  ('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-0000000000c6', 'outbound',
   'retren@example.test', 'op@operator.example', '[RTN-X] claim', 'sent');

create function pg_temp.insist(expected_status text, expected_count int) returns jsonb language sql as $$
  select public.claims_apply_reply_action(
    '00000000-0000-4000-8000-0000000000c6', '00000000-0000-4000-8000-00000000a001', 'denied',
    expected_status::public.case_status, expected_count,
    '{"steps":[{"event":"rejected","from":"reply_received","to":"denied"},
               {"event":"insistence_sent","from":"denied","to":"sent"}],
      "outbox":[{"audience":"operator","template":"insistence_after_denial",
                 "from":"retren@example.test","to":"op@operator.example",
                 "subject":"[RTN-X] insistence","body_text":"text"}],
      "next_action_at":"2030-01-01T00:00:00Z"}'::jsonb)
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
    '00000000-0000-4000-8000-00000000a001', 'other', 'reply_received', 1,
    '{"team_queue_reason":"other","steps":[{"event":"close","from":"reply_received","to":"closed"}]}')
$$, '22023', null, 'a team queue item changes nothing else');
select throws_ok($$
  select public.claims_apply_reply_action('00000000-0000-4000-8000-0000000000c6',
    '00000000-0000-4000-8000-00000000a001', 'denied', 'reply_received', 1,
    '{"steps":[{"event":"rejected","from":"reply_received","to":"denied"},
               {"event":"insistence_sent","from":"denied","to":"sent"}],
      "outbox":[{"audience":"operator","template":"insistence_after_denial","to":"op@operator.example",
                 "subject":"[RTN-X] insistence","body_text":"text"}]}')
$$, '23502', null, 'a broken mail (no from) fails the whole action');
select results_eq(
  $$select status::text, send_count from public.cases where id = '00000000-0000-4000-8000-0000000000c6'$$,
  $$values ('reply_received', 1)$$, 'refused actions changed nothing on the case');
select is((select count(*) from public.case_events where case_id = '00000000-0000-4000-8000-0000000000c6'),
  0::bigint, 'refused actions wrote no event');
select is((select count(*) from public.messages where case_id = '00000000-0000-4000-8000-0000000000c6'
  and status = 'queued'), 0::bigint, 'refused actions queued no mail');

-- The insistence: two events, one queued mail, send_count + 1, category on the reply.
select lives_ok($$select pg_temp.insist('reply_received', 1)$$, 'the first insistence is applied');
select results_eq(
  $$select status::text, send_count, next_action_at from public.cases
    where id = '00000000-0000-4000-8000-0000000000c6'$$,
  $$values ('sent', 2, '2030-01-01T00:00:00Z'::timestamptz)$$, 'the case is back in sent, one more send');
select results_eq(
  $$select kind, from_status::text, to_status::text, data ->> 'event' from public.case_events
    where case_id = '00000000-0000-4000-8000-0000000000c6' and kind = 'reply_action' order by data ->> 'event' desc$$,
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
-- needs send_count < 5.
-- A fresh case (no insistence yet), so only the cap can refuse it.
insert into public.cases (id, operator, submission, user_email, status, send_count)
values ('00000000-0000-4000-8000-0000000000c7', 'iryo', '{}', 'user@example.test', 'reply_received', 5);
insert into public.messages (id, case_id, direction, from_address, to_address, subject, status)
values ('00000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-0000000000c7', 'inbound',
  'op@operator.example', 'retren@example.test', '[RTN-Y] denied', 'received');
select throws_ok($$
  select public.claims_apply_reply_action('00000000-0000-4000-8000-0000000000c7',
    '00000000-0000-4000-8000-00000000a003', 'denied', 'reply_received', 5,
    '{"steps":[{"event":"rejected","from":"reply_received","to":"denied"},
               {"event":"insistence_sent","from":"denied","to":"sent"}],
      "outbox":[{"audience":"operator","template":"insistence_after_denial",
                 "from":"retren@example.test","to":"op@operator.example",
                 "subject":"[RTN-X] insistence","body_text":"text"}]}')
$$, '22023', null, 'an operator mail at send_count 5 is refused (the last slot is for d45)');
update public.cases set send_count = 6 where id = '00000000-0000-4000-8000-0000000000c6';
select throws_ok($$
  select public.claims_forward_user_document('00000000-0000-4000-8000-0000000000c6',
    gen_random_uuid(), 6, '{}', null)
$$, '22023', null, 'forwarding needs a case waiting on the user');

-- Forwarding a user document.
update public.cases set status = 'waiting_user', send_count = 2
  where id = '00000000-0000-4000-8000-0000000000c6';
insert into public.attachments (id, case_id, kind, storage_path, filename, content_type)
values
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-0000000000c6', 'user_document',
   'case/doc.pdf', 'doc.pdf', 'application/pdf'),
  ('00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-0000000000c6', 'ticket',
   'case/ticket.png', 'ticket.png', 'image/png');

create function pg_temp.forward(attachment uuid, expected_count int) returns uuid language sql as $$
  select public.claims_forward_user_document('00000000-0000-4000-8000-0000000000c6', attachment,
    expected_count,
    '{"from":"retren@example.test","to":"op@operator.example","subject":"[RTN-X] data",
      "body_text":"text"}', '2030-01-02T00:00:00Z')
$$;
select throws_ok($$select pg_temp.forward('00000000-0000-4000-8000-00000000d002', 2)$$, '22023', null,
  'only a user document can be forwarded');
select throws_ok($$select pg_temp.forward('00000000-0000-4000-8000-00000000d001', 1)$$, '40001', null,
  'a case read with another send_count is refused');
select lives_ok($$select pg_temp.forward('00000000-0000-4000-8000-00000000d001', 2)$$,
  'the user document is forwarded');
select results_eq(
  $$select status::text, send_count from public.cases where id = '00000000-0000-4000-8000-0000000000c6'$$,
  $$values ('sent', 3)$$, 'waiting_user → sent, one more send');
select ok((select message_id is not null from public.attachments
  where id = '00000000-0000-4000-8000-00000000d001'), 'the attachment is linked to the queued mail');
select is((select count(*) from public.case_events where case_id = '00000000-0000-4000-8000-0000000000c6'
  and kind = 'user_document_forwarded'), 1::bigint, 'a user_document_forwarded event');

update public.cases set status = 'waiting_user' where id = '00000000-0000-4000-8000-0000000000c6';
select throws_ok($$select pg_temp.forward('00000000-0000-4000-8000-00000000d001', 3)$$, '22023', null,
  'a document is forwarded only once');
update public.cases set send_count = 5 where id = '00000000-0000-4000-8000-0000000000c6';
insert into public.attachments (id, case_id, kind, storage_path, filename, content_type)
values ('00000000-0000-4000-8000-00000000d003', '00000000-0000-4000-8000-0000000000c6', 'user_document',
  'case/doc2.pdf', 'doc2.pdf', 'application/pdf');
select throws_ok($$select pg_temp.forward('00000000-0000-4000-8000-00000000d003', 5)$$, '22023', null,
  'forwarding at send_count 5 is refused (the last slot is for d45)');

-- Marking the deleted document.
select ok(not public.claims_mark_user_document_deleted('00000000-0000-4000-8000-00000000d003'),
  'a document that was never forwarded is not marked');
select ok(public.claims_mark_user_document_deleted('00000000-0000-4000-8000-00000000d001'),
  'the forwarded document is marked deleted');
select ok(not public.claims_mark_user_document_deleted('00000000-0000-4000-8000-00000000d001'),
  'it is marked only once');

select * from finish();
rollback;
