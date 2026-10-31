# Sentinel Vision — Incident grouping by analysis

## What changed
- Resolves source filenames for incidents by fetching their linked `analysis_jobs` records, rather than relying only on the five newest saved jobs.
- Groups the incident overview by saved analysis/job ID and alert title, so alerts from different runs of the same video remain separate.
- Displays the source filename, short analysis ID, and analysis timestamp for each grouped pattern.
- Preserves the individual incident cards and their acknowledge/resolve actions. No incident records are deleted or automatically changed.
- Keeps the existing recent-saved-analysis query and list unchanged.

## Apply
1. Stop Next.js with `Ctrl+C` in its terminal.
2. Extract this ZIP into `C:\Users\User\Documents\AI-Projects\sentinel-vision-starter`, preserving folder paths and allowing overwrite of `apps\web\app\page.tsx`.
3. Run:
   ```cmd
   cd "C:\Users\User\Documents\AI-Projects\sentinel-vision-starter\apps\web"
   npm run dev
   ```
4. Refresh `http://localhost:3000`, then inspect Incident management.

## Safety
This is a frontend-only change. It does not alter the database schema, Supabase RLS policies, or incident statuses. If a linked analysis row is unavailable due to permissions or missing data, the interface falls back to a short analysis ID or “No linked analysis”.
