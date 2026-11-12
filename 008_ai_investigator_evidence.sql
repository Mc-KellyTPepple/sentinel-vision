-- AI investigator, evidence-backed incidents, false-alarm handling and data retention.
-- Additive and safe to run more than once: no existing rows, columns or policies are changed or removed.

-- Reproducibility and search for saved analyses.
alter table public.analysis_jobs
  add column if not exists run_config jsonb,          -- model, thresholds and sampling used for this report
  add column if not exists summary text,              -- plain-language summary written when the analysis was saved
  add column if not exists tags text[] not null default '{}';  -- searchable words: classes, colours, behaviours, scene

create index if not exists idx_jobs_user_tags on public.analysis_jobs using gin (tags);

-- Evidence and review outcome for incidents.
alter table public.incidents
  add column if not exists evidence jsonb,            -- { t, frame, track_id, reason, keyframe }
  add column if not exists false_positive boolean not null default false,
  add column if not exists resolution_note text;

-- Data retention: users may delete their own saved analyses. Detections and incidents of the analysis are removed
-- with it (on delete cascade), and so is the incident status history that belongs to those incidents.
drop policy if exists "Users can delete their own jobs" on public.analysis_jobs;
create policy "Users can delete their own jobs" on public.analysis_jobs
  for delete using (auth.uid() = user_id);
