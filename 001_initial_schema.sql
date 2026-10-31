create extension if not exists pgcrypto;

create table if not exists public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  original_filename text not null,
  storage_path text,
  status text not null default 'queued' check (status in ('queued','processing','completed','failed','cancelled')),
  progress integer not null default 0 check (progress between 0 and 100),
  error_message text,
  duration_seconds numeric,
  frames_processed integer not null default 0,
  detections_count integer not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.detection_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.analysis_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  label text not null,
  confidence numeric not null check (confidence between 0 and 1),
  frame_index integer not null,
  timestamp_seconds numeric not null,
  bbox jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.analysis_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  event_type text not null,
  evidence_path text,
  occurred_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_jobs_user_created on public.analysis_jobs(user_id, created_at desc);
create index if not exists idx_events_job_time on public.detection_events(job_id, timestamp_seconds);
create index if not exists idx_incidents_user_status on public.incidents(user_id, status, occurred_at desc);

alter table public.analysis_jobs enable row level security;
alter table public.detection_events enable row level security;
alter table public.incidents enable row level security;

create policy "Users can view their own jobs" on public.analysis_jobs
  for select using (auth.uid() = user_id);
create policy "Users can create their own jobs" on public.analysis_jobs
  for insert with check (auth.uid() = user_id);
create policy "Users can update their own jobs" on public.analysis_jobs
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can view their own events" on public.detection_events
  for select using (auth.uid() = user_id);
create policy "Users can view their own incidents" on public.incidents
  for select using (auth.uid() = user_id);
create policy "Users can update their own incidents" on public.incidents
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Create a private Storage bucket named sentinel-videos in Supabase.
-- Add Storage policies so users can access only objects under their own auth.uid() folder.
