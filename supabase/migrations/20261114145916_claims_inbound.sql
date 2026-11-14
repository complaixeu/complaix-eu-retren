-- Inbound mail over IMAP (docs/plans/C-claims.md C4, docs/plans/README.md §4).
--
-- 1. A private storage bucket for the raw MIME of every inbound mail we keep (claim mail only:
--    unrelated mail is never stored).
-- 2. claims_mail_poll_state: where pollInbox() got to in the mailbox (last UID and UIDVALIDITY),
--    and the mail that keeps failing, if any.
-- 3. messages.inbound_queue_reason: why an inbound mail went to the team queue when it arrived.
--    Mail that matched no case has no case_events row to carry it, so the reason lives here.
-- 4. claims_record_inbound: records one inbound mail, and either applies `operator_replied` to its
--    case or puts it in the team queue, in one transaction (the C2/C6 plpgsql pattern).
-- Server only, like the other claims tables. Additive: nothing existing changes.

-- Raw inbound mail. Private, and no storage policy names it: only the service role reads it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('claims-inbound-mail', 'claims-inbound-mail', false, 52428800, array['message/rfc822'])
on conflict (id) do nothing;

-- One row per mailbox folder pollInbox() reads (today only INBOX). The first run stores the
-- mailbox's current last UID, so mail that was already there is never imported. A different
-- UIDVALIDITY means the UIDs were renumbered: it starts again from the current UID.
create table public.claims_mail_poll_state (
  mailbox text primary key check (length(mailbox) > 0),
  uid_validity bigint not null check (uid_validity > 0),
  last_uid bigint not null check (last_uid >= 0),
  -- The mail that failed last and how many runs in a row it failed. After 3, pollInbox puts it
  -- in the team queue (its UID and a code only) and moves past it, so one bad mail never blocks
  -- the mailbox. Null: nothing is failing.
  failed_uid bigint check (failed_uid is null or failed_uid > 0),
  failed_attempts integer check (failed_attempts is null or failed_attempts >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.claims_mail_poll_state is
  'IMAP progress of pollInbox (C4): last processed UID per mailbox and its UIDVALIDITY. Server only.';

alter table public.claims_mail_poll_state enable row level security;
revoke all on table public.claims_mail_poll_state from public, anon, authenticated;

alter table public.messages
  -- A reason code (lower case and underscores), set when C4 put the inbound mail in the team queue.
  add column inbound_queue_reason text
    check (inbound_queue_reason is null or inbound_queue_reason ~ '^[a-z_]+$');

comment on column public.messages.inbound_queue_reason is
  'Why C4 sent this inbound mail to the team queue (wrong_sender, unknown_reference, …).';

-- The team queue's inbound mail without a case (unknown reference): C9 lists it.
create index messages_inbound_queue_idx on public.messages (created_at)
  where direction = 'inbound' and inbound_queue_reason is not null;

-- Records one inbound mail. p_message: {from, to, subject, message_id, in_reply_to?,
-- references?: [..], body_text?, raw_path?}; message_id is required (the caller derives one when
-- the mail has none). Then exactly one of:
--   p_to_status set:    the case moves p_expected_status → p_to_status (`operator_replied`, from
--                       transition() in TypeScript), with an `operator_replied` event. 40001 when
--                       the case is no longer in p_expected_status (the caller re-reads);
--   p_queue_reason set: the team queue, with a `team_queue` event when the mail has a case;
--   neither:            only recorded, linked to its case (the user's document reply).
-- Idempotent: a Message-ID already stored returns {duplicate: true} and changes nothing.
-- Event data holds ids and codes only. Returns {message_id, duplicate}.
create function public.claims_record_inbound(
  p_message jsonb,
  p_case_id uuid,
  p_expected_status public.case_status,
  p_to_status public.case_status,
  p_queue_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case public.cases%rowtype;
  v_id uuid;
  v_refs text[];
begin
  if coalesce(p_message ->> 'message_id', '') = '' then
    raise exception 'an inbound mail needs a Message-ID' using errcode = '22023';
  end if;
  if p_queue_reason is not null and p_queue_reason !~ '^[a-z_]+$' then
    raise exception 'a team queue reason must be a code' using errcode = '22023';
  end if;
  if p_to_status is not null and (p_case_id is null or p_expected_status is null
    or p_queue_reason is not null) then
    raise exception 'a status change needs a case, its expected status and no queue reason'
      using errcode = '22023';
  end if;
  if p_case_id is null and p_queue_reason is null then
    raise exception 'mail without a case goes to the team queue' using errcode = '22023';
  end if;

  if p_case_id is not null then
    select * into v_case from public.cases where id = p_case_id for update;
    if not found then
      raise exception 'case % not found', p_case_id using errcode = 'P0002';
    end if;
  end if;

  select id into v_id from public.messages where message_id = p_message ->> 'message_id';
  if found then
    return jsonb_build_object('message_id', v_id, 'duplicate', true);
  end if;

  if p_to_status is not null and v_case.status <> p_expected_status then
    raise exception 'case % changed since it was read', p_case_id using errcode = '40001';
  end if;

  if jsonb_typeof(p_message -> 'references') = 'array' then
    select array_agg(r) into v_refs from jsonb_array_elements_text(p_message -> 'references') r;
  end if;

  insert into public.messages (
    case_id, direction, from_address, to_address, subject, message_id, in_reply_to,
    thread_references, status, body_text, raw_path, inbound_queue_reason
  )
  values (
    p_case_id, 'inbound', coalesce(p_message ->> 'from', ''), coalesce(p_message ->> 'to', ''),
    coalesce(p_message ->> 'subject', ''), p_message ->> 'message_id', p_message ->> 'in_reply_to',
    v_refs, 'received', p_message ->> 'body_text', p_message ->> 'raw_path', p_queue_reason
  )
  on conflict (message_id) where message_id is not null do nothing
  returning id into v_id;

  if v_id is null then
    -- A concurrent ingestion stored it first.
    select id into v_id from public.messages where message_id = p_message ->> 'message_id';
    return jsonb_build_object('message_id', v_id, 'duplicate', true);
  end if;

  if p_to_status is not null then
    update public.cases set status = p_to_status where id = p_case_id;
    insert into public.case_events (case_id, kind, from_status, to_status, data, created_at)
    values (
      p_case_id, 'operator_replied', v_case.status, p_to_status,
      jsonb_build_object('message_id', v_id), clock_timestamp()
    );
  end if;

  if p_queue_reason is not null and p_case_id is not null then
    insert into public.case_events (case_id, kind, data, created_at)
    values (
      p_case_id, 'team_queue',
      jsonb_build_object('source', 'inbound', 'reason', p_queue_reason, 'message_id', v_id),
      clock_timestamp()
    );
  end if;

  return jsonb_build_object('message_id', v_id, 'duplicate', false);
end;
$$;

revoke all on function public.claims_record_inbound(
  jsonb, uuid, public.case_status, public.case_status, text
) from public, anon, authenticated;
grant execute on function public.claims_record_inbound(
  jsonb, uuid, public.case_status, public.case_status, text
) to service_role;
