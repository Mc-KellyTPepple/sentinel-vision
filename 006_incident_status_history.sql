-- Append-only incident status audit history. Safe to apply to existing installations.
create table if not exists public.incident_status_history (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  previous_status text not null check (previous_status in ('open','acknowledged','resolved')),
  new_status text not null check (new_status in ('open','acknowledged','resolved')),
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id) on delete set null
);
create index if not exists idx_incident_history_user_time on public.incident_status_history(user_id, changed_at desc);
create index if not exists idx_incident_history_incident_time on public.incident_status_history(incident_id, changed_at desc);
alter table public.incident_status_history enable row level security;
drop policy if exists "Users can view their own incident status history" on public.incident_status_history;
create policy "Users can view their own incident status history" on public.incident_status_history
  for select using (auth.uid() = user_id);

create or replace function public.record_incident_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status is distinct from new.status then
    insert into public.incident_status_history (incident_id,user_id,previous_status,new_status,changed_at,changed_by)
    values (new.id,new.user_id,old.status,new.status,now(),auth.uid());
  end if;
  return new;
end;
$$;
drop trigger if exists incidents_status_audit_trigger on public.incidents;
create trigger incidents_status_audit_trigger
after update of status on public.incidents
for each row execute function public.record_incident_status_change();
