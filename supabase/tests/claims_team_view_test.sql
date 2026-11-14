-- The team view's allowlist (migration *_claims_team_view.sql, docs/plans/C-claims.md C9).
begin;
select plan(26);

select has_table('public', 'team_members', 'team_members exists');
select ok((select relrowsecurity from pg_class where oid = 'public.team_members'::regclass),
  'RLS is on for team_members');
select has_function('public', 'is_team_member', array[]::text[], 'is_team_member() exists');
select has_column('public', 'messages', 'team_resolved_at', 'messages.team_resolved_at exists');
select throws_ok($$insert into public.team_members (email) values ('Mixed@Case.test')$$, '23514', null,
  'an allowlisted email must be lower case');
select throws_ok($$insert into public.team_members (email) values ('not-an-email')$$, '23514', null,
  'an allowlisted email must look like an email');

-- Fixtures, inserted as the owner. Nothing here is real data.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000000', 'authenticated',
   'authenticated', 'equipo.uno@retren.test', now(), now(), now()),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-000000000000', 'authenticated',
   'authenticated', 'fuera@retren.test', now(), now(), now()),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-000000000000', 'authenticated',
   'authenticated', 'equipo.dos@retren.test', null, now(), now());
insert into public.team_members (email)
values ('equipo.uno@retren.test'), ('equipo.dos@retren.test'), ('otro@retren.test');

-- anon: no table access, no function.
set local role anon;
select throws_ok($$select count(*) from public.team_members$$, '42501', null, 'anon cannot read the allowlist');
select throws_ok($$insert into public.team_members (email) values ('anon@retren.test')$$, '42501', null,
  'anon cannot add to the allowlist');
select throws_ok($$select public.is_team_member()$$, '42501', null, 'anon cannot call is_team_member()');
reset role;

-- A confirmed user on the allowlist.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","email":"equipo.uno@retren.test","role":"authenticated"}';
select is(public.is_team_member(), true, 'a confirmed user on the allowlist is a team member');
select is((select count(*) from public.team_members), 1::bigint, 'a member reads only their own allowlist row');
select is((select email from public.team_members), 'equipo.uno@retren.test', 'and it is theirs');
select throws_ok($$insert into public.team_members (email) values ('yo@retren.test')$$, '42501', null,
  'a member cannot add to the allowlist');
select throws_ok($$update public.team_members set email = 'x@retren.test'$$, '42501', null,
  'a member cannot change the allowlist');
select throws_ok($$delete from public.team_members$$, '42501', null, 'a member cannot delete from the allowlist');
select throws_ok($$select count(*) from public.cases$$, '42501', null, 'being on the allowlist opens no claims table');

-- A user that is not on the allowlist.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2","email":"fuera@retren.test","role":"authenticated"}';
select is(public.is_team_member(), false, 'a user off the allowlist is not a team member');
select is((select count(*) from public.team_members), 0::bigint, 'and sees no allowlist row');

-- On the allowlist but the address is not confirmed: signing up with someone else's address is not enough.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c3","email":"equipo.dos@retren.test","role":"authenticated"}';
select is(public.is_team_member(), false, 'an unconfirmed address on the allowlist is not a team member');

-- A token claiming an allowlisted email with a different user id is not a member either.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c2","email":"equipo.uno@retren.test","role":"authenticated"}';
select is(public.is_team_member(), false, 'the email claim alone proves nothing: the user id must match');

-- The mixed-case claim of a real member still matches.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1","email":"Equipo.Uno@Retren.test","role":"authenticated"}';
select is(public.is_team_member(), true, 'the match is case-insensitive');
reset role;

-- A queue item is resolved once: the second resolution is refused by the database.
insert into public.cases (id, operator, status, submission, user_email)
values ('00000000-0000-0000-0000-0000000000d1', 'iryo', 'sent', '{}', 'x@example.test'),
       ('00000000-0000-0000-0000-0000000000d2', 'iryo', 'sent', '{}', 'x@example.test');
select lives_ok($$insert into public.case_events (case_id, kind, data)
  values ('00000000-0000-0000-0000-0000000000d1', 'team_queue_resolved', '{"resolves":"e1"}')$$,
  'a queue item can be resolved');
select throws_ok($$insert into public.case_events (case_id, kind, data)
  values ('00000000-0000-0000-0000-0000000000d1', 'team_queue_resolved', '{"resolves":"e1"}')$$,
  '23505', null, 'resolving the same item twice is refused');
select lives_ok($$insert into public.case_events (case_id, kind, data)
  values ('00000000-0000-0000-0000-0000000000d1', 'team_queue_resolved', '{"resolves":"e2"}')$$,
  'another item of the same case can be resolved');
select lives_ok($$insert into public.case_events (case_id, kind, data)
  values ('00000000-0000-0000-0000-0000000000d2', 'team_queue_resolved', '{"resolves":"e1"}')$$,
  'the same id on another case is not a clash');
select lives_ok($$insert into public.case_events (case_id, kind, data)
  values ('00000000-0000-0000-0000-0000000000d1', 'message_sent', '{"resolves":"e1"}')$$,
  'other event kinds are not constrained');

select * from finish();
rollback;
