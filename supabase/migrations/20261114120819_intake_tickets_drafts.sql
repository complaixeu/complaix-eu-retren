-- Ticket storage and intake drafts (docs/plans/A-intake.md A1).
--
-- 1. A private storage bucket `tickets` for the original ticket photos and PDFs. No storage
--    policy names it, so only the service role (which bypasses RLS) reads or writes it.
-- 2. intake_drafts: the server-side state of one claim in progress. RLS on, no policies, and no
--    table privileges for anon or authenticated: server-only, through the service role. The
--    browser only holds the draft id, in an httpOnly cookie.
-- 3. intake_merge_draft_data: merges a patch into a draft's data in one statement, so later
--    steps (A3 extraction, A4 review, A5 answers) never overwrite each other's keys.
-- Nothing existing changes.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tickets', 'tickets', false, 10485760,
  array['image/jpeg', 'image/png', 'image/heic', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Grows with the flow: later tasks add states with `alter type ... add value`.
create type public.intake_draft_status as enum ('uploaded');

create table public.intake_drafts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Set by the server (features/intake/draft/ttl.ts); no default on purpose.
  expires_at timestamptz not null,
  status public.intake_draft_status not null default 'uploaded',
  -- Key inside the `tickets` bucket (random, unrelated to the id), plus what the upload step
  -- shows back: the detected content type, the user's file name and the size.
  ticket_path text unique,
  ticket_content_type text,
  ticket_filename text,
  ticket_size_bytes integer,
  -- Step data; each step owns its top-level keys.
  data jsonb not null default '{}'::jsonb,
  constraint intake_drafts_data_is_object check (jsonb_typeof(data) = 'object'),
  constraint intake_drafts_expires_after_created check (expires_at > created_at),
  constraint intake_drafts_ticket_all_or_none check (
    num_nulls(ticket_path, ticket_content_type, ticket_filename, ticket_size_bytes) in (0, 4)
  ),
  constraint intake_drafts_ticket_content_type check (
    ticket_content_type in ('image/jpeg', 'image/png', 'image/heic', 'application/pdf')
  ),
  constraint intake_drafts_ticket_size check (ticket_size_bytes between 1 and 10485760),
  constraint intake_drafts_ticket_filename_length check (char_length(ticket_filename) <= 120)
);

comment on table public.intake_drafts is
  'A claim in progress (intake, A1). Server-only: RLS on, no policies, no anon/authenticated grants.';

-- For a later clean-up of expired drafts.
create index intake_drafts_expires_at on public.intake_drafts (expires_at);

alter table public.intake_drafts enable row level security;
revoke all on table public.intake_drafts from anon, authenticated;

-- Merges p_patch into data (top-level keys of the patch replace the draft's), optionally moves
-- the status, and returns the updated row; no row if the draft is unknown or expired at p_now.
create function public.intake_merge_draft_data(
  p_id uuid,
  p_patch jsonb,
  p_status public.intake_draft_status default null,
  p_now timestamptz default now()
)
returns setof public.intake_drafts
language plpgsql
set search_path = ''
as $$
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'intake_merge_draft_data: the patch must be a JSON object'
      using errcode = '22023';
  end if;
  return query
    update public.intake_drafts d
    set data = d.data || p_patch,
        status = coalesce(p_status, d.status),
        updated_at = p_now
    where d.id = p_id and d.expires_at > p_now
    returning d.*;
end;
$$;

revoke all on function public.intake_merge_draft_data(uuid, jsonb, public.intake_draft_status, timestamptz)
  from public, anon, authenticated;
grant execute on function public.intake_merge_draft_data(uuid, jsonb, public.intake_draft_status, timestamptz)
  to service_role;
