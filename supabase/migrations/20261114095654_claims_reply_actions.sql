-- Actions per reply category (docs/plans/C-claims.md C6, ARCHITECTURE §5–§7).
--
-- supabase-js has no transactions, so every action is one function: the case's state change,
-- its events and the queued mails (the outbox, docs/plans/README.md §4) are written together or
-- not at all. The TypeScript side (features/claims/actions.ts) decides the action from the pure
-- category → action table; these functions lock the case, check that it is still in the state
-- the action was planned from, and enforce the rules that must hold whatever the caller sends.
-- Server only, like the tables: the API roles can't execute any of them. Additive: new functions,
-- one partial index and one private storage bucket; nothing existing changes.

-- Only one insistence after a denial, ever (ARCHITECTURE §6). The functions check it too; the
-- index makes two concurrent denials unable to both record one.
create unique index case_events_insistence_once
  on public.case_events (case_id)
  where kind = 'reply_action' and data ->> 'event' = 'insistence_sent';

-- The documents a user sends when the operator asks for something only they have (IBAN, bank
-- certificate, ID copy, ARCHITECTURE §7.1). Private, and no storage policy names it: only the
-- service role (which bypasses RLS) reads or writes it. Each file is deleted once forwarded.
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

-- Applies the action planned for one operator reply (`p_message_id`, an inbound message of the
-- case, gets `p_category`). p_plan:
--   steps:             [{event, from, to}] state-machine moves, chained from p_expected_status;
--   team_queue_reason: a reason code; then there are no steps and no mails;
--   outbox:            [{audience: user | operator, template, from, to, subject, body_text,
--                       in_reply_to?}];
--   next_action_at:    present → set to this value (null clears it); absent → kept.
-- Raises 40001 when the case changed since it was read (the caller re-reads and re-plans),
-- 23505 for a second insistence, 22023 for a plan that breaks a rule. Event data holds ids and
-- codes only, no personal data; events get clock_timestamp() so their order is the order they
-- happened in. Returns {status, message_ids}.
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
    if jsonb_array_length(v_steps) > 0 or jsonb_array_length(v_outbox) > 0 then
      raise exception 'a team queue item changes nothing else' using errcode = '22023';
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
      -- The only operator mail a reply triggers is the one insistence after a denial.
      if v_template is distinct from 'insistence_after_denial' or not v_insisted then
        raise exception 'operator mail % is not allowed here', v_template using errcode = '22023';
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

-- Queues the user's document to the operator (ARCHITECTURE §7.1) and moves the case
-- waiting_user → sent. p_mail: {from, to, subject, body_text, in_reply_to?}; the caller resolves
-- `to` from the operator config and refuses any other address. The attachment is linked to the
-- queued message. Raises 40001 when the case changed since it was read, 22023 when the case isn't
-- waiting on the user, the attachment isn't an unsent user document of the case, or the send cap
-- is reached. Returns the queued message id.
create function public.claims_forward_user_document(
  p_case_id uuid,
  p_attachment_id uuid,
  p_expected_send_count integer,
  p_mail jsonb,
  p_next_action_at timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case public.cases%rowtype;
  v_attachment public.attachments%rowtype;
  v_message uuid;
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
  if v_case.send_count + 1 > public.claims_max_sends_per_case() - 1 then
    raise exception 'case % reached the send cap', p_case_id using errcode = '22023';
  end if;

  select * into v_attachment from public.attachments
  where id = p_attachment_id and case_id = p_case_id for update;
  if not found or v_attachment.kind <> 'user_document' or v_attachment.deleted_at is not null
    or v_attachment.message_id is not null then
    raise exception 'attachment % is not an unsent user document of the case', p_attachment_id
      using errcode = '22023';
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

  return v_message;
end;
$$;

-- Records that a forwarded user document was deleted from storage. Only a document that was
-- forwarded (linked to a message) and not already deleted; returns false otherwise.
create function public.claims_mark_user_document_deleted(p_attachment_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case uuid;
begin
  update public.attachments
  set deleted_at = now()
  where id = p_attachment_id and kind = 'user_document' and message_id is not null
    and deleted_at is null
  returning case_id into v_case;
  if v_case is null then
    return false;
  end if;
  insert into public.case_events (case_id, kind, data, created_at)
  values (v_case, 'user_document_deleted', jsonb_build_object('attachment_id', p_attachment_id),
    clock_timestamp());
  return true;
end;
$$;

revoke all on function public.claims_max_sends_per_case() from public, anon, authenticated;
revoke all on function public.claims_apply_reply_action(
  uuid, uuid, public.reply_category, public.case_status, integer, jsonb
) from public, anon, authenticated;
revoke all on function public.claims_forward_user_document(uuid, uuid, integer, jsonb, timestamptz)
  from public, anon, authenticated;
revoke all on function public.claims_mark_user_document_deleted(uuid)
  from public, anon, authenticated;

grant execute on function public.claims_max_sends_per_case() to service_role;
grant execute on function public.claims_apply_reply_action(
  uuid, uuid, public.reply_category, public.case_status, integer, jsonb
) to service_role;
grant execute on function public.claims_forward_user_document(uuid, uuid, integer, jsonb, timestamptz)
  to service_role;
grant execute on function public.claims_mark_user_document_deleted(uuid) to service_role;
