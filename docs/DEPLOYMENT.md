# Deployment guide (Vercel + Render + Supabase)

Why two hosts: Vercel serves the Next.js frontend. The detector needs a long-running Python process with
PyTorch (hundreds of MB, minutes of CPU per clip), which does not fit Vercel serverless functions. The
FastAPI service therefore runs on Render (free tier) or another container host.

## 0. Push the code to GitHub (Windows)
Unzip, open a terminal in the project folder (the one containing `apps` and `services`), then:
```
git init -b main
git add .
git status
```
Check that `git status` does NOT list `node_modules`, `.next`, `.env` or `.env.local` (they are ignored), and that
`services/api/yolo11n.pt` IS listed. Then create an empty repository named `sentinel-vision` on GitHub
(no README, no .gitignore) and run:
```
git commit -m "Sentinel Vision: initial commit"
git remote add origin https://github.com/YOUR-USERNAME/sentinel-vision.git
git push -u origin main
```

## 0b. Before you start
- Push the repository to GitHub **without** `node_modules`, `.next`, `.env` or `.env.local` (`.gitignore` covers them).
- Commit `services/api/yolo11n.pt` (about 5.6 MB) so the API does not download weights at request time.

## 1. Supabase
1. SQL editor: run `supabase/migrations/001` to `007`, in order.
2. Project settings > API: copy the project URL and the **publishable (anon)** key. Never put a secret/service-role key in either app.
3. Authentication > URL configuration: set **Site URL** to your Vercel URL and add it (and `http://localhost:3000`) to **Redirect URLs**. Do this after step 3 below.

## 2. Render (API)
1. New > Blueprint > pick the repo (it reads `render.yaml`), or create a Web Service with root directory `services/api`.
2. Set the `sync: false` variables: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ALLOWED_ORIGINS` (temporarily `http://localhost:3000`).
3. Deploy, then open `https://<service>.onrender.com/health`: expect `{"status":"ok", ...}`.
4. First analysis request loads PyTorch and the model. Watch the logs. If the service restarts with an
   out-of-memory message (the free instance has 512 MB of RAM), see "If the free tier is not enough".

### Creating the Render service without the Blueprint
The API is deployed from `services/api/Dockerfile` (it installs the system libraries OpenCV needs, which Render's plain
Python environment lacks). Create a **Docker** web service with Dockerfile path `./services/api/Dockerfile` and Docker
context `./services/api` (or root directory `services/api`), health check path `/health`, plan Free, and the
environment variables listed in `render.yaml`.

## 3. Vercel (frontend)
1. Import the repo. Set **Root Directory** to `apps/web`. Framework preset: Next.js.
2. Environment variables (Production and Preview): `NEXT_PUBLIC_API_BASE_URL` = the Render URL (no trailing slash),
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
3. Deploy. `NEXT_PUBLIC_*` values are baked in at build time: change one, then redeploy.

## 4. Wire them together
- Render: set `ALLOWED_ORIGINS` to the exact Vercel URL (for example `https://sentinel-vision.vercel.app`, no trailing slash).
  For preview deployments also set `ALLOWED_ORIGIN_REGEX`, for example `https://sentinel-vision-.*\.vercel\.app`.
- Supabase: finish the redirect URL step from section 1.

## 5. Smoke test (in this order)
1. `/health` on Render responds.
2. Open the Vercel site: the API status shows online (after a cold start this can take up to a minute).
3. Sign up (confirm the email if confirmation is enabled), sign in.
4. Upload a 5-10 second clip: results appear and are saved; reload and confirm the saved job is restored.
5. Start live tracking (camera needs HTTPS; Vercel provides it).
6. Acknowledge an incident and open its audit history.
7. Browser console: no CORS errors.

## If the free tier is not enough
Symptoms: out-of-memory restarts, analysis taking minutes, request timeouts. Options, in order of effort:
1. Lower the limits (already conservative in `render.yaml`): `MAX_VIDEO_SECONDS`, `MAX_ANALYSIS_FRAMES`, `INFERENCE_IMAGE_SIZE=320`.
2. Move the API to a host with more memory. A Docker-based Hugging Face Space on the free CPU tier is a common
   choice for demos like this (check its current limits); Render's paid plans also work. Only `NEXT_PUBLIC_API_BASE_URL` and `ALLOWED_ORIGINS` change.
3. Export the detector to ONNX and use onnxruntime to cut memory; this requires replacing the Ultralytics tracker usage.

## Operations notes
- Free Render services sleep after inactivity. The dashboard polls `/health` every 10 s while a tab is open, which
  keeps the service awake; that uses free instance hours shared across your free services.
- Rate limits: signed-in users are not throttled individually yet. Consider disabling open sign-ups or adding per-user limits before sharing the URL widely.

## 6. Link it from your portfolio
In the portfolio repo, open `data/projects.ts`, find the `sentinel-vision` entry, set `url` to the Vercel URL (and `repo`
to the GitHub repository), change `featured` to `true`, and push.
