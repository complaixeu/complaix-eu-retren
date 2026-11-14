-- Each timer action fires at most once per case (docs/plans/C-claims.md C7, ARCHITECTURE §6).
--
-- The tick (features/claims/tick.ts) records every action it applies as a case_events row
-- kind = 'timer_action', data = { action, day }. This index makes a second row for the same
-- case and action fail, so two ticks running at once (pg_cron may fire twice) can never queue
-- the same reminder twice. Additive: an index only, no change to existing columns or rows.
create unique index case_events_timer_action_once
  on public.case_events (case_id, (data ->> 'action'))
  where kind = 'timer_action';
