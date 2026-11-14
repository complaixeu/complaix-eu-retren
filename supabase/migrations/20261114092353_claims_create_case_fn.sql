-- createCase in one transaction (docs/plans/C-claims.md C2, docs/plans/README.md §4).
--
-- supabase-js has no transactions, so the case, its `created` event and, when the case is closed
-- at once, the queued user notice (the outbox row) and its event are written by one function:
-- all of them or none. Server only, like the tables: the API roles can't execute either function.

-- The case reference: random, not sequential (RTN- + 8 upper-case hex characters). The server
-- asks for one first, because the notice subject must carry it ([RTN-ref], RenderedTemplate).
create function public.claims_new_public_ref()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'RTN-' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
$$;

-- Same generator as the C1 default, now in one place.
alter table public.cases alter column public_ref set default public.claims_new_public_ref();

-- Inserts one case created by createCase. A duplicate p_public_ref raises 23505 and writes
-- nothing (the caller asks for a new reference and retries). p_event_data must hold no personal
-- data. p_notice is required exactly when p_status is closed: {template: user_final_result, from,
-- to (= p_user_email), subject, body_text}.
create function public.claims_create_case(
  p_public_ref text,
  p_operator text,
  p_status public.case_status,
  p_submission jsonb,
  p_eligibility jsonb,
  p_user_email text,
  p_earliest_send_at timestamptz,
  p_next_action_at timestamptz,
  p_event_data jsonb,
  p_notice jsonb default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case uuid;
  v_message uuid;
begin
  -- A new case leaves draft only through `eligible` or `not_eligible` (features/claims/state-machine.ts).
  if p_status not in ('waiting_period', 'closed') then
    raise exception 'createCase cannot create a case in status %', p_status using errcode = '22023';
  end if;

  -- The only notice createCase queues is the final result of a closed case, to its own user
  -- (ARCHITECTURE §7): exactly one notice when closed, none otherwise.
  if (p_status = 'closed') <> (p_notice is not null) then
    raise exception 'a % case % a notice', p_status,
      case when p_notice is null then 'needs' else 'cannot have' end
      using errcode = '22023';
  end if;
  if p_notice is not null then
    if p_notice ->> 'template' is distinct from 'user_final_result' then
      raise exception 'createCase only queues the user_final_result notice' using errcode = '22023';
    end if;
    if p_notice ->> 'to' is distinct from p_user_email then
      raise exception 'the notice must go to the case user' using errcode = '22023';
    end if;
  end if;

  insert into public.cases (
    public_ref, operator, status, submission, eligibility, user_email,
    earliest_send_at, next_action_at
  )
  values (
    p_public_ref, p_operator, p_status, p_submission, p_eligibility, p_user_email,
    p_earliest_send_at, p_next_action_at
  )
  returning id into v_case;

  insert into public.case_events (case_id, kind, from_status, to_status, data)
  values (v_case, 'created', 'draft', p_status, coalesce(p_event_data, '{}'::jsonb));

  if p_notice is not null then
    insert into public.messages (
      case_id, direction, from_address, to_address, subject, status, body_text
    )
    values (
      v_case, 'outbound', p_notice ->> 'from', p_notice ->> 'to', p_notice ->> 'subject',
      'queued', p_notice ->> 'body_text'
    )
    returning id into v_message;

    insert into public.case_events (case_id, kind, data)
    values (
      v_case, 'user_notice_queued',
      jsonb_build_object('template', p_notice ->> 'template', 'message_id', v_message)
    );
  end if;

  return v_case;
end;
$$;

revoke all on function public.claims_new_public_ref() from public, anon, authenticated;
revoke all on function public.claims_create_case(
  text, text, public.case_status, jsonb, jsonb, text, timestamptz, timestamptz, jsonb, jsonb
) from public, anon, authenticated;

grant execute on function public.claims_new_public_ref() to service_role;
grant execute on function public.claims_create_case(
  text, text, public.case_status, jsonb, jsonb, text, timestamptz, timestamptz, jsonb, jsonb
) to service_role;
