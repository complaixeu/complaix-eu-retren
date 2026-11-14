-- The team view (docs/plans/C-claims.md C9): the allowlist of team emails and is_team_member().
--
-- Who may open /equipo: a Supabase Auth user whose address is on team_members AND is confirmed.
-- Confirmation matters: sign-ups are open on the Auth project, so without it anyone could claim a
-- team address. The page reads data server-side with the service role, but only after the server
-- has checked is_team_member() with the visitor's own token. Writes to the allowlist are made by
-- an owner or the service role only (no grant, no policy for anyone else).
--
-- Also: messages.team_resolved_at, how the team marks an inbound mail with no case as handled
-- (mail with a case is resolved by a `team_queue_resolved` event). Additive and nullable.

create table public.team_members (
  email text primary key
    check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  created_at timestamptz not null default now()
);

comment on table public.team_members is
  'Allowlist of team emails that may open /equipo (C9). Written by the service role only.';

alter table public.team_members enable row level security;
revoke all on table public.team_members from public, anon, authenticated;
grant select on table public.team_members to authenticated;

-- Is the caller a confirmed Auth user whose address is on the allowlist? The user id must match
-- the address, so a token's email claim alone proves nothing. SECURITY DEFINER to read auth.users;
-- it only ever answers about the caller (auth.uid()).
create function public.is_team_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    join public.team_members m on m.email = lower(u.email)
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  )
$$;

revoke all on function public.is_team_member() from public, anon;
grant execute on function public.is_team_member() to authenticated;

-- A member sees only their own allowlist row: the list of colleagues is not exposed.
create policy team_members_read_own on public.team_members
  for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')) and public.is_team_member());

alter table public.messages add column team_resolved_at timestamptz;

comment on column public.messages.team_resolved_at is
  'Set when the team marked an inbound mail with no case as handled (C9). Never cleared.';

-- A queue item is resolved once, even when two people click at the same moment: the database
-- refuses the second `team_queue_resolved` event for the same item (23505).
create unique index case_events_team_resolved_once
  on public.case_events (case_id, (data ->> 'resolves'))
  where kind = 'team_queue_resolved';
