# Incident status audit history

1. Open the Supabase project SQL Editor.
2. Open and run `supabase/migrations/006_incident_status_history.sql`. This adds a private, append-only status-history table and trigger; it does not drop existing incident tables or policies.
3. Copy the updated `apps/web/app/page.tsx` into the same path in your project.
4. Refresh the dashboard, acknowledge or resolve an incident, then select **View audit history** on that incident.

The database trigger records status transitions even if the change was made outside the dashboard. The audit table is readable only by the incident owner's authenticated user; client-side users cannot insert or edit audit entries directly. Historical changes from before this migration are not backfilled.
