"use client";

import { useEffect, useMemo, useState } from "react";
import {
  analyzeBatch, buildHeatmap, buildTracks, colorForLabel, estimateFrameSize, footPoint, framesFromSaved, pointInPolygon,
  type SavedDetection, type TrackPath,
} from "../lib/analytics";
import type { VideoAnalytics } from "../lib/useVideoAnalytics";
import OverlayStage, { type StageBox } from "./OverlayStage";
import { Icon, formatDuration, type IconName } from "./ui";

type View = "heatmap" | "trajectories" | "replay" | "zones";
const VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: "heatmap", label: "Heatmap", icon: "flame" },
  { id: "trajectories", label: "Trajectories", icon: "route" },
  { id: "replay", label: "Replay", icon: "play" },
  { id: "zones", label: "Zone analytics", icon: "polygon" },
];

const mmss = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export default function AnalysisVisuals({ detections, va, frameSize }: { detections: SavedDetection[]; va: VideoAnalytics; frameSize?: { width: number; height: number } | null }) {
  const [view, setView] = useState<View>("heatmap");
  const [label, setLabel] = useState("all");
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const exactSize = !!frameSize && frameSize.width > 0 && frameSize.height > 0;
  const size = useMemo(() => (frameSize && exactSize ? frameSize : estimateFrameSize(detections)), [detections, frameSize, exactSize]);
  const frames = useMemo(() => framesFromSaved(detections, size), [detections, size]);
  const labels = useMemo(() => [...new Set(detections.map((d) => d.label))].sort(), [detections]);
  const duration = frames.length ? frames[frames.length - 1].t : 0;
  const heat = useMemo(() => buildHeatmap(frames, label), [frames, label]);
  const tracks = useMemo(() => buildTracks(frames, label), [frames, label]);
  const { zones, lines, rules } = va.setup;
  const batch = useMemo(() => analyzeBatch(frames, zones, lines, rules), [frames, zones, lines, rules]);

  useEffect(() => {
    setT(0);
    setPlaying(false);
    setLabel("all");
  }, [detections]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setT((prev) => {
        const next = prev + 0.1 * speed;
        if (next >= duration) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
    }, 100);
    return () => clearInterval(id);
  }, [playing, speed, duration]);

  const staticPaths: TrackPath[] = useMemo(() => tracks.map((tr) => ({ id: tr.id, label: tr.label, points: tr.points, age: 0 })), [tracks]);

  // replay: the frame at time t, plus the last few seconds of every trail
  const replay = useMemo(() => {
    if (!frames.length) return { boxes: [] as StageBox[], paths: [] as TrackPath[], counts: {} as Record<string, { total: number }> };
    let lo = 0, hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    const f = frames[lo];
    const shown = f.detections.filter((d) => label === "all" || d.label === label);
    const boxes: StageBox[] = shown.map((d) => ({ x1: d.x1 / f.width, y1: d.y1 / f.height, x2: d.x2 / f.width, y2: d.y2 / f.height, label: d.label, track_id: d.track_id, confidence: d.confidence }));
    const counts: Record<string, { total: number }> = {};
    for (const z of zones) counts[z.id] = { total: shown.filter((d) => pointInPolygon(footPoint(d, f.width, f.height), z.points)).length };
    const paths: TrackPath[] = [];
    for (const tr of tracks) {
      const pts = tr.points.filter((p) => p.t <= t && p.t >= t - 4);
      if (pts.length > 1) paths.push({ id: tr.id, label: tr.label, points: pts, age: 0 });
    }
    return { boxes, paths, counts };
  }, [frames, tracks, zones, label, t]);

  const staticZoneCounts = useMemo(() => Object.fromEntries(batch.zones.map((z) => [z.zoneId, { total: z.uniqueTracks }])), [batch]);
  const staticLineCounts = useMemo(() => Object.fromEntries(batch.lines.map((l) => [l.lineId, { forward: l.forward, backward: l.backward }])), [batch]);

  if (!frames.length) return <p className="subcopy">There are no detections to visualize for this analysis.</p>;

  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? "Zone";
  const lineName = (id: string) => lines.find((l) => l.id === id)?.name ?? "Line";

  return (
    <div className="visuals">
      <div className="visuals-head">
        <div className="segmented" role="tablist" aria-label="Visualization">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={view === v.id ? "on" : ""} onClick={() => { setView(v.id); setPlaying(false); }}>
              <Icon name={v.icon} size={15} /> {v.label}
            </button>
          ))}
        </div>
        <div className="visuals-tools">
          <select value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Class filter">
            <option value="all">All classes</option>
            {labels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <button type="button" className={`small-button${va.mode === "zone" ? " is-on" : ""}`} onClick={() => va.setMode(va.mode === "zone" ? "view" : "zone")}><Icon name="polygon" size={15} /> Zone</button>
          <button type="button" className={`small-button${va.mode === "line" ? " is-on" : ""}`} onClick={() => va.setMode(va.mode === "line" ? "view" : "line")}><Icon name="line" size={15} /> Line</button>
          {!zones.length && !lines.length && <button type="button" className="small-button" onClick={va.loadExample}><Icon name="zap" size={15} /> Example</button>}
        </div>
      </div>

      {view !== "zones" && (
        <>
          <OverlayStage
            width={size.width}
            height={size.height}
            backdrop
            zones={zones}
            lines={lines}
            zoneCounts={view === "replay" ? replay.counts : staticZoneCounts}
            lineCounts={staticLineCounts}
            heat={view === "heatmap" ? heat : null}
            paths={view === "trajectories" ? staticPaths : view === "replay" ? replay.paths : []}
            boxes={view === "replay" ? replay.boxes : []}
            showTrails
            mode={va.mode}
            onZoneDrawn={va.addZone}
            onLineDrawn={va.addLine}
            onCancelDraw={() => va.setMode("view")}
            ariaLabel={`${view} visualization`}
          />
          {view === "replay" && (
            <div className="replay-bar">
              <button type="button" className="icon-button big" aria-label={playing ? "Pause" : "Play"} onClick={() => { if (!playing && t >= duration) setT(0); setPlaying((p) => !p); }}>
                <Icon name={playing ? "pause" : "play"} size={18} />
              </button>
              <input type="range" min={0} max={Math.max(duration, 0.1)} step={0.05} value={t} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} aria-label="Replay position" />
              <span className="replay-time">{mmss(t)} / {mmss(duration)}</span>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
                <option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option>
              </select>
            </div>
          )}
          <p className="visuals-note">
            {view === "heatmap" && `Where objects spent time (${heat.samples} detections). Hotter colors mean more presence. `}
            {view === "trajectories" && `${tracks.length} tracked objects, each path colored by class. `}
            {view === "replay" && "Detections replayed from saved data; the video itself is not stored. "}
            {(zones.length > 0 || lines.length > 0) && (view === "replay" ? "Zone numbers show objects inside right now." : "Zone numbers show unique tracked objects that entered; line numbers show crossings.")}
            {" "}{exactSize ? `Video size ${size.width}×${size.height}.` : "Video size is estimated from the detections for this older saved analysis."}
          </p>
        </>
      )}

      {view === "zones" && (
        !zones.length && !lines.length ? (
          <div className="empty-state" style={{ minHeight: 160 }}>
            <p><strong>No zones or lines yet.</strong></p>
            <p className="subcopy">Draw them on the heatmap, trajectory or replay view, or in the Live tab, and this table fills in. Your setup applies to every analysis.</p>
            <button type="button" className="small-button" onClick={va.loadExample}><Icon name="zap" size={15} /> Load example setup</button>
          </div>
        ) : (
          <div className="zone-stats">
            {batch.zones.map((z) => (
              <div className="zone-card" key={z.zoneId}>
                <h4><span className="geo-dot" style={{ background: zones.find((x) => x.id === z.zoneId)?.color }} />{zoneName(z.zoneId)}</h4>
                <dl>
                  <div><dt>Objects entered</dt><dd>{z.uniqueTracks}</dd></div>
                  <div><dt>Peak at once</dt><dd>{z.maxConcurrent}</dd></div>
                  <div><dt>Total time inside</dt><dd>{formatDuration(z.totalDwell)}</dd></div>
                  <div><dt>Average stay</dt><dd>{z.avgDwell.toFixed(1)}s</dd></div>
                </dl>
                <div className="chips">{Object.entries(z.byLabel).map(([k, v]) => <span key={k} className="chip" style={{ borderColor: colorForLabel(k) }}>{v} {k}</span>)}</div>
              </div>
            ))}
            {batch.lines.map((l) => (
              <div className="zone-card" key={l.lineId}>
                <h4><span className="geo-dot geo-dot-line" style={{ background: lines.find((x) => x.id === l.lineId)?.color }} />{lineName(l.lineId)}</h4>
                <dl>
                  <div><dt>Forward ▸</dt><dd>{l.forward}</dd></div>
                  <div><dt>Backward ◂</dt><dd>{l.backward}</dd></div>
                </dl>
                <div className="chips">{Object.entries(l.byLabel).map(([k, v]) => <span key={k} className="chip" style={{ borderColor: colorForLabel(k) }}>{k}: {v.forward}▸ {v.backward}◂</span>)}</div>
              </div>
            ))}
            <div className="zone-events">
              <h4>Events in this clip</h4>
              {!batch.events.length ? <p className="subcopy">No entries, crossings or alerts.</p> : (
                <ul className="event-list">
                  {batch.events.slice(0, 14).map((e) => (
                    <li key={e.id} className={`ev-${e.kind === "alert" ? e.severity : "info"}`}>
                      <Icon name={e.kind === "alert" ? "bell" : e.kind === "cross" ? "route" : "target"} size={15} />
                      <span><b>{mmss(e.t)}</b> {e.message}</span>
                    </li>
                  ))}
                </ul>
              )}
              {batch.events.length > 14 && <p className="subcopy">+ {batch.events.length - 14} more events.</p>}
            </div>
          </div>
        )
      )}
    </div>
  );
}
