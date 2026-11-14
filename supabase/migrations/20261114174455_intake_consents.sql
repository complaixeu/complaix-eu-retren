-- Consent evidence (docs/plans/A-intake.md A6, ARCHITECTURE "Aspectos legales y privacidad":
-- "se guarda evidencia de la aceptación: fecha y hora, versión del texto, IP y datos del viaje").
--
-- consents: one row each time a user accepts the mandate and the privacy notice. Several rows for
-- one draft (accepting again after going back) are intentional: each is evidence of an acceptance,
-- and A7 uses the newest. Insert-only:
-- a trigger refuses UPDATE, DELETE and TRUNCATE for everyone, the owner included. RLS on, no
-- policies, no grants for anon or authenticated; the service role may only insert and read.
--
-- draft_id → intake_drafts(id) ON DELETE SET NULL: the draft is deleted after submit (A7) and by
-- the purge of expired drafts, and the evidence must outlive it. A case keeps the consent's id in
-- its submission (ConsentRef.consentId), so it still finds its consent once the draft is gone.
-- The trigger lets exactly that one change through: draft_id set to null, nothing else touched,
-- and only once the draft no longer exists (so only the foreign key's own cascade can do it).
-- Nothing existing changes.

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid references public.intake_drafts (id) on delete set null,
  -- Set by the server; no default on purpose.
  accepted_at timestamptz not null,
  -- The version of the mandate and privacy texts shown (features/intake/consent/texts.ts).
  text_version text not null,
  -- From the request headers; null when they carry no address.
  ip inet,
  -- The trip as the user confirmed it (data.review.ticket, plus data.answers if present).
  trip_snapshot jsonb not null,
  -- Set by the database at insert; orders consents that share accepted_at (the newest wins).
  -- clock_timestamp(), not now(): two inserts in one transaction still get different values.
  created_at timestamptz not null default clock_timestamp(),
  constraint consents_text_version_not_empty check (char_length(text_version) between 1 and 100),
  constraint consents_trip_snapshot_is_object check (jsonb_typeof(trip_snapshot) = 'object')
);

comment on table public.consents is
  'Evidence of the mandate and GDPR acceptance (intake, A6). Insert-only; server-only: RLS on, no policies.';

-- A7 reads the latest consent of a draft.
create index consents_draft_id_latest on public.consents (draft_id, accepted_at desc, created_at desc);

alter table public.consents enable row level security;
revoke all on table public.consents from anon, authenticated, service_role;
grant select, insert on table public.consents to service_role;

create function public.consents_insert_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    -- The foreign key's ON DELETE SET NULL, after the draft is gone: allowed, nothing else is.
    if old.draft_id is not null
      and new.draft_id is null
      and (new.id, new.accepted_at, new.text_version, new.ip, new.trip_snapshot, new.created_at)
        is not distinct from
          (old.id, old.accepted_at, old.text_version, old.ip, old.trip_snapshot, old.created_at)
      and not exists (select 1 from public.intake_drafts d where d.id = old.draft_id)
    then
      return new;
    end if;
  end if;
  raise exception 'consents is insert-only' using errcode = 'P0001';
end;
$$;

revoke all on function public.consents_insert_only() from public, anon, authenticated;

create trigger consents_no_update_delete
  before update or delete on public.consents
  for each row execute function public.consents_insert_only();

create trigger consents_no_truncate
  before truncate on public.consents
  for each statement execute function public.consents_insert_only();
