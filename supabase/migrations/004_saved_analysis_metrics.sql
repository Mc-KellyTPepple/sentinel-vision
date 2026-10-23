-- Safe, additive migration: retain existing jobs and policies.
-- Adds optional performance fields so newly saved reports can restore their metrics.
ALTER TABLE public.analysis_jobs
  ADD COLUMN IF NOT EXISTS processing_seconds numeric,
  ADD COLUMN IF NOT EXISTS average_inference_fps numeric;
