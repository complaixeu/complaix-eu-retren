-- createCase in one transaction (migration *_claims_create_case_fn.sql, docs/plans/C-claims.md C2).
begin;
select plan(31);

select has_function('public', 'claims_new_public_ref', array[]::text[], 'claims_new_public_ref exists');
select has_function('public', 'claims_create_case', 'claims_create_case exists');

-- Server only: the API roles can't call either function; the service role can.
select ok(not has_function_privilege('anon', 'public.claims_new_public_ref()', 'execute'),
  'anon cannot call claims_new_public_ref');
select ok(not has_function_privilege('authenticated', 'public.claims_new_public_ref()', 'execute'),
  'authenticated cannot call claims_new_public_ref');
select ok(has_function_privilege('service_role', 'public.claims_new_public_ref()', 'execute'),
  'service_role can call claims_new_public_ref');

create function pg_temp.create_case_sig() returns text language sql as $$
  select 'public.claims_create_case(text, text, public.case_status, jsonb, jsonb, text, '
    || 'timestamptz, timestamptz, jsonb, jsonb)'
$$;
select ok(not has_function_privilege('anon', pg_temp.create_case_sig(), 'execute'),
  'anon cannot call claims_create_case');
select ok(not has_function_privilege('authenticated', pg_temp.create_case_sig(), 'execute'),
  'authenticated cannot call claims_create_case');
select ok(has_function_privilege('service_role', pg_temp.create_case_sig(), 'execute'),
  'service_role can call claims_create_case');

-- References: shaped like the contract, and the column default uses the same generator.
select matches(public.claims_new_public_ref(), '^RTN-[0-9A-F]{8}$', 'a reference is RTN- + 8 hex');
select col_default_is('public', 'cases', 'public_ref', 'claims_new_public_ref()',
  'cases.public_ref defaults to claims_new_public_ref()');

-- Eligible: one case and one created event, no message. Nothing here is real data.
select lives_ok($$
  select set_config('test.eligible', public.claims_create_case(
    'RTN-0000E1E1', 'iryo', 'waiting_period', '{"draftId":"d1"}', '{"status":"eligible"}',
    'user@example.test', '2026-01-17T12:30:00Z', '2026-01-17T12:30:00Z',
    '{"event":"eligible"}', null)::text, true)
$$, 'an eligible case is created');

select results_eq(
  $$select public_ref, status::text, next_action_at, user_email from public.cases
    where id = current_setting('test.eligible')::uuid$$,
  $$values ('RTN-0000E1E1', 'waiting_period', '2026-01-17T12:30:00Z'::timestamptz, 'user@example.test')$$,
  'the eligible case row is stored'
);
select results_eq(
  $$select kind, from_status::text, to_status::text, data from public.case_events
    where case_id = current_setting('test.eligible')::uuid$$,
  $$values ('created', 'draft', 'waiting_period', '{"event":"eligible"}'::jsonb)$$,
  'one created event draft → waiting_period'
);
select is((select count(*) from public.messages where case_id = current_setting('test.eligible')::uuid),
  0::bigint, 'no message for an eligible case');

-- Not eligible: closed, the notice queued in the outbox, and an event pointing at it.
select lives_ok($$
  select set_config('test.closed', public.claims_create_case(
    'RTN-0000C105', 'iryo', 'closed', '{"draftId":"d2"}', '{"status":"not_eligible"}',
    'user@example.test', null, null, '{"event":"not_eligible"}',
    '{"template":"user_final_result","from":"retren@example.test","to":"user@example.test",
      "subject":"[RTN-0000C105] result","body_text":"text"}')::text, true)
$$, 'a not-eligible case is created');

select results_eq(
  $$select direction::text, status::text, from_address, to_address, subject, body_text
    from public.messages where case_id = current_setting('test.closed')::uuid$$,
  $$values ('outbound', 'queued', 'retren@example.test', 'user@example.test',
    '[RTN-0000C105] result', 'text')$$,
  'the notice is queued as an outbound message'
);
select results_eq(
  $$select kind, data->>'template', (data->>'message_id')::uuid from public.case_events
    where case_id = current_setting('test.closed')::uuid order by kind$$,
  $$select * from (values ('created', null::text, null::uuid)) v
    union all
    select 'user_notice_queued', 'user_final_result', id from public.messages
    where case_id = current_setting('test.closed')::uuid$$,
  'a created and a user_notice_queued event'
);

-- A duplicate reference fails with 23505 (the caller retries) and writes nothing.
select throws_ok($$
  select public.claims_create_case(
    'RTN-0000E1E1', 'iryo', 'waiting_period', '{}', '{}', 'user@example.test',
    null, null, '{}', null)
$$, '23505', null, 'a duplicate public_ref is a unique violation');

-- All or nothing: a broken notice rolls back the case and its event.
select throws_ok($$
  select public.claims_create_case(
    'RTN-0000BAD1', 'iryo', 'closed', '{}', '{}', 'user@example.test',
    null, null, '{}',
    '{"template":"user_final_result","to":"user@example.test","subject":"[RTN-0000BAD1] x"}')
$$, '23502', null, 'a notice without a from address fails');
select is((select count(*) from public.cases where public_ref = 'RTN-0000BAD1'), 0::bigint,
  'the failed case was not stored');
select is((select count(*) from public.cases where public_ref = 'RTN-0000BAD1'
  or id not in (select case_id from public.case_events)), 0::bigint,
  'every stored case has its events');

-- A status createCase never produces is refused.
select throws_ok($$
  select public.claims_create_case(
    'RTN-0000BAD2', 'iryo', 'sent', '{}', '{}', 'user@example.test', null, null, '{}', null)
$$, '22023', null, 'createCase only creates waiting_period or closed cases');

-- The notice may only be the final result, to the case's own user, and only on a closed case.
select throws_ok($$
  select public.claims_create_case(
    'RTN-0000BAD3', 'iryo', 'closed', '{}', '{}', 'user@example.test', null, null, '{}',
    '{"template":"user_final_result","from":"retren@example.test","to":"other@example.test",
      "subject":"[RTN-0000BAD3] x","body_text":"x"}')
$$, '22023', null, 'a notice to anyone but the case user is refused');
select throws_ok($$
  select public.claims_create_case(
    'RTN-0000BAD4', 'iryo', 'closed', '{}', '{}', 'user@example.test', null, null, '{}',
    '{"template":"initial_claim","from":"retren@example.test","to":"user@example.test",
      "subject":"[RTN-0000BAD4] x","body_text":"x"}')
$$, '22023', null, 'a notice other than user_final_result is refused');
select throws_ok($$
  select public.claims_create_case(
    'RTN-0000BAD5', 'iryo', 'waiting_period', '{}', '{}', 'user@example.test', null, null, '{}',
    '{"template":"user_final_result","from":"retren@example.test","to":"user@example.test",
      "subject":"[RTN-0000BAD5] x","body_text":"x"}')
$$, '22023', null, 'a waiting_period case gets no notice');
select throws_ok($$
  select public.claims_create_case(
    'RTN-0000BAD6', 'iryo', 'closed', '{}', '{}', 'user@example.test', null, null, '{}', null)
$$, '22023', null, 'a closed case always gets its notice');
select is((select count(*) from public.cases where public_ref like 'RTN-0000BAD_'), 0::bigint,
  'no refused case was stored');

-- Both functions run as the caller (no SECURITY DEFINER) with an empty search_path.
select ok(not p.prosecdef, p.proname || ' is not SECURITY DEFINER')
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('claims_new_public_ref', 'claims_create_case');
select ok(p.proconfig @> array['search_path=""'], p.proname || ' pins search_path to empty')
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('claims_new_public_ref', 'claims_create_case');

select * from finish();
rollback;
