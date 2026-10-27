"use client";

import { BarChart, Donut, Icon, Kpi, Sparkline, formatDuration, type IconName } from "./ui";

type Job = {
  id: string;
  original_filename: string;
  status: string;
  created_at: string;
  detections_count: number;
  duration_seconds: number | null;
  frames_processed: number;
  processing_seconds: number | null;
  average_inference_fps: number | null;
};
type IncidentLite = { id: string; title: string; severity: string; status: "open" | "acknowledged" | "resolved"; occurred_at: string; job_id: string };

type Props = {
  jobs: Job[];
  incidents: IncidentLite[];
  apiStatus: "checking" | "waking" | "online" | "offline";
  apiLatencyMs: number | null;
  live: { running: boolean; frames: number; processedMs: number; objects: number; tracks: number };
  setup: { zones: number; lines: number; rules: number; alerts: number };
  onOpenJob: (job: Job) => void;
  onGoto: (tab: "analyze" | "live" | "incidents") => void;
  onStartLive: () => void;
};

const STATUS_COLORS = { open: "#ffd37a", acknowledged: "#6ce3d0", resolved: "#b6f36b" };

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: "target", title: "Real-time tracking", text: "YOLO11 detection with persistent ByteTrack IDs on live webcam frames and uploaded clips." },
  { icon: "polygon", title: "Zones, lines and rules", text: "Draw zones and counting lines on the video, count by direction, and raise alerts for crowding, loitering and crossings." },
  { icon: "flame", title: "Heatmaps and replay", text: "See where activity happens, follow trajectories, and replay a saved analysis from its detections." },
  { icon: "shield", title: "Incident audit trail", text: "Sustained detections become reviewable incidents, with every status change recorded in an append-only history." },
];

export default function CommandCenter({ jobs, incidents, apiStatus, apiLatencyMs, live, setup, onOpenJob, onGoto, onStartLive }: Props) {
  const done = jobs.filter((j) => j.status === "completed");
  const totalDetections = done.reduce((a, j) => a + (j.detections_count || 0), 0);
  const active = incidents.filter((i) => i.status !== "resolved");
  const byStatus = { open: 0, acknowledged: 0, resolved: 0 };
  for (const i of incidents) byStatus[i.status] += 1;
  const recent = [...done].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)).slice(-8);
  const processing = recent.map((j) => j.processing_seconds ?? 0);
  const withTime = done.filter((j) => j.processing_seconds != null);
  const avgProcessing = withTime.length ? withTime.reduce((a, j) => a + (j.processing_seconds || 0), 0) / withTime.length : null;
  const withFps = done.filter((j) => j.average_inference_fps != null);
  const avgFps = withFps.length ? withFps.reduce((a, j) => a + (j.average_inference_fps || 0), 0) / withFps.length : null;
  const analyzedSeconds = done.reduce((a, j) => a + (j.duration_seconds || 0), 0);

  return (
    <div className="overview">
      <section className="ov-hero">
        <div>
          <p className="eyebrow">Mission control</p>
          <h2>Real-time AI video intelligence</h2>
          <p className="subcopy">Track objects live, define zones and rules, analyze footage, and review incidents, all in one place.</p>
        </div>
        <div className="ov-actions">
          <button type="button" className="primary-button" onClick={() => { onGoto("live"); if (!live.running) onStartLive(); }}><Icon name="camera" size={17} /> {live.running ? "Open live view" : "Start live camera"}</button>
          <button type="button" className="small-button big" onClick={() => onGoto("analyze")}><Icon name="film" size={17} /> Analyze a clip</button>
        </div>
      </section>

      <section className="kpi-grid" aria-label="Key figures">
        <Kpi label="Analyses" value={done.length} hint={`${formatDuration(analyzedSeconds)} of footage`} icon="film" tone="cyan">
          <Sparkline values={recent.map((j) => j.detections_count)} color="#6ce3d0" />
        </Kpi>
        <Kpi label="Detections" value={totalDetections.toLocaleString()} hint="across saved analyses" icon="target">
          <Sparkline values={recent.map((j) => j.detections_count)} />
        </Kpi>
        <Kpi label="Active incidents" value={active.length} hint={`${byStatus.open} open · ${byStatus.acknowledged} acknowledged`} icon="shield" tone={byStatus.open ? "amber" : "green"} />
        <Kpi label="Avg. processing" value={avgProcessing == null ? "—" : formatDuration(avgProcessing)} hint={avgFps == null ? "per analysis" : `${avgFps.toFixed(1)} frames/s average`} icon="clock" tone="cyan">
          <Sparkline values={processing} color="#8fb4ff" />
        </Kpi>
        <Kpi label="Live session" value={live.running ? "Live" : "Idle"} hint={live.running ? `${live.frames} frames · ${live.objects} objects · ${live.tracks} tracks` : "camera not running"} icon="activity" tone={live.running ? "green" : "cyan"} />
        <Kpi label="Setup" value={`${setup.zones + setup.lines} shapes`} hint={`${setup.rules} rules · ${setup.alerts} recent events`} icon="polygon" tone="amber" />
      </section>

      <section className="ov-grid">
        <div className="panel ov-card">
          <div className="panel-heading"><div><h2>Detections per analysis</h2></div><span className="pill">last {recent.length}</span></div>
          <BarChart items={recent.map((j) => ({ label: new Date(j.created_at).toLocaleDateString(undefined, { month: "numeric", day: "numeric" }), value: j.detections_count }))} />
        </div>
        <div className="panel ov-card">
          <div className="panel-heading"><div><h2>Incidents</h2></div><span className="pill">{incidents.length} total</span></div>
          <div className="donut-row">
            <Donut
              segments={[
                { label: "Open", value: byStatus.open, color: STATUS_COLORS.open },
                { label: "Acknowledged", value: byStatus.acknowledged, color: STATUS_COLORS.acknowledged },
                { label: "Resolved", value: byStatus.resolved, color: STATUS_COLORS.resolved },
              ]}
              center={<><strong>{active.length}</strong><small>active</small></>}
            />
            <ul className="legend">
              {(["open", "acknowledged", "resolved"] as const).map((k) => (
                <li key={k}><span className="legend-dot" style={{ background: STATUS_COLORS[k] }} />{k[0].toUpperCase() + k.slice(1)}<b>{byStatus[k]}</b></li>
              ))}
            </ul>
          </div>
          <button type="button" className="small-button" onClick={() => onGoto("incidents")}>Review incidents</button>
        </div>
        <div className="panel ov-card">
          <div className="panel-heading"><div><h2>Platform status</h2></div></div>
          <ul className="status-list">
            <li><span className={`dot dot-${apiStatus}`} />API<b>{apiStatus === "online" ? "Online" : apiStatus === "waking" ? "Waking up" : apiStatus === "checking" ? "Checking" : "Offline"}</b></li>
            <li><span className="dot dot-online" />Latency<b>{apiLatencyMs == null ? "—" : `${apiLatencyMs} ms`}</b></li>
            <li><span className="dot dot-online" />Detector<b>YOLO11n · CPU</b></li>
            <li><span className="dot dot-online" />Tracker<b>ByteTrack</b></li>
            <li><span className={`dot ${live.running ? "dot-online" : "dot-checking"}`} />Last live frame<b>{live.running ? `${Math.round(live.processedMs)} ms` : "—"}</b></li>
          </ul>
        </div>
        <div className="panel ov-card ov-wide">
          <div className="panel-heading"><div><h2>Recent analyses</h2></div><span className="pill">{jobs.length} saved</span></div>
          {!jobs.length ? <p className="subcopy">No analyses yet. Upload a short clip to get started.</p> : (
            <ul className="mini-list">
              {jobs.slice(0, 5).map((j) => (
                <li key={j.id}>
                  <span><strong>{j.original_filename}</strong><small>{new Date(j.created_at).toLocaleString()} · {j.detections_count} detections · {j.frames_processed} frames</small></span>
                  <button type="button" className="small-button" onClick={() => onOpenJob(j)}>Open report</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="panel ov-card ov-wide">
          <div className="panel-heading"><div><h2>Latest incidents</h2></div><span className="pill">{active.length} active</span></div>
          {!incidents.length ? <p className="subcopy">No incidents yet. They are created when an object stays in view across an analysis.</p> : (
            <ul className="mini-list">
              {incidents.slice(0, 5).map((i) => (
                <li key={i.id}>
                  <span><strong>{i.title}</strong><small>{new Date(i.occurred_at).toLocaleString()}</small></span>
                  <span className={`incident-status ${i.status}`}>{i.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="feature-grid" aria-label="Capabilities">
        {FEATURES.map((f) => (
          <div className="feature" key={f.title}>
            <span className="feature-icon"><Icon name={f.icon} size={20} /></span>
            <h3>{f.title}</h3>
            <p>{f.text}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
