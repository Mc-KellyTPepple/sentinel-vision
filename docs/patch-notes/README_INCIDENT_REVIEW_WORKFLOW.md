# Sentinel Vision — Incident Review Workflow

## Included
- Status filters for All, Open, Acknowledged, and Resolved remain available.
- Each analysis/title group has an **Inspect group** control. Selecting it filters the individual incident list to that analysis and alert title; status filters continue to apply. Use **Clear group selection** to return to the full list.
- Each incident record has its own **Open linked analysis** action when its `job_id` resolves to a saved analysis.
- Resolving an incident prompts for confirmation and identifies the incident title and timestamp. Only the chosen incident record is updated; no group/bulk resolve is performed.
- No schema, migration, or Supabase policy changes are included.

## Install on Windows
1. Stop the Next.js dev server with `Ctrl+C`.
2. Extract this ZIP into `C:\Users\User\Documents\AI-Projects\sentinel-vision-starter`.
3. Allow the file at `apps\web\app\page.tsx` to be overwritten.
4. Start the frontend again:

   ```cmd
   cd "C:\Users\User\Documents\AI-Projects\sentinel-vision-starter\apps\web"
   npm run dev
   ```

5. Open `http://localhost:3000`, scroll to Incident management, inspect a group, and test a resolve action. Cancel the confirmation once to verify the incident stays unchanged.

## Notes
- This UI continues to use the existing incident list query, which currently loads up to 20 records. Group counts and status filters reflect the records loaded by the page, not necessarily every record in the database.
- The original file was based on the prior Incident Job Grouping overlay. The patch does not delete or automatically resolve any incidents.
