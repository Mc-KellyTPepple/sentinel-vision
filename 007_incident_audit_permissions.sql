-- Keep incident status history readable to authenticated users under its existing RLS policy,
-- while preventing direct client-side insertion, modification, or deletion of audit rows.
-- Status-change rows continue to be inserted by the SECURITY DEFINER trigger from migration 006.

REVOKE ALL PRIVILEGES ON TABLE public.incident_status_history FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.incident_status_history FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.incident_status_history FROM authenticated;
GRANT SELECT ON TABLE public.incident_status_history TO authenticated;

-- Explicitly keep the trigger function executable for the trigger mechanism; this does not
-- grant authenticated users permission to call it directly as a client-side RPC.
REVOKE ALL ON FUNCTION public.record_incident_status_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_incident_status_change() FROM anon;
REVOKE ALL ON FUNCTION public.record_incident_status_change() FROM authenticated;
