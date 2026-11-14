-- Claims engine schema (docs/plans/C-claims.md C1, ARCHITECTURE §5–§7).
--
-- cases, case_events (append-only), messages (the transactional outbox and the inbound log) and
-- attachments. RLS is on and there are no policies: only the server, with the service role
-- (which bypasses RLS), reads or writes these tables. anon and authenticated have no grants.

-- The nine states of ARCHITECTURE §5. Must match CaseStatus in shared/contracts/case.ts.
create type public.case_status as enum (
  'draft',
  'waiting_period',
  'sent',
  'reply_received',
  'waiting_user',
  'escalated',
  'resolved',
  'denied',
  'closed'
);

-- The closed classifier categories. Must match ReplyCategory in shared/contracts/case.ts.
create type public.reply_category as enum (
  'acknowledgement',
  'asks_for_data',
  'approved',
  'denied',
  'refers_to_form',
  'other'
);

create type public.message_direction as enum ('outbound', 'inbound');
create type public.message_status as enum ('queued', 'sent', 'failed', 'received');

-- The attachment allowlist (docs/plans/README.md §4): EU form, mandate, ticket, user documents.
create type public.attachment_kind as enum ('eu_form', 'mandate', 'ticket', 'user_document');

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  -- Random, not sequential, so a reference can't be guessed from another one.
  public_ref text not null unique
    default ('RTN-' || upper(substr(md5(gen_random_uuid()::text), 1, 8)))
    check (public_ref ~ '^RTN-[A-Z0-9]+$'),
  -- OperatorId in shared/contracts/operator.ts.
  operator text not null check (operator in ('iryo', 'renfe', 'ouigo')),
  status public.case_status not null default 'draft',
  submission jsonb not null,
  eligibility jsonb,
  user_email text not null,
  earliest_send_at timestamptz,
  sent_at timestamptz,
  next_action_at timestamptz,
  send_count integer not null default 0 check (send_count >= 0),
  paused boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.cases is 'One claim per row (C1). Server only: RLS on, no policies.';

-- The tick (C7) looks for due, unpaused cases.
create index cases_next_action_at_idx on public.cases (next_action_at)
  where not paused and next_action_at is not null;

create table public.case_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete restrict,
  kind text not null check (length(kind) > 0),
  from_status public.case_status,
  to_status public.case_status,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.case_events is 'Append-only history of every case (C1). No UPDATE, DELETE or TRUNCATE.';

create index case_events_case_id_idx on public.case_events (case_id, created_at);

create function public.case_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'case_events is append-only' using errcode = 'P0001';
end;
$$;

revoke all on function public.case_events_append_only() from public, anon, authenticated;

create trigger case_events_no_update_delete
  before update or delete on public.case_events
  for each row execute function public.case_events_append_only();

create trigger case_events_no_truncate
  before truncate on public.case_events
  for each statement execute function public.case_events_append_only();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  -- Null for inbound mail that matched no case (it goes to the team queue, C4).
  case_id uuid references public.cases (id) on delete restrict,
  direction public.message_direction not null,
  from_address text not null,
  to_address text not null,
  subject text not null,
  -- RFC 5322 Message-ID and In-Reply-To, for threading and inbound matching.
  message_id text,
  in_reply_to text,
  -- Set by the classifier on inbound operator replies (C5).
  category public.reply_category,
  status public.message_status not null,
  body_text text,
  -- Path of the raw MIME in private storage (inbound, C4).
  raw_path text,
  created_at timestamptz not null default now()
);

comment on table public.messages is 'Outbox (queued → sent | failed) and inbound log (received) (C1). Server only.';

create index messages_case_id_idx on public.messages (case_id, created_at);
-- A Message-ID identifies one mail: storing it twice means a duplicate delivery.
create unique index messages_message_id_key on public.messages (message_id) where message_id is not null;

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases (id) on delete restrict,
  -- The message it was sent with or received in, if any.
  message_id uuid references public.messages (id) on delete restrict,
  kind public.attachment_kind not null,
  storage_path text not null,
  filename text not null,
  content_type text not null,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  created_at timestamptz not null default now(),
  -- Set when the stored file is deleted (a user document after forwarding, C6).
  deleted_at timestamptz
);

comment on table public.attachments is 'Files of a case (C1). Server only.';

create index attachments_case_id_idx on public.attachments (case_id);
create index attachments_message_id_idx on public.attachments (message_id);

-- Server only: RLS on with no policies, and no grants for the API roles.
alter table public.cases enable row level security;
alter table public.case_events enable row level security;
alter table public.messages enable row level security;
alter table public.attachments enable row level security;

revoke all on table public.cases, public.case_events, public.messages, public.attachments
  from public, anon, authenticated;
