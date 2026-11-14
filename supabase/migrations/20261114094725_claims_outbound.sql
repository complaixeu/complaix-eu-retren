-- Outbound mail and the transport (docs/plans/C-claims.md C3, docs/plans/README.md §4).
--
-- 1. messages: what the sender (features/claims/send-queued.ts) records about each outbound row.
--    All columns are nullable and additive: rows written by C2 and C7 stay valid as they are.
-- 2. A private storage bucket for the PDFs Retren generates for a case (EU form, mandate).
-- 3. claims_send_initial_claim: the initial claim in one transaction (the outbox row, its three
--    attachments, the case waiting_period → sent and its event), the C2 plpgsql pattern.

alter table public.messages
  -- The template the row was rendered from (TemplateKind), when known. C8's kinds allowlist reads it.
  add column template text,
  -- Why the sender refused or failed the row (status failed): recipient_not_allowed, stale, …
  add column failure_reason text,
  -- The provider's id for a sent row (fake-… with the fake transport).
  add column provider_id text,
  add column sent_at timestamptz,
  -- The References header it was sent with (the case thread, oldest first).
  add column thread_references text[],
  -- Where it was really delivered: the recipient, or MAIL_REDIRECT_ALL_TO outside production.
  add column delivered_to text[],
  -- Set by the one sender that claims a queued row, so a row is never sent twice.
  add column send_claimed_at timestamptz;

comment on column public.messages.failure_reason is 'Set with status failed by the sender (C3).';

-- Generated documents of a case: private, no policies, so only the service role reads them.
insert into storage.buckets (id, name, public)
values ('claim-documents', 'claim-documents', false)
on conflict (id) do nothing;

-- Records and commits the initial claim of a case, or refuses it. Returns
-- {ok: true, message_id} or {ok: false, reason}. The checks run again here under a row lock, so
-- two callers can never both send: the case must be in waiting_period, earliest_send_at must be
-- set and passed at p_now, and send_count must be below p_max_sends (MAX_SENDS_PER_CASE).
-- p_message: {from, to, subject, body_text, message_id}; template is always initial_claim.
-- p_attachments: exactly one eu_form, one mandate and one ticket
-- [{kind, storage_path, filename, content_type, size_bytes}].
-- The operator's config (active, verified address) lives in TypeScript and is checked there.
create function public.claims_send_initial_claim(
  p_case_id uuid,
  p_now timestamptz,
  p_max_sends integer,
  p_next_action_at timestamptz,
  p_message jsonb,
  p_attachments jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case public.cases%rowtype;
  v_message uuid;
  v_kinds text[];
begin
  select * into v_case from public.cases where id = p_case_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'case_not_found');
  end if;
  if v_case.status <> 'waiting_period' then
    return jsonb_build_object('ok', false, 'reason', 'not_waiting_period');
  end if;
  if v_case.earliest_send_at is null then
    return jsonb_build_object('ok', false, 'reason', 'no_earliest_send_at');
  end if;
  if v_case.earliest_send_at > p_now then
    return jsonb_build_object('ok', false, 'reason', 'too_early');
  end if;
  if v_case.send_count >= p_max_sends then
    return jsonb_build_object('ok', false, 'reason', 'send_cap_reached');
  end if;

  -- Malformed input is a bug in the caller, not a refusal: it raises and writes nothing.
  if jsonb_typeof(p_attachments) is distinct from 'array' then
    raise exception 'p_attachments must be an array' using errcode = '22023';
  end if;
  select coalesce(array_agg(a ->> 'kind' order by a ->> 'kind'), '{}')
    into v_kinds from jsonb_array_elements(p_attachments) a;
  if v_kinds <> array['eu_form', 'mandate', 'ticket'] then
    raise exception 'the initial claim has exactly an eu_form, a mandate and a ticket'
      using errcode = '22023';
  end if;
  if strpos(coalesce(p_message ->> 'subject', ''), '[' || v_case.public_ref || ']') = 0 then
    raise exception 'the subject must carry [%]', v_case.public_ref using errcode = '22023';
  end if;
  if coalesce(p_message ->> 'message_id', '') = '' then
    raise exception 'the initial claim needs a Message-ID' using errcode = '22023';
  end if;

  insert into public.messages (
    case_id, direction, from_address, to_address, subject, body_text, message_id, template, status
  )
  values (
    p_case_id, 'outbound', p_message ->> 'from', p_message ->> 'to', p_message ->> 'subject',
    p_message ->> 'body_text', p_message ->> 'message_id', 'initial_claim', 'queued'
  )
  returning id into v_message;

  insert into public.attachments (
    case_id, message_id, kind, storage_path, filename, content_type, size_bytes
  )
  select p_case_id, v_message, (a ->> 'kind')::public.attachment_kind, a ->> 'storage_path',
    a ->> 'filename', a ->> 'content_type', (a ->> 'size_bytes')::bigint
  from jsonb_array_elements(p_attachments) a;

  -- The claim counts towards the cap when it is queued, like C7's timer mail.
  update public.cases
    set status = 'sent', sent_at = p_now, next_action_at = p_next_action_at,
      send_count = send_count + 1
    where id = p_case_id;

  insert into public.case_events (case_id, kind, from_status, to_status, data)
  values (
    p_case_id, 'claim_sent', 'waiting_period', 'sent',
    jsonb_build_object('message_id', v_message, 'attachments', 3)
  );

  return jsonb_build_object('ok', true, 'message_id', v_message);
end;
$$;

revoke all on function public.claims_send_initial_claim(
  uuid, timestamptz, integer, timestamptz, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.claims_send_initial_claim(
  uuid, timestamptz, integer, timestamptz, jsonb, jsonb
) to service_role;
