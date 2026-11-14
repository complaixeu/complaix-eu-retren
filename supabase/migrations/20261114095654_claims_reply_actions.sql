-- Actions per reply category (docs/plans/C-claims.md C6, ARCHITECTURE §5–§7).
--
-- supabase-js has no transactions, so every action is one function: the case's state change,
-- its events and the queued mails (the outbox, docs/plans/README.md §4) are written together or
-- not at all. The TypeScript side (features/claims/actions.ts) decides the action from the pure
-- category → action table; these functions lock the case, check that it is still in the state
-- the action was planned from, and enforce the rules that must hold whatever the caller sends.
-- Server only, like the tables: the API roles can't execute any of them. Additive: new functions,
-- one partial index and one private storage bucket; nothing existing changes.
--
-- Error codes: 40001 the case changed since it was read (the caller re-reads and re-plans);
-- 23505 a second insistence; RT403 a recipient that isn't the case's operator address;
-- 22023 a plan that breaks any other rule; P0002 an unknown case.

-- Only one insistence after a denial, ever (ARCHITECTURE §6). The functions check it too; the
-- index makes two concurrent denials unable to both record one.
create unique index case_events_insistence_once
  on public.case_events (case_id)
  where kind = 'reply_action' and data ->> 'event' = 'insistence_sent';

-- The documents a user sends when the operator asks for something only they have (IBAN, bank
-- certificate, ID copy, ARCHITECTURE §7.1). Private, and no storage policy names it: only the
-- service role (which bypasses RLS) reads or writes it. Each file is deleted once its mail is sent.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'claims-user-documents', 'claims-user-documents', false, 10485760,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do nothing;

-- Most mails to an operator for one case (MAX_SENDS_PER_CASE in features/claims/timers.ts).
-- send_count goes up when an operator mail is queued. The last slot is reserved for the d45
-- escalation (C7), so a reply's mail (the insistence, a forwarded document) needs
-- send_count < claims_max_sends_per_case() - 1. User notices don't count.
create function public.claims_max_sends_per_case()
returns integer
language sql
immutable
set search_path = ''
as $$ select 6 $$;

-- The operator address of a case: where its first operator mail (the initial claim, C3) went.
-- Null until that mail exists. Any later operator mail must go to this same address. Mail to the
-- case user (in any capitalisation) is a notice, never the operator's.
create function public.claims_case_operator_address(p_case_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select m.to_address
  from public.messages m
  join public.cases c on c.id = m.case_id
  where m.case_id = p_case_id and m.direction = 'outbound'
    and lower(m.to_address) <> lower(c.user_email)
  order by m.created_at, m.id
  limit 1
$$;

-- Applies the action planned for one operator reply (`p_message_id`, an inbound message of the
-- case, gets `p_category`). p_plan:
--   steps:             [{event, from, to}] state-machine moves, chained from p_expected_status;
--   team_queue_reason: a reason code for the team queue (C9); it may come with steps (a denial
--                      that can't be answered still moves the case to denied) but never with mail;
--   outbox:            [{audience: user | operator, template, from, to, subject, body_text,
--                       in_reply_to?}];
--   next_action_at:    present → set to this value (null clears it); absent → kept.
-- Event data holds ids and codes only, no personal data; events get clock_timestamp() so their
-- order is the order they happened in. Returns {status, message_ids}.
create function public.claims_apply_reply_action(
  p_case_id uuid,
  p_message_id uuid,
  p_category public.reply_category,
  p_expected_status public.case_status,
  p_expected_send_count integer,
  p_plan jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case public.cases%rowtype;
  v_steps jsonb := coalesce(p_plan -> 'steps', '[]'::jsonb);
  v_outbox jsonb := coalesce(p_plan -> 'outbox', '[]'::jsonb);
  v_reason text := p_plan ->> 'team_queue_reason';
  v_status public.case_status;
  v_send_count integer;
  v_insisted boolean := false;
  v_step jsonb;
  v_mail jsonb;
  v_template text;
  v_message uuid;
  v_ids jsonb := '[]'::jsonb;
begin
  select * into v_case from public.cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'P0002';
  end if;
  if v_case.status <> p_expected_status or v_case.send_count <> p_expected_send_count then
    raise exception 'case % changed since it was read', p_case_id using errcode = '40001';
  end if;

  perform 1 from public.messages
  where id = p_message_id and case_id = p_case_id and direction = 'inbound';
  if not found then
    raise exception 'message % is not an inbound message of the case', p_message_id
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_steps) <> 'array' or jsonb_typeof(v_outbox) <> 'array' then
    raise exception 'steps and outbox must be arrays' using errcode = '22023';
  end if;
  if v_reason is not null then
    if jsonb_array_length(v_outbox) > 0 then
      raise exception 'a team queue item queues no mail' using errcode = '22023';
    end if;
  elsif jsonb_array_length(v_steps) = 0 then
    raise exception 'an action needs at least one step or a team queue reason' using errcode = '22023';
  end if;

  v_status := v_case.status;
  v_send_count := v_case.send_count;

  for v_step in select * from jsonb_array_elements(v_steps) loop
    if (v_step ->> 'from')::public.case_status is distinct from v_status then
      raise exception 'steps must chain from the case status' using errcode = '22023';
    end if;
    if v_step ->> 'event' = 'insistence_sent' then
      if exists (
        select 1 from public.case_events
        where case_id = p_case_id and kind = 'reply_action' and data ->> 'event' = 'insistence_sent'
      ) then
        raise exception 'case % already had its one insistence', p_case_id using errcode = '23505';
      end if;
      v_insisted := true;
    end if;
    insert into public.case_events (case_id, kind, from_status, to_status, data, created_at)
    values (
      p_case_id, 'reply_action', v_status, (v_step ->> 'to')::public.case_status,
      jsonb_build_object('event', v_step ->> 'event', 'category', p_category, 'message_id', p_message_id),
      clock_timestamp()
    );
    v_status := (v_step ->> 'to')::public.case_status;
  end loop;

  if v_reason is not null then
    insert into public.case_events (case_id, kind, data, created_at)
    values (
      p_case_id, 'team_queue',
      jsonb_build_object('reason', v_reason, 'category', p_category, 'message_id', p_message_id),
      clock_timestamp()
    );
  end if;

  for v_mail in select * from jsonb_array_elements(v_outbox) loop
    v_template := v_mail ->> 'template';
    if v_mail ->> 'audience' = 'user' then
      -- The user hears from us only for a document request or the final result (ARCHITECTURE §7),
      -- and only at the case's own address.
      if v_template not in ('user_request_document', 'user_final_result') then
        raise exception 'notice % is not allowed to the user', v_template using errcode = '22023';
      end if;
      if v_mail ->> 'to' is distinct from v_case.user_email then
        raise exception 'a notice must go to the case user' using errcode = '22023';
      end if;
    elsif v_mail ->> 'audience' = 'operator' then
      -- The only operator mail a reply triggers is the one insistence after a denial, to the
      -- address the claim went to.
      if v_template is distinct from 'insistence_after_denial' or not v_insisted then
        raise exception 'operator mail % is not allowed here', v_template using errcode = '22023';
      end if;
      if v_mail ->> 'to' is distinct from public.claims_case_operator_address(p_case_id) then
        raise exception 'the recipient is not the operator address of case %', p_case_id
          using errcode = 'RT403';
      end if;
      v_send_count := v_send_count + 1;
      if v_send_count > public.claims_max_sends_per_case() - 1 then
        raise exception 'case % reached the send cap', p_case_id using errcode = '22023';
      end if;
    else
      raise exception 'unknown audience' using errcode = '22023';
    end if;

    insert into public.messages (
      case_id, direction, from_address, to_address, subject, in_reply_to, status, body_text
    )
    values (
      p_case_id, 'outbound', v_mail ->> 'from', v_mail ->> 'to', v_mail ->> 'subject',
      v_mail ->> 'in_reply_to', 'queued', v_mail ->> 'body_text'
    )
    returning id into v_message;

    insert into public.case_events (case_id, kind, data, created_at)
    values (
      p_case_id,
      case v_mail ->> 'audience' when 'user' then 'user_notice_queued' else 'operator_mail_queued' end,
      jsonb_build_object('template', v_template, 'message_id', v_message),
      clock_timestamp()
    );
    v_ids := v_ids || to_jsonb(v_message);
  end loop;

  if v_insisted and v_send_count = v_case.send_count then
    raise exception 'an insistence must queue its mail' using errcode = '22023';
  end if;

  update public.cases
  set status = v_status,
      send_count = v_send_count,
      next_action_at = case
        when p_plan ? 'next_action_at' then (p_plan ->> 'next_action_at')::timestamptz
        else next_action_at
      end
  where id = p_case_id;

  update public.messages set category = p_category where id = p_message_id;

  return jsonb_build_object('status', v_status, 'message_ids', v_ids);
end;
$$;

-- Puts a reply in the team queue without touching the case (the fallback when an action can't be
-- applied: retries ran out). Idempotent: the same reason for the same reply is recorded once.
-- The reason is a code (lower case and underscores), never free text. Returns true when it
-- recorded the item.
create function public.claims_queue_for_team(
  p_case_id uuid,
  p_message_id uuid,
  p_category public.reply_category,
  p_reason text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_data jsonb;
begin
  perform 1 from public.cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'P0002';
  end if;
  perform 1 from public.messages
  where id = p_message_id and case_id = p_case_id and direction = 'inbound';
  if not found then
    raise exception 'message % is not an inbound message of the case', p_message_id
      using errcode = '22023';
  end if;
  if p_reason is null or p_reason !~ '^[a-z_]+$' then
    raise exception 'a team queue reason must be a code' using errcode = '22023';
  end if;

  v_data := jsonb_build_object('reason', p_reason, 'category', p_category, 'message_id', p_message_id);
  if exists (
    select 1 from public.case_events
    where case_id = p_case_id and kind = 'team_queue' and data @> v_data
  ) then
    return false;
  end if;
  insert into public.case_events (case_id, kind, data, created_at)
  values (p_case_id, 'team_queue', v_data, clock_timestamp());
  update public.messages set category = p_category where id = p_message_id;
  return true;
end;
$$;

-- Queues the user's document to the operator (ARCHITECTURE §7.1) and moves the case
-- waiting_user → sent. p_mail: {from, to, subject, body_text, in_reply_to?}; `to` must be the
-- address the claim went to (RT403 otherwise, and when no claim went out yet). The attachment is
-- linked to the queued message and kept: purgeForwardedDocuments deletes it once the mail is sent.
-- With no slot left below the one reserved for d45, nothing is queued: the case goes to the team
-- queue (`send_cap`, once per attachment). Returns {message_id} or {team_queue: 'send_cap'}.
create function public.claims_forward_user_document(
  p_case_id uuid,
  p_attachment_id uuid,
  p_expected_send_count integer,
  p_mail jsonb,
  p_next_action_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case public.cases%rowtype;
  v_attachment public.attachments%rowtype;
  v_message uuid;
  v_data jsonb;
begin
  select * into v_case from public.cases where id = p_case_id for update;
  if not found then
    raise exception 'case % not found', p_case_id using errcode = 'P0002';
  end if;
  if v_case.status <> 'waiting_user' then
    raise exception 'case % is not waiting on the user', p_case_id using errcode = '22023';
  end if;
  if v_case.send_count <> p_expected_send_count then
    raise exception 'case % changed since it was read', p_case_id using errcode = '40001';
  end if;

  select * into v_attachment from public.attachments
  where id = p_attachment_id and case_id = p_case_id for update;
  if not found or v_attachment.kind <> 'user_document' or v_attachment.deleted_at is not null
    or v_attachment.message_id is not null then
    raise exception 'attachment % is not an unsent user document of the case', p_attachment_id
      using errcode = '22023';
  end if;

  if p_mail ->> 'to' is distinct from public.claims_case_operator_address(p_case_id) then
    raise exception 'the recipient is not the operator address of case %', p_case_id
      using errcode = 'RT403';
  end if;

  if v_case.send_count + 1 > public.claims_max_sends_per_case() - 1 then
    v_data := jsonb_build_object('reason', 'send_cap', 'attachment_id', p_attachment_id);
    if not exists (
      select 1 from public.case_events
      where case_id = p_case_id and kind = 'team_queue' and data @> v_data
    ) then
      insert into public.case_events (case_id, kind, data, created_at)
      values (p_case_id, 'team_queue', v_data, clock_timestamp());
    end if;
    return jsonb_build_object('team_queue', 'send_cap');
  end if;

  insert into public.messages (
    case_id, direction, from_address, to_address, subject, in_reply_to, status, body_text
  )
  values (
    p_case_id, 'outbound', p_mail ->> 'from', p_mail ->> 'to', p_mail ->> 'subject',
    p_mail ->> 'in_reply_to', 'queued', p_mail ->> 'body_text'
  )
  returning id into v_message;

  update public.attachments set message_id = v_message where id = p_attachment_id;

  update public.cases
  set status = 'sent', send_count = send_count + 1, next_action_at = p_next_action_at
  where id = p_case_id;

  insert into public.case_events (case_id, kind, from_status, to_status, data, created_at)
  values (
    p_case_id, 'user_document_forwarded', 'waiting_user', 'sent',
    jsonb_build_object('attachment_id', p_attachment_id, 'message_id', v_message),
    clock_timestamp()
  );
  insert into public.case_events (case_id, kind, data, created_at)
  values (
    p_case_id, 'operator_mail_queued',
    jsonb_build_object('template', 'reply_asks_for_data', 'message_id', v_message),
    clock_timestamp()
  );

  return jsonb_build_object('message_id', v_message);
end;
$$;

-- Marks the user documents of a sent message deleted (their files were just removed from
-- storage), with one `user_document_deleted` event. Only for an outbound message that is `sent`
-- (22023 while it is queued or failed: the sender still needs the file). Idempotent: returns how
-- many documents it marked, 0 when they already were.
create function public.claims_mark_forwarded_documents_deleted(p_message_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_message public.messages%rowtype;
  v_ids jsonb;
  v_count integer;
begin
  select * into v_message from public.messages where id = p_message_id for update;
  if not found or v_message.direction <> 'outbound' or v_message.status <> 'sent' then
    raise exception 'message % is not a sent outbound message', p_message_id using errcode = '22023';
  end if;

  with marked as (
    update public.attachments
    set deleted_at = now()
    where message_id = p_message_id and kind = 'user_document' and deleted_at is null
    returning id
  )
  select coalesce(jsonb_agg(id order by id), '[]'::jsonb), count(*) into v_ids, v_count from marked;

  if v_count > 0 then
    insert into public.case_events (case_id, kind, data, created_at)
    values (
      v_message.case_id, 'user_document_deleted',
      jsonb_build_object('message_id', p_message_id, 'attachment_ids', v_ids),
      clock_timestamp()
    );
  end if;
  return v_count;
end;
$$;

revoke all on function public.claims_max_sends_per_case() from public, anon, authenticated;
revoke all on function public.claims_case_operator_address(uuid) from public, anon, authenticated;
revoke all on function public.claims_apply_reply_action(
  uuid, uuid, public.reply_category, public.case_status, integer, jsonb
) from public, anon, authenticated;
revoke all on function public.claims_queue_for_team(uuid, uuid, public.reply_category, text)
  from public, anon, authenticated;
revoke all on function public.claims_forward_user_document(uuid, uuid, integer, jsonb, timestamptz)
  from public, anon, authenticated;
revoke all on function public.claims_mark_forwarded_documents_deleted(uuid)
  from public, anon, authenticated;

grant execute on function public.claims_max_sends_per_case() to service_role;
grant execute on function public.claims_case_operator_address(uuid) to service_role;
grant execute on function public.claims_apply_reply_action(
  uuid, uuid, public.reply_category, public.case_status, integer, jsonb
) to service_role;
grant execute on function public.claims_queue_for_team(uuid, uuid, public.reply_category, text)
  to service_role;
grant execute on function public.claims_forward_user_document(uuid, uuid, integer, jsonb, timestamptz)
  to service_role;
grant execute on function public.claims_mark_forwarded_documents_deleted(uuid) to service_role;
