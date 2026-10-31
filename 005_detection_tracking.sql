-- Add optional ByteTrack IDs to detection events without changing existing rows or RLS policies.
alter table public.detection_events
  add column if not exists track_id bigint;

create index if not exists detection_events_job_track_id_idx
  on public.detection_events (job_id, track_id)
  where track_id is not null;
