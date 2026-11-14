-- Claims schema (migration *_claims_create_cases.sql, docs/plans/C-claims.md C1).
begin;
select plan(100);

-- Tables exist, with RLS on.
select has_table('public', t, 'table ' || t || ' exists')
from unnest(array['cases', 'case_events', 'messages', 'attachments']) as t;

select ok(
  (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass),
  'RLS is on for ' || t
)
from unnest(array['cases', 'case_events', 'messages', 'attachments']) as t;

-- No policies: only the service role (which bypasses RLS) reaches these tables.
select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename in ('cases', 'case_events', 'messages', 'attachments')),
  0::bigint,
  'no RLS policy opens the claims tables to anyone'
);

-- Enum values are exact (case_status and reply_category mirror shared/contracts/case.ts).
select enum_has_labels('public', 'case_status', array[
  'draft', 'waiting_period', 'sent', 'reply_received', 'waiting_user',
  'escalated', 'resolved', 'denied', 'closed'
], 'case_status has exactly the 9 states of ARCHITECTURE §5');
select enum_has_labels('public', 'reply_category', array[
  'acknowledgement', 'asks_for_data', 'approved', 'denied', 'refers_to_form', 'other'
], 'reply_category has exactly the 6 closed categories');
select enum_has_labels('public', 'message_direction', array['outbound', 'inbound'],
  'message_direction is outbound | inbound');
select enum_has_labels('public', 'message_status', array['queued', 'sent', 'failed', 'received'],
  'message_status is queued | sent | failed | received');
select enum_has_labels('public', 'attachment_kind', array['eu_form', 'mandate', 'ticket', 'user_document'],
  'attachment_kind is the attachment allowlist');

-- Columns the plan asks for.
select has_column('public', 'cases', c, 'cases.' || c)
from unnest(array[
  'id', 'public_ref', 'operator', 'status', 'submission', 'eligibility', 'user_email',
  'earliest_send_at', 'sent_at', 'next_action_at', 'send_count', 'paused', 'created_at'
]) as c;
select has_column('public', 'messages', c, 'messages.' || c)
from unnest(array[
  'id', 'case_id', 'direction', 'from_address', 'to_address', 'subject', 'message_id',
  'in_reply_to', 'category', 'status', 'body_text', 'raw_path', 'created_at'
]) as c;
select col_type_is('public', 'cases', 'status', 'case_status', 'cases.status is case_status');
select col_default_is('public', 'cases', 'status', 'draft', 'a new case starts as draft');

-- Fixtures, inserted as the owner (the migration role). Nothing here is real data.
insert into public.cases (id, operator, submission, user_email)
values ('00000000-0000-0000-0000-0000000000c1', 'iryo', '{}', 'user@example.test');

-- public_ref: generated, shaped like the contract (RTN-[A-Z0-9]+), and unique.
select matches(
  (select public_ref from public.cases where id = '00000000-0000-0000-0000-0000000000c1'),
  '^RTN-[A-Z0-9]+$',
  'public_ref is generated as RTN-xxxx'
);
select throws_ok(
  $$insert into public.cases (operator, submission, user_email, public_ref)
    select 'iryo', '{}', 'other@example.test', public_ref from public.cases
    where id = '00000000-0000-0000-0000-0000000000c1'$$,
  '23505',
  null,
  'public_ref is unique'
);
select throws_ok(
  $$insert into public.cases (operator, submission, user_email, public_ref)
    values ('iryo', '{}', 'u@example.test', 'rtn-lower')$$,
  '23514',
  null,
  'public_ref must match RTN-[A-Z0-9]+'
);
select throws_ok(
  $$insert into public.cases (operator, submission, user_email) values ('acme', '{}', 'u@example.test')$$,
  '23514',
  null,
  'operator must be a known OperatorId'
);
select throws_ok(
  $$insert into public.cases (operator, submission, user_email, send_count)
    values ('iryo', '{}', 'u@example.test', -1)$$,
  '23514',
  null,
  'send_count cannot be negative'
);
select throws_ok(
  $$insert into public.cases (operator, submission, user_email, status)
    values ('iryo', '{}', 'u@example.test', 'pending')$$,
  '22P02',
  null,
  'status outside the enum is refused'
);

insert into public.case_events (id, case_id, kind, from_status, to_status)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1',
        'created', null, 'draft');
insert into public.messages (id, case_id, direction, from_address, to_address, subject, status)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1',
        'outbound', 'claims@example.test', 'operator@example.test', '[RTN-TEST] claim', 'queued');
insert into public.attachments (case_id, message_id, kind, storage_path, filename, content_type)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1',
        'eu_form', 'cases/test/eu_form.pdf', 'eu_form.pdf', 'application/pdf');

-- case_events is append-only, even for the owner and the service role.
select throws_ok(
  $$update public.case_events set kind = 'tampered' where id = '00000000-0000-0000-0000-0000000000e1'$$,
  'P0001',
  'case_events is append-only',
  'UPDATE on case_events is blocked'
);
select throws_ok(
  $$delete from public.case_events where id = '00000000-0000-0000-0000-0000000000e1'$$,
  'P0001',
  'case_events is append-only',
  'DELETE on case_events is blocked'
);
select throws_ok(
  $$truncate public.case_events$$,
  'P0001',
  'case_events is append-only',
  'TRUNCATE on case_events is blocked'
);
select throws_ok(
  $$delete from public.cases where id = '00000000-0000-0000-0000-0000000000c1'$$,
  '23503',
  null,
  'a case with events cannot be deleted (its history is kept)'
);

-- messages and attachments constraints.
select throws_ok(
  $$insert into public.messages (direction, from_address, to_address, subject, status)
    values ('outbound', 'a@example.test', 'b@example.test', 's', 'delivered')$$,
  '22P02',
  null,
  'message status outside the enum is refused'
);
select throws_ok(
  $$insert into public.messages (direction, from_address, to_address, subject, status, category)
    values ('inbound', 'a@example.test', 'b@example.test', 's', 'received', 'spam')$$,
  '22P02',
  null,
  'message category outside the enum is refused'
);
select lives_ok(
  $$insert into public.messages (direction, from_address, to_address, subject, status)
    values ('inbound', 'x@unknown.test', 'claims@example.test', 'no ref', 'received')$$,
  'an inbound message without a case (team queue) is allowed'
);
select throws_ok(
  $$insert into public.attachments (case_id, kind, storage_path, filename, content_type)
    values ('00000000-0000-0000-0000-0000000000c1', 'invoice', 'p', 'f', 'application/pdf')$$,
  '22P02',
  null,
  'attachment kind outside the allowlist is refused'
);

-- anon and authenticated: no read, no write, on any claims table.
create function pg_temp.denied(p_role text, p_sql text) returns boolean language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
  exception when insufficient_privilege then
    reset role;
    return true;
  end;
  reset role;
  return false;
end;
$$;

select ok(pg_temp.denied(r, s), r || ': ' || s)
from unnest(array['anon', 'authenticated']) as r,
     unnest(array[
       'select * from public.cases',
       $$insert into public.cases (operator, submission, user_email) values ('iryo', '{}', 'x@example.test')$$,
       $$update public.cases set paused = true$$,
       $$delete from public.cases$$,
       'select * from public.case_events',
       $$insert into public.case_events (case_id, kind, to_status) values ('00000000-0000-0000-0000-0000000000c1', 'x', 'draft')$$,
       'select * from public.messages',
       $$insert into public.messages (direction, from_address, to_address, subject, status) values ('inbound', 'a@x.test', 'b@x.test', 's', 'received')$$,
       $$update public.messages set subject = 'x'$$,
       $$delete from public.messages$$,
       $$update public.case_events set kind = 'x'$$,
       $$delete from public.case_events$$,
       'select * from public.attachments',
       $$insert into public.attachments (case_id, kind, storage_path, filename, content_type) values ('00000000-0000-0000-0000-0000000000c1', 'ticket', 'p', 'f', 'application/pdf')$$,
       $$update public.attachments set filename = 'x'$$,
       $$delete from public.attachments$$
     ]) as s
;

-- The service role (the server) can insert into and read every claims table.
create function pg_temp.rows_as(p_role text, p_sql text) returns bigint language plpgsql as $$
declare
  n bigint;
begin
  execute format('set local role %I', p_role);
  execute p_sql;
  get diagnostics n = row_count;
  reset role;
  return n;
end;
$$;

select is(pg_temp.rows_as('service_role', s), 1::bigint, 'service_role: ' || s)
from unnest(array[
  $$insert into public.cases (id, operator, submission, user_email) values ('00000000-0000-0000-0000-0000000000c2', 'renfe', '{}', 's@example.test')$$,
  $$select * from public.cases where id = '00000000-0000-0000-0000-0000000000c2'$$,
  $$insert into public.case_events (id, case_id, kind, to_status) values ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c2', 'created', 'draft')$$,
  $$select * from public.case_events where id = '00000000-0000-0000-0000-0000000000e2'$$,
  $$insert into public.messages (id, case_id, direction, from_address, to_address, subject, status) values ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c2', 'outbound', 'a@example.test', 'b@example.test', 's', 'queued')$$,
  $$select * from public.messages where id = '00000000-0000-0000-0000-0000000000a2'$$,
  $$insert into public.attachments (id, case_id, kind, storage_path, filename, content_type) values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000c2', 'mandate', 'p', 'm.pdf', 'application/pdf')$$,
  $$select * from public.attachments where id = '00000000-0000-0000-0000-0000000000f2'$$
]) with ordinality as t (s, n)
order by n;

-- cases.operator accepts exactly OperatorId (shared/contracts/operator.ts). Keep this literal
-- list in step with OperatorId: the generated types expose the column only as `string`.
select lives_ok(
  format($$insert into public.cases (operator, submission, user_email) values (%L, '{}', 'o@example.test')$$, op),
  'operator ' || op || ' is accepted'
)
from unnest(array['iryo', 'renfe', 'ouigo']) as op;
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.cases'::regclass and conname = 'cases_operator_check'),
  $$CHECK ((operator = ANY (ARRAY['iryo'::text, 'renfe'::text, 'ouigo'::text])))$$,
  'the operator CHECK is exactly OperatorId: iryo, renfe, ouigo'
);

select * from finish();
rollback;
