-- Timer actions (migration *_claims_timer_actions.sql, docs/plans/C-claims.md C7).
begin;
select plan(28);

-- One timer action per case: the index.
select has_index('public', 'case_events', 'case_events_timer_action_once', 'the once-only index exists');

insert into public.cases (id, operator, submission, user_email, status)
values ('00000000-0000-4000-8000-0000000000c7', 'iryo', '{}', 'viajero@example.test', 'sent');

select lives_ok(
  $$insert into public.case_events (case_id, kind, data)
    values ('00000000-0000-4000-8000-0000000000c7', 'timer_action', '{"action":"reminder_d12","day":12}')$$,
  'the first reminder_d12 event is recorded'
);
select throws_ok(
  $$insert into public.case_events (case_id, kind, data)
    values ('00000000-0000-4000-8000-0000000000c7', 'timer_action', '{"action":"reminder_d12","day":13}')$$,
  '23505',
  null,
  'a second reminder_d12 for the same case is refused'
);
select lives_ok(
  $$insert into public.case_events (case_id, kind, data)
    values ('00000000-0000-4000-8000-0000000000c7', 'timer_action', '{"action":"reminder_d30","day":30}')$$,
  'a different action for the same case is recorded'
);
select lives_ok(
  $$insert into public.case_events (case_id, kind, data)
    values ('00000000-0000-4000-8000-0000000000c7', 'reply', '{"action":"reminder_d12"}'),
           ('00000000-0000-4000-8000-0000000000c7', 'reply', '{"action":"reminder_d12"}')$$,
  'other event kinds are not constrained'
);

-- Server only: the API roles can't call the function; the service role can.
create function pg_temp.sig() returns text language sql as $$
  select 'public.claims_apply_timer_action(uuid, public.case_status, integer, boolean, '
    || 'public.case_status, integer, timestamptz, jsonb, jsonb, jsonb)'
$$;
select has_function('public', 'claims_apply_timer_action', 'claims_apply_timer_action exists');
select ok(not has_function_privilege('anon', pg_temp.sig(), 'execute'),
  'anon cannot call claims_apply_timer_action');
select ok(not has_function_privilege('authenticated', pg_temp.sig(), 'execute'),
  'authenticated cannot call claims_apply_timer_action');
select ok(has_function_privilege('service_role', pg_temp.sig(), 'execute'),
  'service_role can call claims_apply_timer_action');
select is(
  (select prosecdef from pg_proc where oid = pg_temp.sig()::regprocedure),
  false,
  'claims_apply_timer_action is security invoker'
);
select is(
  (select proconfig from pg_proc where oid = pg_temp.sig()::regprocedure),
  array['search_path=""'],
  'claims_apply_timer_action pins an empty search_path'
);

-- A case for the function, nothing real in it.
insert into public.cases (id, operator, submission, user_email, status, send_count, sent_at)
values ('00000000-0000-4000-8000-0000000007c7', 'iryo', '{}', 'viajero@example.test', 'sent', 1,
  '2026-02-10T09:00:00Z');

-- Rollback: a message without a subject fails, and nothing of the action remains.
select throws_ok(
  $$select public.claims_apply_timer_action(
    '00000000-0000-4000-8000-0000000007c7', 'sent', 1, false, 'sent', 1, '2026-03-12T09:00:00Z',
    '{"action":"reminder_d12","day":12}',
    '{"recipient":"operator","template":"reminder_d12","from":"r@example.test","to":"op@example.test","body_text":"t"}')$$,
  '23502',
  null,
  'a failing outbox insert raises'
);
select results_eq(
  $$select status::text, send_count, next_action_at from public.cases
    where id = '00000000-0000-4000-8000-0000000007c7'$$,
  $$values ('sent', 1, null::timestamptz)$$,
  'after the failure the case is unchanged'
);
select is((select count(*) from public.case_events where case_id = '00000000-0000-4000-8000-0000000007c7'),
  0::bigint, 'after the failure there is no event');

-- The guard: a stale status, send_count or paused flag writes nothing.
select is(public.claims_apply_timer_action(
  '00000000-0000-4000-8000-0000000007c7', 'sent', 2, false, 'sent', 1, null,
  '{"action":"reminder_d12","day":12}',
  '{"recipient":"operator","template":"reminder_d12","from":"r@example.test","to":"op@example.test","subject":"[RTN-X] s","body_text":"t"}'),
  null, 'a stale send_count writes nothing');
select is(public.claims_apply_timer_action(
  '00000000-0000-4000-8000-0000000007c7', 'sent', 1, true, 'sent', 1, null,
  '{"action":"reminder_d12","day":12}',
  '{"recipient":"operator","template":"reminder_d12","from":"r@example.test","to":"op@example.test","subject":"[RTN-X] s","body_text":"t"}'),
  null, 'a stale paused flag writes nothing');
select is(public.claims_apply_timer_action(
  '00000000-0000-4000-8000-0000000007c7', 'reply_received', 1, false, 'closed', 0, null,
  '{"action":"close_3m","day":89}',
  '{"recipient":"user","template":"user_final_result","from":"r@example.test","to":"viajero@example.test","subject":"[RTN-X] f","body_text":"t"}'),
  null, 'a stale status (reply_received on a sent case) writes nothing');
select results_eq(
  $$select status::text, send_count, next_action_at,
      (select count(*) from public.case_events e where e.case_id = c.id),
      (select count(*) from public.messages m where m.case_id = c.id)
    from public.cases c where id = '00000000-0000-4000-8000-0000000007c7'$$,
  $$values ('sent', 1, null::timestamptz, 0::bigint, 0::bigint)$$,
  'after the stale guards the case, its events and the outbox are unchanged'
);

-- Happy path: a reminder.
select isnt(public.claims_apply_timer_action(
  '00000000-0000-4000-8000-0000000007c7', 'sent', 1, false, 'sent', 1, '2026-03-12T09:00:00Z',
  '{"action":"reminder_d12","day":12}',
  '{"recipient":"operator","template":"reminder_d12","from":"r@example.test","to":"op@example.test","subject":"[RTN-X] s","body_text":"t"}'),
  null, 'a due reminder is applied');
select results_eq(
  $$select status::text, send_count, next_action_at from public.cases
    where id = '00000000-0000-4000-8000-0000000007c7'$$,
  $$values ('sent', 2, '2026-03-12T09:00:00Z'::timestamptz)$$,
  'send_count and next_action_at are updated'
);
select results_eq(
  $$select direction::text, status::text, to_address from public.messages
    where case_id = '00000000-0000-4000-8000-0000000007c7'$$,
  $$values ('outbound', 'queued', 'op@example.test')$$,
  'the reminder is queued in the outbox'
);

-- The same action again (another tick, same snapshot after the count moved): nothing.
select is(public.claims_apply_timer_action(
  '00000000-0000-4000-8000-0000000007c7', 'sent', 2, false, 'sent', 1, null,
  '{"action":"reminder_d12","day":12}',
  '{"recipient":"operator","template":"reminder_d12","from":"r@example.test","to":"op@example.test","subject":"[RTN-X] s","body_text":"t"}'),
  null, 'an action that already fired writes nothing');
select results_eq(
  $$select send_count, (select count(*) from public.messages m where m.case_id = c.id)
    from public.cases c where id = '00000000-0000-4000-8000-0000000007c7'$$,
  $$values (2, 1::bigint)$$,
  'the duplicate left send_count and the outbox as they were'
);

-- The escalation also records that a filing with DGTT / Junta is owed.
select isnt(public.claims_apply_timer_action(
  '00000000-0000-4000-8000-0000000007c7', 'sent', 2, false, 'escalated', 1, null,
  '{"action":"escalation_d45","day":45}',
  '{"recipient":"operator","template":"escalation_d45","from":"r@example.test","to":"op@example.test","subject":"[RTN-X] e","body_text":"t"}',
  '[{"kind":"escalation_filing_required","data":{"day":45}}]'),
  null, 'the escalation is applied');
select is((select count(*) from public.case_events
  where case_id = '00000000-0000-4000-8000-0000000007c7' and kind = 'escalation_filing_required'),
  1::bigint, 'an escalation_filing_required event is recorded');
select throws_ok(
  $$select public.claims_apply_timer_action(
    '00000000-0000-4000-8000-0000000007c7', 'escalated', 3, false, 'escalated', 0, null,
    '{"action":"x","day":1}',
    '{"recipient":"operator","template":"x","from":"r@example.test","to":"op@example.test","subject":"s","body_text":"t"}',
    '[{"kind":"approved","data":{}}]')$$,
  '22023', null, 'only allowlisted extra events');

-- The close: the user notice is queued with a user_notice_queued event pointing at it.
select isnt(public.claims_apply_timer_action(
  '00000000-0000-4000-8000-0000000007c7', 'escalated', 3, false, 'closed', 0, null,
  '{"action":"close_3m","day":89}',
  '{"recipient":"user","template":"user_final_result","from":"r@example.test","to":"viajero@example.test","subject":"[RTN-X] f","body_text":"t"}'),
  null, 'the close is applied');
select results_eq(
  $$select e.data->>'template', (e.data->>'message_id')::uuid = m.id
    from public.case_events e join public.messages m on m.case_id = e.case_id
      and m.to_address = 'viajero@example.test'
    where e.case_id = '00000000-0000-4000-8000-0000000007c7' and e.kind = 'user_notice_queued'$$,
  $$values ('user_final_result', true)$$,
  'the user notice event points at the queued notice'
);

select * from finish();
rollback;
