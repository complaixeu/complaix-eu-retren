-- Timer actions in one transaction (docs/plans/C-claims.md C7, ARCHITECTURE §6).
--
-- The tick (features/claims/tick.ts) applies a due reminder, escalation or close with one call to
-- claims_apply_timer_action: the guarded case update, the `timer_action` event and the queued
-- outbox row (plus, for the escalation, an `escalation_filing_required` event, and for the user
-- notice a `user_notice_queued` event) are written together or not at all. Additive: one index
-- and one function, nothing existing changes.

-- Each timer action fires at most once per case, even when two ticks run at once.
create unique index case_events_timer_action_once
  on public.case_events (case_id, (data ->> 'action'))
  where kind = 'timer_action';

-- Applies one timer action. The case is updated only while it still has the status, send_count
-- and paused flag the action was computed from; otherwise, or when the action already fired,
-- nothing is written and the result is null. Returns the queued message id.
--
-- p_event_data: {action, day, at} (no personal data).
-- p_message: {recipient: operator|user, template, from, to, subject, body_text}.
-- p_extra_events: [{kind, data}] with kind in the allowlist below (no personal data).
create function public.claims_apply_timer_action(
  p_case_id uuid,
  p_from_status public.case_status,
  p_send_count integer,
  p_paused boolean,
  p_to_status public.case_status,
  p_send_increment integer,
  p_next_action_at timestamptz,
  p_event_data jsonb,
  p_message jsonb,
  p_extra_events jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_message uuid;
  v_extra jsonb := coalesce(p_extra_events, '[]'::jsonb);
begin
  if p_send_increment is null or p_send_increment not in (0, 1) then
    raise exception 'send increment must be 0 or 1' using errcode = '22023';
  end if;
  if p_event_data ->> 'action' is null then
    raise exception 'the timer event needs an action' using errcode = '22023';
  end if;
  if p_message ->> 'recipient' is null or p_message ->> 'recipient' not in ('operator', 'user') then
    raise exception 'the message recipient must be operator or user' using errcode = '22023';
  end if;
  if jsonb_typeof(v_extra) <> 'array' or exists (
    select 1 from jsonb_array_elements(v_extra) e
    where e ->> 'kind' is distinct from 'escalation_filing_required'
  ) then
    raise exception 'unexpected extra timer event' using errcode = '22023';
  end if;

  begin
    update public.cases
    set status = p_to_status,
        send_count = send_count + p_send_increment,
        next_action_at = p_next_action_at
    where id = p_case_id
      and status = p_from_status
      and send_count = p_send_count
      and paused = p_paused;
    if not found then
      return null; -- the case changed since the tick read it
    end if;

    insert into public.case_events (case_id, kind, from_status, to_status, data)
    values (p_case_id, 'timer_action', p_from_status, p_to_status, p_event_data);

    insert into public.messages (
      case_id, direction, from_address, to_address, subject, status, body_text
    )
    values (
      p_case_id, 'outbound', p_message ->> 'from', p_message ->> 'to', p_message ->> 'subject',
      'queued', p_message ->> 'body_text'
    )
    returning id into v_message;

    if p_message ->> 'recipient' = 'user' then
      insert into public.case_events (case_id, kind, data)
      values (
        p_case_id, 'user_notice_queued',
        jsonb_build_object('template', p_message ->> 'template', 'message_id', v_message)
      );
    end if;

    insert into public.case_events (case_id, kind, data)
    select p_case_id, e ->> 'kind', coalesce(e -> 'data', '{}'::jsonb)
    from jsonb_array_elements(v_extra) e;
  exception when unique_violation then
    -- Another tick already applied this action: everything above is rolled back.
    return null;
  end;

  return v_message;
end;
$$;

revoke all on function public.claims_apply_timer_action(
  uuid, public.case_status, integer, boolean, public.case_status, integer, timestamptz, jsonb,
  jsonb, jsonb
) from public, anon, authenticated;

grant execute on function public.claims_apply_timer_action(
  uuid, public.case_status, integer, boolean, public.case_status, integer, timestamptz, jsonb,
  jsonb, jsonb
) to service_role;
