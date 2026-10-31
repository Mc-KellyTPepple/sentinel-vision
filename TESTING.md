# Testing Sentinel Vision

## Automated checks
| What | Command | Where |
|---|---|---|
| Analytics engine (zones, lines, rules, heatmaps) | `npm test` | `apps/web` (Node 22+) |
| Types and style | `npx tsc --noEmit` and `npm run lint` | `apps/web` |
| API (auth, uploads, limits, start-up state) | `pytest -q` | `services/api` |

## Test clips (15 seconds or less)
- **`sentinel-vision-test-15s.mp4`**: one person moving around the frame (face visible in nearly every frame). Use it to check
  detection, a stable track ID, the heatmap, and dwell time in a zone placed where they sit.
- **`sentinel-vision-test-crossing-15s.mp4`**: the person slides from the left side to the right side exactly once, crossing the
  vertical centre of the frame at about 7.4 s. Draw a vertical counting line from top to bottom through the middle. Expected:
  **one** crossing, around 7 s, with the Replay marker passing the line then. This clip is synthetic (a still image translated
  across the frame), so use it for counting, not for judging detection quality.

## Manual checklist
1. **Cold start.** Leave the API idle for 20 minutes, then open the site. The header shows "API waking up…" and then "online".
   Start the live camera: the stage explains that the detector is starting up, and the first frame appears by itself.
2. **Live.** Load the example setup, walk through the zone and across the line both ways: entries, exits, crossings and the
   three alert rules should appear in the event list.
3. **Clips.** Upload both clips above. Expected: report, heatmap, trajectories, replay, zone analytics.
4. **Rejections.** A clip over 15 s, a file over 20 MB and a non-video file each give a clear message.
5. **Busy detector.** With the camera running, the Run button is disabled; two uploads at once give one "busy" message.
6. **Accounts.** A second account sees none of the first account's analyses or incidents.
7. **Devices.** Repeat the live test on a phone and in a second browser.

## Reading the API's health
`GET /ready` returns `detector`: `idle` (not started), `loading`, `ready`, or `failed` (it then loads on the first request).
