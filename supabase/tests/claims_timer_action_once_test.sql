-- One timer action per case (migration *_claims_timer_action_once.sql, plan C7).
begin;
select plan(5);

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

select * from finish();
rollback;
