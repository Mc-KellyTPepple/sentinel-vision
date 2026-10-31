Sentinel Vision — Live Streaming Restore + Model Reliability + Audit History

This overlay is based on the live-status-clarity version of the frontend, which includes the browser webcam stream, sequential live-frame inference, live status/retry handling, track labels and live event feed. It restores those features while bringing back the incident status history panel with UTC timestamps and clear query errors.

Apply:
1. Back up your current project folder or at least apps/web/app/page.tsx.
2. Extract this ZIP into C:\Users\User\Documents\AI-Projects\sentinel-vision-starter and allow apps/web/app/page.tsx to be replaced.
3. Do not run a new database migration for this overlay. It uses the incident_status_history table and existing RLS policy already configured in your project.
4. Restart the frontend:
   cd "C:\Users\User\Documents\AI-Projects\sentinel-vision-starter\apps\web"
   npm run dev
5. Open http://localhost:3000, sign in, and scroll to the live camera section. Grant camera permission, then start live tracking. Confirm API is running at http://localhost:8000.
6. In Incident management, use View audit history to see the status transitions. Times are explicitly shown in UTC.

Notes:
- Browser camera access requires localhost or HTTPS and explicit permission.
- This restores the previously implemented live webcam workflow; it does not retrain or replace the detector weights. Model quality improvements here focus on stable live tracking and more transparent incident/audit review.
- No secrets or .env files are included.
