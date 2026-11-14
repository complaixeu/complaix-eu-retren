-- Inbound mail (migration *_claims_inbound.sql, docs/plans/C-claims.md C4).
begin;
select plan(39);

-- The raw-mail bucket is private, and the API roles can't read or write its objects.
select is((select public from storage.buckets where id = 'claims-inbound-mail'), false,
  'the claims-inbound-mail bucket is private');
insert into storage.objects (bucket_id, name) values ('claims-inbound-mail', 'test-c4/raw.eml');
set local role anon;
select is((select count(*) from storage.objects where bucket_id = 'claims-inbound-mail'), 0::bigint,
  'anon cannot see raw mail');
reset role;
set local role authenticated;
select is((select count(*) from storage.objects where bucket_id = 'claims-inbound-mail'), 0::bigint,
  'authenticated cannot see raw mail');
reset role;
set local role anon;
select throws_ok($$insert into storage.objects (bucket_id, name) values ('claims-inbound-mail', 'x/anon.eml')$$,
  '42501', null, 'anon cannot write raw mail');
reset role;
set local role authenticated;
select throws_ok($$insert into storage.objects (bucket_id, name) values ('claims-inbound-mail', 'x/auth.eml')$$,
  '42501', null, 'authenticated cannot write raw mail');
reset role;

-- The poll-state table: RLS on, server only, constraints hold.
select has_table('public', 'claims_mail_poll_state', 'the poll-state table exists');
select ok((select rowsecurity from pg_tables where schemaname = 'public'
  and tablename = 'claims_mail_poll_state'), 'the poll-state table has RLS on');
select ok(not has_table_privilege('anon', 'public.claims_mail_poll_state', 'select'),
  'anon cannot read the poll state');
select ok(not has_table_privilege('anon', 'public.claims_mail_poll_state', 'insert'),
  'anon cannot write the poll state');
select ok(not has_table_privilege('authenticated', 'public.claims_mail_poll_state', 'select'),
  'authenticated cannot read the poll state');
select ok(not has_table_privilege('authenticated', 'public.claims_mail_poll_state', 'update'),
  'authenticated cannot write the poll state');
select lives_ok($$insert into public.claims_mail_poll_state (mailbox, uid_validity, last_uid)
  values ('TEST-C4', 7, 0)$$, 'a poll state row can be stored');
select throws_ok($$insert into public.claims_mail_poll_state (mailbox, uid_validity, last_uid)
  values ('TEST-C4', 7, 1)$$, '23505', null, 'one row per mailbox');
select throws_ok($$insert into public.claims_mail_poll_state (mailbox, uid_validity, last_uid)
  values ('TEST-C4B', 7, -1)$$, '23514', null, 'last_uid is never negative');
select throws_ok($$insert into public.claims_mail_poll_state (mailbox, uid_validity, last_uid)
  values ('TEST-C4C', 0, 0)$$, '23514', null, 'uid_validity is positive');

select col_is_null('public', 'claims_mail_poll_state', 'failed_uid', 'failed_uid is nullable');
select col_is_null('public', 'claims_mail_poll_state', 'failed_attempts',
  'failed_attempts is nullable');
select throws_ok($$insert into public.claims_mail_poll_state (mailbox, uid_validity, last_uid, failed_uid)
  values ('TEST-C4D', 7, 0, 0)$$, '23514', null, 'failed_uid is a real UID');
select throws_ok($$insert into public.claims_mail_poll_state (mailbox, uid_validity, last_uid,
  failed_uid, failed_attempts) values ('TEST-C4E', 7, 0, 3, -1)$$, '23514', null,
  'failed_attempts is never negative');

-- messages.inbound_queue_reason: nullable, a code only.
select col_is_null('public', 'messages', 'inbound_queue_reason', 'inbound_queue_reason is nullable');

-- claims_record_inbound: server only.
create function pg_temp.sig() returns text language sql as $$
  select 'public.claims_record_inbound(jsonb, uuid, public.case_status, public.case_status, text)'
$$;
select ok(not has_function_privilege('anon', pg_temp.sig(), 'execute'), 'anon cannot call it');
select ok(not has_function_privilege('authenticated', pg_temp.sig(), 'execute'),
  'authenticated cannot call it');
select ok(has_function_privilege('service_role', pg_temp.sig(), 'execute'),
  'service_role can call it');

-- A sent case. Nothing here is real data.
insert into public.cases (id, public_ref, operator, status, submission, user_email, sent_at)
values ('00000000-0000-0000-0000-0000000004c1', 'RTN-00C40001', 'iryo', 'sent', '{}',
  'user@example.test', now());

-- An operator reply: recorded, the case moves sent → reply_received with one event.
select is(
  public.claims_record_inbound(
    '{"from":"op@iryo.example","to":"us@retren.example","subject":"Re: [RTN-00C40001]","message_id":"<c4-1@op.example>","references":["<a@x>","<b@x>"]}',
    '00000000-0000-0000-0000-0000000004c1', 'sent', 'reply_received', null) ->> 'duplicate',
  'false', 'an operator reply is recorded');
select is((select status from public.cases where id = '00000000-0000-0000-0000-0000000004c1'),
  'reply_received'::public.case_status, 'operator_replied is applied');
select results_eq(
  $$select kind, from_status::text, to_status::text from public.case_events
    where case_id = '00000000-0000-0000-0000-0000000004c1'$$,
  $$values ('operator_replied', 'sent', 'reply_received')$$,
  'one operator_replied event');
select is((select array_to_string(thread_references, ' ') || '|' || status::text || '|' || direction::text
  from public.messages where message_id = '<c4-1@op.example>'),
  '<a@x> <b@x>|received|inbound', 'stored as a received inbound message with its references');

-- The same Message-ID again: stored once, nothing applied a second time.
select is(
  public.claims_record_inbound(
    '{"from":"op@iryo.example","to":"us@retren.example","subject":"Re","message_id":"<c4-1@op.example>"}',
    '00000000-0000-0000-0000-0000000004c1', 'reply_received', 'reply_received', null) ->> 'duplicate',
  'true', 'a Message-ID already stored is a duplicate');
select is((select count(*) from public.messages where message_id = '<c4-1@op.example>'), 1::bigint,
  'the duplicate is stored once');
select is((select count(*) from public.case_events
  where case_id = '00000000-0000-0000-0000-0000000004c1'), 1::bigint,
  'the duplicate adds no event');

-- The case changed since it was read: 40001, nothing stored.
select throws_ok(
  $$select public.claims_record_inbound(
    '{"from":"op@iryo.example","to":"us","subject":"Re","message_id":"<c4-2@op.example>"}',
    '00000000-0000-0000-0000-0000000004c1', 'sent', 'reply_received', null)$$,
  '40001', null, 'a stale expected status is refused');
select is((select count(*) from public.messages where message_id = '<c4-2@op.example>'), 0::bigint,
  'nothing is stored when refused');

-- The team queue: with a case, an event; without one, only the message carries the reason.
select lives_ok(
  $$select public.claims_record_inbound(
    '{"from":"x@other.example","to":"us","subject":"Re: [RTN-00C40001]","message_id":"<c4-3@other.example>"}',
    '00000000-0000-0000-0000-0000000004c1', null, null, 'wrong_sender')$$,
  'a wrong sender goes to the team queue');
select is((select data ->> 'reason' from public.case_events
  where case_id = '00000000-0000-0000-0000-0000000004c1' and kind = 'team_queue'),
  'wrong_sender', 'the team queue event carries the reason code');
select is((select status from public.cases where id = '00000000-0000-0000-0000-0000000004c1'),
  'reply_received'::public.case_status, 'the team queue leaves the case as it is');
select lives_ok(
  $$select public.claims_record_inbound(
    '{"from":"op@iryo.example","to":"us","subject":"Re: [RTN-NOPE]","message_id":"<c4-4@op.example>"}',
    null, null, null, 'unknown_reference')$$,
  'an unknown reference is recorded without a case');
select is((select inbound_queue_reason from public.messages where message_id = '<c4-4@op.example>'
  and case_id is null), 'unknown_reference', 'the case-less message carries the reason');
select throws_ok(
  $$select public.claims_record_inbound(
    '{"from":"a","to":"b","subject":"c","message_id":"<c4-5@x>"}', null, null, null, null)$$,
  '22023', null, 'mail without a case must go to the team queue');
select throws_ok(
  $$select public.claims_record_inbound(
    '{"from":"a","to":"b","subject":"c","message_id":"<c4-6@x>"}', null, null, null, 'Free text!')$$,
  '22023', null, 'a reason is a code, never free text');

select * from finish();
rollback;
