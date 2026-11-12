/**
 * Behaviour engine and AI-investigator helpers.
 *
 * Everything here works on the detections and track IDs the API already returns, so it costs the free API
 * server nothing: track profiles (colour, direction, speed, activity), behaviour events (running, possible
 * falls, objects left behind or removed, sudden crowd changes), an event timeline, a plain-language summary,
 * a built-in question answerer, and the text sent to the optional LLM. Pure TypeScript, unit-tested.
 *
 * All results are estimates from boxes on sampled frames, never proof of what happened.
 */
// Type-only import: keeps this module free of runtime imports so Node's test runner can load it directly.
import type { AnalyticsEvent, BatchResult, CountLine, Det, FrameData, Zone } from "./analytics";

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export type BehaviourSettings = {
  running: boolean;
  falls: boolean;
  leftBehind: boolean;
  removed: boolean;
  crowd: boolean;
  /** How long an object must sit still, unattended, before it counts as left behind (seconds). */
  leftBehindSeconds: number;
};
export const DEFAULT_BEHAVIOUR: BehaviourSettings = { running: true, falls: true, leftBehind: true, removed: true, crowd: true, leftBehindSeconds: 8 };

export function normalizeBehaviour(value: unknown): BehaviourSettings {
  const v = (value && typeof value === "object" ? value : {}) as Partial<BehaviourSettings>;
  const flag = (k: keyof BehaviourSettings) => (typeof v[k] === "boolean" ? (v[k] as boolean) : (DEFAULT_BEHAVIOUR[k] as boolean));
  const secs = Number(v.leftBehindSeconds);
  return {
    running: flag("running"), falls: flag("falls"), leftBehind: flag("leftBehind"), removed: flag("removed"), crowd: flag("crowd"),
    leftBehindSeconds: Number.isFinite(secs) ? Math.min(600, Math.max(2, secs)) : DEFAULT_BEHAVIOUR.leftBehindSeconds,
  };
}

/** Objects someone could carry in and leave (COCO class names). */
export const CARRYABLE = new Set([
  "backpack", "handbag", "suitcase", "umbrella", "bottle", "laptop", "cell phone", "book", "cup", "sports ball",
  "skateboard", "teddy bear", "remote", "scissors", "vase", "wine glass", "keyboard", "mouse", "frisbee", "kite",
]);
const VEHICLES = new Set(["car", "truck", "bus", "motorcycle", "bicycle", "train", "boat", "airplane"]);

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type BehaviourKind = "appear" | "leave" | "running" | "possible_fall" | "left_behind" | "removed" | "crowd_change" | "peak";
export type Severity = "info" | "warning" | "critical";
export type BehaviourEvent = {
  id: string;
  t: number;
  kind: BehaviourKind;
  severity: Severity;
  message: string;
  /** Why the rule fired, in plain words: the evidence behind the alert. */
  reason: string;
  trackId?: number;
  label?: string;
};

export type Activity = "stationary" | "walking" | "running" | "moving";
export type TrackProfile = {
  id: number;
  label: string;
  color: string | null;
  first: number;
  last: number;
  observations: number;
  avgConfidence: number;
  /** Screen direction of travel, e.g. "left to right", or null when it mostly stayed in place. */
  direction: string | null;
  approach: "towards the camera" | "away from the camera" | null;
  activity: Activity;
  /** Typical speed: body heights per second for people, frame diagonals per second for other objects. */
  speed: number;
  startRegion: string;
  endRegion: string;
  /** Longest time it stayed in one place (seconds). */
  longestStill: number;
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

export const mmss = (t: number) => {
  const s = Math.max(0, Math.floor(t + 1e-6));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const topVote = (votes: Record<string, number>) => Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const plural = (n: number, word: string) => {
  if (n === 1) return `1 ${word}`;
  if (word === "person") return `${n} people`;
  if (/(s|sh|ch|x)$/.test(word)) return `${n} ${word}es`;
  return `${n} ${word}s`;
};
function regionName(x: number): string {
  return x < 1 / 3 ? "the left side" : x > 2 / 3 ? "the right side" : "the centre";
}

/** "Person #3 (red top)" / "Backpack #7 (black)". */
export function nameTrack(label: string, id: number, color?: string | null): string {
  const c = color ? ` (${color}${label === "person" ? " top" : ""})` : "";
  return `${cap(label)} #${id}${c}`;
}

// ---------------------------------------------------------------------------------------------
// Behaviour monitor (incremental: one frame at a time; used for live frames and whole clips)
// ---------------------------------------------------------------------------------------------

type Obs = { t: number; cx: number; cy: number; w: number; h: number; cutBottom: boolean };
type TrackState = {
  id: number;
  labelVotes: Record<string, number>;
  colorVotes: Record<string, number>;
  first: number;
  last: number;
  n: number;
  confSum: number;
  frameW: number;
  frameH: number;
  head: Obs[];
  recent: Obs[];
  speeds: number[];
  announced: boolean;
  leaveEmitted: boolean;
  lastUpright: number | null;
  wideHits: number;
  fallAt: number | null;
  runHits: number;
  lastRunAlert: number;
  anchor: { x: number; y: number } | null;
  stillSince: number;
  longestStill: number;
  nearHits: number;
  unattendedSince: number | null;
  leftAlerted: boolean;
  nearAtLast: boolean;
  removedChecked: boolean;
};

export type MonitorOptions = { leaveAfter?: number };

let counter = 0;
const nextId = (p: string) => `${p}-${++counter}`;

export class BehaviourMonitor {
  settings: BehaviourSettings;
  private tracks = new Map<number, TrackState>();
  private lastT: number | null = null;
  private avgDt = 0.1;
  private crowdBase: number | null = null;
  private lastCrowdAlert = -1e9;
  private peak = { t: 0, count: 0 };
  private lastFrame: FrameData | null = null;
  private leaveAfterMin: number;

  constructor(settings: BehaviourSettings = DEFAULT_BEHAVIOUR, options: MonitorOptions = {}) {
    this.settings = settings;
    this.leaveAfterMin = options.leaveAfter ?? 1.5;
  }

  reset() {
    this.tracks.clear();
    this.lastT = null;
    this.avgDt = 0.1;
    this.crowdBase = null;
    this.lastCrowdAlert = -1e9;
    this.peak = { t: 0, count: 0 };
    this.lastFrame = null;
  }

  /** Busiest moment so far (people visible at once). */
  peakPeople() {
    return { ...this.peak };
  }

  update(frame: FrameData): BehaviourEvent[] {
    const events: BehaviourEvent[] = [];
    const { t, width: W, height: H } = frame;
    if (this.lastT !== null && t > this.lastT) this.avgDt = this.avgDt * 0.8 + Math.min(5, t - this.lastT) * 0.2;
    this.lastT = t;
    this.lastFrame = frame;
    const diag = Math.hypot(W, H) || 1;
    const people = frame.detections.filter((d) => d.label === "person");
    const s = this.settings;

    for (const d of frame.detections) {
      if (d.track_id === null || d.track_id === undefined) continue;
      const tr = this.track(d, t, W, H);
      const o = obsOf(d, t, H);
      tr.recent.push(o);
      while (tr.recent.length > 2 && t - tr.recent[0].t > 3) tr.recent.shift();
      if (tr.head.length < 3) tr.head.push(o);
      const label = topVote(tr.labelVotes) ?? d.label;
      const color = topVote(tr.colorVotes);

      if (!tr.announced && tr.n >= 2) {
        tr.announced = true;
        const first = tr.head[0];
        events.push({
          id: nextId("appear"), t: tr.first, kind: "appear", severity: "info", trackId: tr.id, label,
          message: `${nameTrack(label, tr.id, color)} appeared on ${regionName(first.cx / W)}.`,
          reason: `First detected at ${mmss(tr.first)} and tracked in ${tr.n} frames.`,
        });
      }

      // speed over roughly the last second (skips implausible jumps that come from ID switches)
      const ref = [...tr.recent].reverse().find((p) => t - p.t >= 0.6) ?? tr.recent[0];
      let speed: number | null = null;
      if (ref && t - ref.t >= 0.3) {
        const dist = Math.hypot(o.cx - ref.cx, o.cy - ref.cy);
        const scale = label === "person" ? Math.max(1, (o.h + ref.h) / 2) : diag;
        const sizeJump = Math.abs(o.h - ref.h) / Math.max(1, ref.h);
        if (!(label === "person" && (dist / scale > 3 * (t - ref.t) + 1.5 || sizeJump > 0.6))) {
          speed = dist / scale / (t - ref.t);
          tr.speeds.push(speed);
          if (tr.speeds.length > 600) tr.speeds = tr.speeds.filter((_, i) => i % 2 === 0);
        }
      }

      if (label === "person") {
        // running: fast for two observations in a row
        if (speed !== null && speed >= 1.8) tr.runHits += 1;
        else if (speed !== null) tr.runHits = 0;
        if (s.running && tr.runHits >= 2 && t - tr.lastRunAlert >= 8) {
          tr.lastRunAlert = t;
          events.push({
            id: nextId("running"), t, kind: "running", severity: "warning", trackId: tr.id, label,
            message: `${nameTrack(label, tr.id, color)} appears to be running.`,
            reason: `Moved about ${speed!.toFixed(1)} body lengths per second over the last second (walking is usually under 1).`,
          });
        }
        // possible fall: a standing person whose box becomes wide and low within a few seconds
        const ratio = o.h / Math.max(1, o.w);
        if (!o.cutBottom && ratio >= 1.4) {
          tr.lastUpright = t;
          tr.wideHits = 0;
          if (tr.fallAt !== null && t - tr.fallAt > 10) tr.fallAt = null;
        } else if (!o.cutBottom && ratio <= 0.85 && tr.lastUpright !== null && t - tr.lastUpright <= 3) {
          tr.wideHits += 1;
          if (s.falls && tr.wideHits >= 2 && tr.fallAt === null) {
            tr.fallAt = t;
            events.push({
              id: nextId("fall"), t, kind: "possible_fall", severity: "critical", trackId: tr.id, label,
              message: `Possible fall: ${nameTrack(label, tr.id, color)} went from standing to lying down.`,
              reason: `The box changed from upright to ${ratio.toFixed(2)}× as tall as it is wide within ${(t - tr.lastUpright).toFixed(1)}s. People sitting or bending can look similar.`,
            });
          }
        }
      } else {
        // stillness, and whether a person is next to the object
        const moveTol = Math.max(0.5 * Math.hypot(o.w, o.h), 0.03 * diag);
        if (!tr.anchor || Math.hypot(o.cx - tr.anchor.x, o.cy - tr.anchor.y) > moveTol) {
          tr.anchor = { x: o.cx, y: o.cy };
          tr.stillSince = t;
          tr.unattendedSince = null;
          tr.leftAlerted = false;
        }
        const still = t - tr.stillSince;
        tr.longestStill = Math.max(tr.longestStill, still);
        const near = people.some((p) => {
          const pw = p.x2 - p.x1, ph = p.y2 - p.y1;
          return o.cx >= p.x1 - 0.25 * pw && o.cx <= p.x2 + 0.25 * pw && o.cy >= p.y1 - 0.25 * ph && o.cy <= p.y2 + 0.25 * ph;
        });
        tr.nearAtLast = near;
        if (near) {
          tr.nearHits += 1;
          tr.unattendedSince = null;
        } else if (tr.unattendedSince === null) tr.unattendedSince = t;
        const alone = tr.unattendedSince === null ? 0 : t - tr.unattendedSince;
        if (s.leftBehind && CARRYABLE.has(label) && tr.nearHits >= 2 && !tr.leftAlerted && still >= s.leftBehindSeconds && alone >= s.leftBehindSeconds) {
          tr.leftAlerted = true;
          events.push({
            id: nextId("left"), t, kind: "left_behind", severity: "warning", trackId: tr.id, label,
            message: `${nameTrack(label, tr.id, color)} may have been left behind.`,
            reason: `A person was next to it earlier; it has not moved for ${still.toFixed(0)}s and nobody has been near it for ${alone.toFixed(0)}s.`,
          });
        }
      }
    }

    // tracks that are no longer visible
    const seen = new Set(frame.detections.map((d) => d.track_id));
    const leaveAfter = Math.max(this.leaveAfterMin, 3 * this.avgDt);
    for (const tr of this.tracks.values()) {
      if (seen.has(tr.id)) continue;
      const gone = t - tr.last;
      const label = topVote(tr.labelVotes) ?? "object";
      const color = topVote(tr.colorVotes);
      if (tr.announced && !tr.leaveEmitted && gone >= leaveAfter) {
        tr.leaveEmitted = true;
        const lastO = tr.recent[tr.recent.length - 1];
        events.push({
          id: nextId("leave"), t: tr.last, kind: "leave", severity: "info", trackId: tr.id, label,
          message: `${nameTrack(label, tr.id, color)} was last seen on ${regionName(lastO.cx / tr.frameW)} after ${(tr.last - tr.first).toFixed(1)}s in view.`,
          reason: `Not detected since ${mmss(tr.last)}.`,
        });
      }
      // an object that sat in one place, then vanished away from the frame edge, and was not re-detected there
      const removedAfter = Math.max(3, 3 * this.avgDt);
      if (s.removed && !tr.removedChecked && label !== "person" && !VEHICLES.has(label) && gone > 0) {
        const lastO = tr.recent[tr.recent.length - 1];
        // re-detected at the same spot (often under a new ID) while we wait: it was only missed for a moment
        if (frame.detections.some((d) => d.label === label && Math.hypot((d.x1 + d.x2) / 2 - lastO.cx, (d.y1 + d.y2) / 2 - lastO.cy) < Math.max(lastO.w, lastO.h))) tr.removedChecked = true;
      }
      if (s.removed && !tr.removedChecked && label !== "person" && !VEHICLES.has(label) && gone >= removedAfter) {
        tr.removedChecked = true;
        const lastO = tr.recent[tr.recent.length - 1];
        const margin = 0.04;
        const atEdge = (lastO.cx - lastO.w / 2) / tr.frameW < margin || (lastO.cx + lastO.w / 2) / tr.frameW > 1 - margin || (lastO.cy - lastO.h / 2) / tr.frameH < margin || (lastO.cy + lastO.h / 2) / tr.frameH > 1 - margin;
        if (tr.longestStill >= s.leftBehindSeconds && !atEdge) {
          events.push({
            id: nextId("removed"), t: tr.last, kind: "removed", severity: "warning", trackId: tr.id, label,
            message: `${nameTrack(label, tr.id, color)} disappeared from where it had been for ${tr.longestStill.toFixed(0)}s.`,
            reason: `Not detected since ${mmss(tr.last)} and not re-detected at that spot${tr.nearAtLast ? "; a person was next to it when it was last seen" : ""}. It may have been taken, moved or hidden from view.`,
          });
        }
      }
      if (gone > 120) this.tracks.delete(tr.id);
    }

    // crowd: people visible right now vs. the last few seconds
    const count = people.length;
    if (count > this.peak.count) this.peak = { t, count };
    if (this.crowdBase === null) this.crowdBase = count;
    else {
      const base = this.crowdBase;
      const change = count - base;
      if (s.crowd && Math.abs(change) >= Math.max(3, 0.5 * base) && Math.max(count, base) >= 3 && t - this.lastCrowdAlert >= 6) {
        this.lastCrowdAlert = t;
        events.push({
          id: nextId("crowd"), t, kind: "crowd_change", severity: "warning",
          message: change > 0 ? `The number of people rose quickly to ${count}.` : `The number of people dropped quickly to ${count}.`,
          reason: `About ${Math.round(base)} people were visible over the previous few seconds; now ${count}.`,
        });
      }
      this.crowdBase = base + (count - base) * Math.min(1, this.avgDt / 4);
    }
    return events;
  }

  private track(d: Det, t: number, W: number, H: number): TrackState {
    const id = d.track_id as number;
    let tr = this.tracks.get(id);
    if (!tr) {
      tr = {
        id, labelVotes: {}, colorVotes: {}, first: t, last: t, n: 0, confSum: 0, frameW: W, frameH: H, head: [], recent: [], speeds: [],
        announced: false, leaveEmitted: false, lastUpright: null, wideHits: 0, fallAt: null, runHits: 0, lastRunAlert: -1e9,
        anchor: null, stillSince: t, longestStill: 0, nearHits: 0, unattendedSince: null, leftAlerted: false, nearAtLast: false, removedChecked: false,
      };
      this.tracks.set(id, tr);
    }
    if (tr.leaveEmitted && t - tr.last > 0) {
      // came back under the same ID: treat as a new appearance
      tr.leaveEmitted = false;
      tr.removedChecked = false;
    }
    tr.labelVotes[d.label] = (tr.labelVotes[d.label] || 0) + 1;
    if (d.color) tr.colorVotes[d.color] = (tr.colorVotes[d.color] || 0) + 1;
    tr.last = t;
    tr.n += 1;
    tr.confSum += d.confidence;
    tr.frameW = W;
    tr.frameH = H;
    return tr;
  }

  /** What each tracked object did (for the timeline, questions and the report). */
  profiles(): TrackProfile[] {
    const out: TrackProfile[] = [];
    for (const tr of this.tracks.values()) {
      if (tr.n < 2) continue;
      const label = topVote(tr.labelVotes) ?? "object";
      const a = tr.head, b = tr.recent;
      const start = { x: median(a.map((o) => o.cx)), y: median(a.map((o) => o.cy)) };
      const end = { x: median(b.slice(-3).map((o) => o.cx)), y: median(b.slice(-3).map((o) => o.cy)) };
      const dx = (end.x - start.x) / tr.frameW, dy = (end.y - start.y) / tr.frameH;
      let direction: string | null = null;
      if (Math.hypot(dx, dy) >= 0.08) {
        const horiz = Math.abs(dx) >= 0.06 ? (dx > 0 ? "left to right" : "right to left") : "";
        const vert = Math.abs(dy) >= 0.06 ? (dy > 0 ? "down the frame" : "up the frame") : "";
        direction = horiz && vert ? (Math.abs(dx) >= Math.abs(dy) ? `${horiz}, ${vert}` : `${vert}, ${horiz}`) : horiz || vert;
      }
      const h0 = median(a.map((o) => o.h)), h1 = median(b.slice(-3).map((o) => o.h));
      const growth = h1 / Math.max(1, h0);
      const approach = growth >= 1.35 ? "towards the camera" : growth <= 0.74 ? "away from the camera" : null;
      const speed = median(tr.speeds);
      const activity: Activity = label === "person"
        ? speed < 0.15 ? "stationary" : speed < 1.6 ? "walking" : "running"
        : speed < 0.01 ? "stationary" : "moving";
      out.push({
        id: tr.id, label, color: topVote(tr.colorVotes), first: tr.first, last: tr.last, observations: tr.n,
        avgConfidence: tr.confSum / tr.n, direction, approach, activity, speed,
        startRegion: regionName(start.x / tr.frameW), endRegion: regionName(end.x / tr.frameW), longestStill: tr.longestStill,
      });
    }
    return out.sort((x, y) => x.first - y.first || x.id - y.id);
  }
}

function obsOf(d: Det, t: number, H: number): Obs {
  return { t, cx: (d.x1 + d.x2) / 2, cy: (d.y1 + d.y2) / 2, w: d.x2 - d.x1, h: d.y2 - d.y1, cutBottom: d.y2 >= H * 0.985 };
}

// ---------------------------------------------------------------------------------------------
// Scene guess
// ---------------------------------------------------------------------------------------------

const SCENES: { name: string; classes: string[]; needs?: string[] }[] = [
  { name: "a street, road or parking area", classes: ["car", "truck", "bus", "motorcycle", "bicycle", "traffic light", "stop sign", "parking meter"] },
  { name: "a bedroom", classes: ["bed"] },
  { name: "a kitchen or dining area", classes: ["dining table", "oven", "microwave", "refrigerator", "sink", "bowl", "cup", "fork", "knife", "spoon", "wine glass"] },
  { name: "an office or desk", classes: ["laptop", "keyboard", "mouse", "tv", "book", "cell phone"], needs: ["laptop", "keyboard", "mouse"] },
  { name: "a living room or home", classes: ["couch", "tv", "potted plant", "chair", "remote", "vase", "clock"] },
  { name: "a home with pets", classes: ["cat", "dog"] },
  { name: "an outdoor area", classes: ["bench", "bird", "umbrella", "kite", "fire hydrant"] },
];

/** A rough guess of the kind of place, from the objects seen. Null when there is nothing to go on. */
export function guessScene(uniqueByLabel: Record<string, number>, peakPeople = 0): { name: string; basis: string[] } | null {
  if (peakPeople >= 8) return { name: "a crowded area", basis: [`up to ${peakPeople} people at once`] };
  let best: { name: string; basis: string[]; score: number } | null = null;
  for (const sc of SCENES) {
    const basis = sc.classes.filter((c) => uniqueByLabel[c]);
    if (!basis.length || (sc.needs && !sc.needs.some((c) => uniqueByLabel[c]))) continue;
    const score = basis.length + basis.reduce((n, c) => n + Math.min(2, uniqueByLabel[c]) * 0.1, 0);
    if (!best || score > best.score) best = { name: sc.name, basis, score };
  }
  if (best) return { name: best.name, basis: best.basis };
  if (uniqueByLabel.person) return { name: "an indoor or outdoor space with people", basis: ["person"] };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------------------------

export type TimelineItem = {
  id: string;
  t: number;
  severity: Severity;
  title: string;
  detail: string;
  reason?: string;
  trackId?: number;
  kind: string;
  source: "behaviour" | "zone" | "rule";
};

const TITLES: Record<string, string> = {
  appear: "Appeared", leave: "Left view", running: "Possible running", possible_fall: "Possible fall",
  left_behind: "Possibly left behind", removed: "Possibly removed", crowd_change: "Crowd changed quickly", peak: "Busiest moment",
  enter: "Entered zone", exit: "Left zone", cross: "Crossed line", alert: "Rule alert",
};

/** One chronological list: behaviour events, zone and line events, and rule alerts. Keeps every warning, thins out routine items. */
export function buildTimeline(behaviour: BehaviourEvent[], zoneEvents: AnalyticsEvent[] = [], max = 60): TimelineItem[] {
  const items: TimelineItem[] = [
    ...behaviour.map((e) => ({ id: e.id, t: e.t, severity: e.severity, title: TITLES[e.kind] ?? cap(e.kind), detail: e.message, reason: e.reason, trackId: e.trackId, kind: e.kind, source: "behaviour" as const })),
    ...zoneEvents.map((e) => ({ id: e.id, t: e.t, severity: e.severity, title: TITLES[e.kind] ?? cap(e.kind), detail: e.message, trackId: e.trackId, kind: e.kind, source: (e.kind === "alert" ? "rule" : "zone") as "rule" | "zone" })),
  ].sort((a, b) => a.t - b.t);
  if (items.length <= max) return items;
  const important = items.filter((i) => i.severity !== "info");
  const routine = items.filter((i) => i.severity === "info");
  const room = Math.max(0, max - important.length);
  const step = routine.length / Math.max(1, room);
  const kept = room ? Array.from({ length: Math.min(room, routine.length) }, (_, k) => routine[Math.floor(k * step)]) : [];
  return [...important, ...kept].sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------------------------
// One investigation (a whole clip, or the live session so far)
// ---------------------------------------------------------------------------------------------

export type Keyframe = { t: number; frame: number; labels: Record<string, number>; image: string };

export type Investigation = {
  source: "clip" | "live";
  name: string;
  duration: number;
  framesProcessed: number;
  profiles: TrackProfile[];
  behaviour: BehaviourEvent[];
  timeline: TimelineItem[];
  uniqueByLabel: Record<string, number>;
  untrackedByLabel: Record<string, number>;
  peakPeople: { t: number; count: number };
  scene: { name: string; basis: string[] } | null;
  zoneLines: string[];
  runConfig?: Record<string, unknown> | null;
};

export function investigateClip(
  frames: FrameData[],
  opts: {
    name: string; duration: number; framesProcessed: number; settings?: BehaviourSettings; runConfig?: Record<string, unknown> | null;
    /** Zone and line results for the same frames (analyzeBatch), with the zones and lines they refer to. */
    zoneBatch?: BatchResult | null; zones?: Zone[]; lines?: CountLine[];
  },
): Investigation {
  const monitor = new BehaviourMonitor(opts.settings ?? DEFAULT_BEHAVIOUR);
  const behaviour: BehaviourEvent[] = [];
  for (const f of frames) behaviour.push(...monitor.update(f));
  const last = frames[frames.length - 1];
  const zones = opts.zones ?? [], lines = opts.lines ?? [];
  const batch = zones.length || lines.length ? opts.zoneBatch ?? null : null;
  const zoneEvents = batch?.events ?? [];
  const zoneLines: string[] = [];
  if (batch) {
    for (const z of batch.zones) {
      const name = zones.find((x) => x.id === z.zoneId)?.name ?? "zone";
      const what = Object.entries(z.byLabel).map(([k, v]) => plural(v, k)).join(", ") || "nothing";
      zoneLines.push(`Zone "${name}": ${what} entered; at most ${z.maxConcurrent} inside at once; average stay ${z.avgDwell.toFixed(1)}s.`);
    }
    for (const l of batch.lines) {
      const name = lines.find((x) => x.id === l.lineId)?.name ?? "line";
      zoneLines.push(`Line "${name}": ${l.forward} crossings forward, ${l.backward} backward.`);
    }
  }
  const profiles = monitor.profiles();
  const peak = monitor.peakPeople();
  if (peak.count >= 2) behaviour.push({ id: nextId("peak"), t: peak.t, kind: "peak", severity: "info", message: `Busiest moment: ${peak.count} people visible at once.`, reason: `Highest number of people detected in one frame.` });
  return finish({
    source: "clip", name: opts.name, duration: opts.duration || last?.t || 0, framesProcessed: opts.framesProcessed || frames.length,
    profiles, behaviour, zoneEvents, frames, peak, zoneLines, runConfig: opts.runConfig ?? null,
  });
}

/** Snapshot of a live session (the monitor keeps running). */
export function investigateLive(monitor: BehaviourMonitor, events: BehaviourEvent[], zoneEvents: AnalyticsEvent[], startedAt: number | null, now: number): Investigation {
  return finish({
    source: "live", name: "live camera session", duration: startedAt ? Math.max(0, now - startedAt) : 0, framesProcessed: 0,
    profiles: monitor.profiles(), behaviour: events, zoneEvents, frames: [], peak: monitor.peakPeople(), zoneLines: [], runConfig: null,
  });
}

function finish(x: {
  source: "clip" | "live"; name: string; duration: number; framesProcessed: number; profiles: TrackProfile[]; behaviour: BehaviourEvent[];
  zoneEvents: AnalyticsEvent[]; frames: FrameData[]; peak: { t: number; count: number }; zoneLines: string[]; runConfig: Record<string, unknown> | null;
}): Investigation {
  const uniqueByLabel: Record<string, number> = {};
  for (const p of x.profiles) uniqueByLabel[p.label] = (uniqueByLabel[p.label] || 0) + 1;
  // classes that were never tracked still count once (largest number seen in a single frame)
  const untrackedByLabel: Record<string, number> = {};
  for (const f of x.frames) {
    const perFrame: Record<string, number> = {};
    for (const d of f.detections) if (d.track_id === null) perFrame[d.label] = (perFrame[d.label] || 0) + 1;
    for (const [k, v] of Object.entries(perFrame)) untrackedByLabel[k] = Math.max(untrackedByLabel[k] || 0, v);
  }
  for (const [k, v] of Object.entries(untrackedByLabel)) if (!uniqueByLabel[k]) uniqueByLabel[k] = v;
  const behaviour = [...x.behaviour].sort((a, b) => a.t - b.t);
  return {
    source: x.source, name: x.name, duration: x.duration, framesProcessed: x.framesProcessed, profiles: x.profiles, behaviour,
    timeline: buildTimeline(behaviour, x.zoneEvents), uniqueByLabel, untrackedByLabel, peakPeople: x.peak,
    scene: guessScene(uniqueByLabel, x.peak.count), zoneLines: x.zoneLines, runConfig: x.runConfig,
  };
}

// ---------------------------------------------------------------------------------------------
// Summary, questions, search, report
// ---------------------------------------------------------------------------------------------

const objectsLine = (u: Record<string, number>) =>
  Object.entries(u).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => plural(v, k)).join(", ");

const ALERT_KINDS = ["possible_fall", "left_behind", "removed", "running", "crowd_change"];

export function summarize(inv: Investigation): string {
  const parts: string[] = [];
  const where = inv.source === "live" ? `This live session (${Math.round(inv.duration)}s so far)` : `This ${inv.duration.toFixed(0)}-second clip`;
  const objects = objectsLine(inv.uniqueByLabel);
  parts.push(objects ? `${where} shows ${objects}.` : `${where} shows no objects above the confidence threshold.`);
  if (inv.scene) parts.push(`It looks like ${inv.scene.name} (an estimate based on: ${inv.scene.basis.join(", ")}).`);
  const people = inv.profiles.filter((p) => p.label === "person");
  if (people.length) {
    const moves = people.slice(0, 3).map((p) => {
      const bits = [p.activity === "stationary" ? "mostly stayed in place" : p.activity];
      if (p.direction && p.activity !== "stationary") bits.push(`moving ${p.direction}`);
      if (p.approach) bits.push(p.approach);
      return `${nameTrack("person", p.id, p.color)} was in view ${mmss(p.first)}–${mmss(p.last)} and ${bits.join(", ")}`;
    });
    parts.push(moves.join("; ") + (people.length > 3 ? `; and ${people.length - 3} more.` : "."));
  }
  const others = inv.profiles.filter((p) => p.label !== "person" && p.activity === "moving");
  if (others.length) parts.push(`Moving objects: ${others.slice(0, 4).map((p) => `${nameTrack(p.label, p.id, p.color)}${p.direction ? ` (${p.direction})` : ""}`).join(", ")}.`);
  const alerts = inv.behaviour.filter((e) => ALERT_KINDS.includes(e.kind));
  if (alerts.length) parts.push(`Needs a look: ${alerts.slice(0, 4).map((e) => `${mmss(e.t)} ${e.message.replace(/\.$/, "")}`).join("; ")}.`);
  else parts.push("No running, possible falls, unattended or removed objects, or sudden crowd changes were detected.");
  if (inv.zoneLines.length) parts.push(inv.zoneLines.slice(0, 3).join(" "));
  return parts.join(" ");
}

/** Text for the LLM: compact, factual, and with every timestamp the answer may cite. */
export function buildContext(inv: Investigation, maxChars = 20000): string {
  const safeName = inv.name.replace(/[<>{}\n\r`]/g, " ").slice(0, 80);
  const lines: string[] = [];
  lines.push(inv.source === "live" ? `SOURCE: live camera session, ${Math.round(inv.duration)}s so far` : `SOURCE: uploaded clip "${safeName}", ${inv.duration.toFixed(1)}s long, ${inv.framesProcessed} sampled frames`);
  if (inv.scene) lines.push(`SCENE (estimate): ${inv.scene.name} (from: ${inv.scene.basis.join(", ")})`);
  lines.push(`OBJECTS (unique tracked objects): ${objectsLine(inv.uniqueByLabel) || "none"}`);
  lines.push(`PEOPLE: ${inv.uniqueByLabel.person || 0} tracked; at most ${inv.peakPeople.count} visible at once${inv.peakPeople.count ? ` (at ${mmss(inv.peakPeople.t)})` : ""}`);
  lines.push("TRACKS (id, class, colour, time in view, movement):");
  for (const p of inv.profiles.slice(0, 80)) {
    const move = [p.activity, p.direction ? `moved ${p.direction}` : "", p.approach ?? "", p.longestStill >= 5 ? `still for up to ${p.longestStill.toFixed(0)}s` : ""].filter(Boolean).join(", ");
    lines.push(`#${p.id} ${p.label}${p.color ? `, ${p.color}${p.label === "person" ? " top" : ""}` : ""}, ${mmss(p.first)}-${mmss(p.last)} (${(p.last - p.first).toFixed(1)}s), from ${p.startRegion} to ${p.endRegion}, ${move}, avg confidence ${(p.avgConfidence * 100).toFixed(0)}%`);
  }
  if (inv.profiles.length > 80) lines.push(`(+${inv.profiles.length - 80} more tracks not listed)`);
  lines.push("TIMELINE:");
  for (const i of inv.timeline) lines.push(`${mmss(i.t)} [${i.severity}] ${i.detail}${i.reason && i.severity !== "info" ? ` Evidence: ${i.reason}` : ""}`);
  if (!inv.timeline.length) lines.push("(no events)");
  if (inv.zoneLines.length) lines.push("ZONES AND LINES:", ...inv.zoneLines);
  if (inv.runConfig) lines.push(`SETTINGS: ${Object.entries(inv.runConfig).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars - 40) + "\n(event data truncated)";
  return text;
}

const SYNONYMS: Record<string, string[]> = {
  person: ["person", "people", "persons", "man", "men", "woman", "women", "someone", "anyone", "human", "humans", "guy", "girl", "boy", "visitor", "visitors", "individual"],
  car: ["car", "cars", "vehicle", "vehicles", "auto"],
  truck: ["truck", "trucks", "lorry"],
  bus: ["bus", "buses"],
  motorcycle: ["motorcycle", "motorcycles", "motorbike", "bike", "okada"],
  bicycle: ["bicycle", "bicycles", "cycle"],
  backpack: ["backpack", "backpacks", "bag", "bags", "rucksack"],
  handbag: ["handbag", "handbags", "bag", "bags", "purse"],
  suitcase: ["suitcase", "suitcases", "luggage", "bag", "bags"],
  "cell phone": ["phone", "phones", "cellphone", "mobile"],
  dog: ["dog", "dogs"],
  cat: ["cat", "cats"],
  laptop: ["laptop", "laptops", "computer"],
  bottle: ["bottle", "bottles"],
};
const COLORS = ["black", "white", "gray", "grey", "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown"];

/** COCO labels a question mentions ("people" → person; "bags" → backpack, handbag, suitcase). */
export function labelsIn(text: string, known: string[]): string[] {
  const q = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ")} `;
  const out = new Set<string>();
  for (const [label, words] of Object.entries(SYNONYMS)) if (words.some((w) => q.includes(` ${w} `))) out.add(label);
  for (const k of known) {
    const kk = k.toLowerCase();
    if (q.includes(` ${kk} `) || q.includes(` ${kk}s `) || q.includes(` ${kk}es `)) out.add(k);
  }
  return [...out];
}

function timesIn(q: string): number[] {
  const out: number[] = [];
  for (const m of q.matchAll(/(\d{1,2}):(\d{2})/g)) out.push(Number(m[1]) * 60 + Number(m[2]));
  if (!out.length) for (const m of q.matchAll(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/g)) out.push(Number(m[1]));
  return out;
}

export type LocalAnswer = { answer: string; times: number[] };

/** Built-in analyst: answers common questions straight from the event data (no AI key needed). */
export function answerLocally(question: string, inv: Investigation): LocalAnswer {
  const q = question.toLowerCase();
  const known = Object.keys(inv.uniqueByLabel);
  const labels = labelsIn(q, known);
  const color = COLORS.find((c) => new RegExp(`\\b${c}\\b`).test(q))?.replace("grey", "gray") ?? null;
  const byKind = (k: string) => inv.behaviour.filter((e) => e.kind === k);
  const list = (evs: { t: number; message: string }[], n = 5) => evs.slice(0, n).map((e) => `${mmss(e.t)} — ${e.message}`).join("\n");
  const times = timesIn(q);
  const describe = (p: TrackProfile) => `${nameTrack(p.label, p.id, p.color)}: ${mmss(p.first)}–${mmss(p.last)}, ${p.activity}${p.direction ? `, ${p.direction}` : ""}`;

  if (times.length >= 2 || (times.length === 1 && /\b(at|around|after|before|from|between)\b/.test(q))) {
    let [a, b] = times.length >= 2 ? [Math.min(times[0], times[1]), Math.max(times[0], times[1])] : [times[0] - 2, times[0] + 2];
    if (/\bafter\b/.test(q) && times.length === 1) [a, b] = [times[0], inv.duration];
    if (/\bbefore\b/.test(q) && times.length === 1) [a, b] = [0, times[0]];
    const evs = inv.timeline.filter((i) => i.t >= a && i.t <= b);
    const visible = inv.profiles.filter((p) => p.first <= b && p.last >= a);
    const lines = [`Between ${mmss(a)} and ${mmss(b)}:`];
    lines.push(visible.length ? `In view: ${visible.slice(0, 8).map((p) => nameTrack(p.label, p.id, p.color)).join(", ")}.` : "No tracked objects were in view.");
    lines.push(evs.length ? list(evs.map((e) => ({ t: e.t, message: e.detail })), 8) : "No events were recorded in that interval.");
    return { answer: lines.join("\n"), times: evs.map((e) => e.t) };
  }
  if (/left behind|abandon|forgot|unattended|left (a|an|the|their|his|her)|leave (a|an|the)/.test(q)) {
    const evs = byKind("left_behind");
    return evs.length
      ? { answer: `Yes, possibly:\n${list(evs)}\nThese are estimates; check the evidence frames.`, times: evs.map((e) => e.t) }
      : { answer: `No object was flagged as left behind. The check looks for bags and other carryable objects that a person was next to, then sat still with nobody near for ${DEFAULT_BEHAVIOUR.leftBehindSeconds}s or more (the time is adjustable).`, times: [] };
  }
  if (/remov|stol|steal|taken|took|missing|disappear|vanish/.test(q)) {
    const evs = byKind("removed");
    return evs.length ? { answer: `Possibly:\n${list(evs)}`, times: evs.map((e) => e.t) } : { answer: "No object that had been sitting in one place disappeared during this video.", times: [] };
  }
  if (/\bfall|fell|collapse|lying|on the (floor|ground)/.test(q)) {
    const evs = byKind("possible_fall");
    return evs.length ? { answer: `Possible fall detected:\n${list(evs)}\nSitting down or bending can look similar; check the evidence.`, times: evs.map((e) => e.t) } : { answer: "No possible falls were detected (a standing person whose box quickly became wide and low).", times: [] };
  }
  if (/\brun|running|ran|rush|hurr|fast/.test(q)) {
    const evs = byKind("running");
    const runners = inv.profiles.filter((p) => p.activity === "running");
    if (evs.length) return { answer: `Yes:\n${list(evs)}`, times: evs.map((e) => e.t) };
    return { answer: runners.length ? `Moving fast at times: ${runners.map(describe).join("; ")}.` : "Nobody appeared to be running.", times: runners.map((p) => p.first) };
  }
  if (/crowd|busy|busiest|peak|most people|how full/.test(q)) {
    const evs = byKind("crowd_change");
    const p = inv.peakPeople;
    return { answer: `${p.count ? `At most ${plural(p.count, "person")} were visible at once, at ${mmss(p.t)}.` : "No people were detected."}${evs.length ? `\nSudden changes:\n${list(evs)}` : ""}`, times: [p.t, ...evs.map((e) => e.t)] };
  }
  if (color) {
    const matches = inv.profiles.filter((p) => p.color === color && (!labels.length || labels.includes(p.label)));
    if (!matches.length) return { answer: `I found no ${labels.length ? labels.join("/") : "object"} whose main colour was ${color}. Colours: ${[...new Set(inv.profiles.filter((p) => p.color).map((p) => `${p.color} ${p.label}`))].slice(0, 8).join(", ") || "none recorded (older analyses do not have colours)"}.`, times: [] };
    return { answer: `${matches.map((p) => `${nameTrack(p.label, p.id, p.color)} first appeared at ${mmss(p.first)} and was last seen at ${mmss(p.last)} (${p.activity}${p.direction ? `, ${p.direction}` : ""}).`).join("\n")}\nColours are approximate.`, times: matches.map((p) => p.first) };
  }
  if (/\b(cross|crossed|crossing|line)\b/.test(q)) {
    const evs = inv.timeline.filter((i) => i.kind === "cross" && (!labels.length || labels.some((l) => i.detail.toLowerCase().includes(l))));
    return evs.length ? { answer: `${evs.length} line crossing${evs.length === 1 ? "" : "s"}:\n${list(evs.map((e) => ({ t: e.t, message: e.detail })), 8)}`, times: evs.map((e) => e.t) } : { answer: inv.zoneLines.some((l) => l.startsWith("Line")) ? "No line crossings were recorded." : "No counting line is set up. Draw a line on the video to count crossings.", times: [] };
  }
  if (/\b(enter|entered|entering|came in|come in|walked in|zone)\b/.test(q)) {
    const evs = inv.timeline.filter((i) => i.kind === "enter" && (!labels.length || labels.some((l) => i.detail.toLowerCase().includes(l))));
    if (evs.length) return { answer: `${evs.length} zone entr${evs.length === 1 ? "y" : "ies"}:\n${list(evs.map((e) => ({ t: e.t, message: e.detail })), 8)}`, times: evs.map((e) => e.t) };
    const appeared = inv.profiles.filter((p) => !labels.length || labels.includes(p.label));
    return { answer: `${inv.zoneLines.length ? "No zone entries were recorded." : "No zone is set up, so I counted objects that came into view instead."} ${plural(appeared.length, labels[0] ?? "object")} appeared: ${appeared.slice(0, 8).map((p) => `${nameTrack(p.label, p.id, p.color)} at ${mmss(p.first)}`).join(", ") || "none"}.`, times: appeared.map((p) => p.first) };
  }
  if (/how many|number of|count/.test(q)) {
    const targets = labels.length ? labels : known;
    const parts = targets.map((l) => plural(inv.uniqueByLabel[l] || 0, l));
    const extra = targets.includes("person") && inv.peakPeople.count ? ` At most ${plural(inv.peakPeople.count, "person")} were visible at the same time (${mmss(inv.peakPeople.t)}).` : "";
    return { answer: `${parts.join(", ") || "No objects"} (each tracked object counted once).${extra} Counts can be off when tracking loses an object and gives it a new ID.`, times: [] };
  }
  if (/when|what time|first|appear|show up|arriv/.test(q) && labels.length) {
    const ps = inv.profiles.filter((p) => labels.includes(p.label));
    return ps.length ? { answer: ps.slice(0, 8).map((p) => `${nameTrack(p.label, p.id, p.color)} appeared at ${mmss(p.first)}, last seen ${mmss(p.last)}.`).join("\n"), times: ps.map((p) => p.first) } : { answer: `No ${labels.join("/")} was detected.`, times: [] };
  }
  if (/what happen|happening|summar|describe|overview|going on|tell me|explain|report|attention|unusual|suspicious|wrong/.test(q) || !q.trim()) {
    const key = inv.timeline.filter((i) => i.severity !== "info").slice(0, 5);
    return { answer: summarize(inv) + (key.length ? `\nKey moments:\n${key.map((i) => `${mmss(i.t)} — ${i.detail}`).join("\n")}` : ""), times: key.map((i) => i.t) };
  }
  const hits = searchTimeline(inv.timeline, question).slice(0, 6);
  if (hits.length) return { answer: `Related events:\n${hits.map((i) => `${mmss(i.t)} — ${i.detail}`).join("\n")}`, times: hits.map((i) => i.t) };
  return { answer: "I could not find that in the event data. I can answer about what happened, counts, when something appeared, colours, running, possible falls, objects left behind or removed, crowding, and zone or line events. Add an AI key on the API for free-form questions.", times: [] };
}

/** Text search over a timeline, with class-name synonyms ("bag" finds backpacks). */
export function searchTimeline(items: TimelineItem[], query: string): TimelineItem[] {
  const words = query.toLowerCase().split(/[^a-z0-9#]+/).filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) return items;
  const expanded = words.map((w) => {
    const syn = Object.entries(SYNONYMS).filter(([, ws]) => ws.includes(w)).map(([label]) => label);
    return [w, ...syn];
  });
  return items
    .map((i) => {
      const hay = `${i.title} ${i.detail} ${i.reason ?? ""} ${i.kind.replace("_", " ")}`.toLowerCase();
      const score = expanded.filter((alts) => alts.some((a) => hay.includes(a))).length;
      return { i, score };
    })
    .filter((x) => x.score > 0 && x.score >= Math.ceil(expanded.length / 2))
    .sort((a, b) => b.score - a.score || a.i.t - b.i.t)
    .map((x) => x.i);
}
const STOP = new Set(["the", "a", "an", "of", "in", "on", "at", "to", "and", "or", "is", "was", "were", "did", "does", "any", "all", "with", "who", "what", "find", "show", "me", "clips", "clip", "video", "videos", "where"]);

/** Searchable words saved with an analysis (classes, colours, behaviours, scene). */
export function buildTags(inv: Investigation): string[] {
  const tags = new Set<string>();
  for (const k of Object.keys(inv.uniqueByLabel)) tags.add(k);
  for (const p of inv.profiles) if (p.color) tags.add(`${p.color} ${p.label}`);
  for (const e of inv.behaviour) if (e.kind !== "appear" && e.kind !== "leave" && e.kind !== "peak") tags.add(e.kind.replace("_", " "));
  if (inv.peakPeople.count >= 5) tags.add("crowd");
  if (inv.scene) tags.add(inv.scene.name.replace(/^an? /, ""));
  return [...tags].slice(0, 40);
}

/** Does a saved analysis (file name, summary, tags) match a search like "person with a red top" or "bag left behind"? */
export function matchesSearch(query: string, doc: { filename: string; summary?: string | null; tags?: string[] | null }): boolean {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w) && !["wearing", "carrying", "top", "shirt", "someone", "with"].includes(w));
  if (!words.length) return true;
  const hay = `${doc.filename} ${doc.summary ?? ""} ${(doc.tags ?? []).join(" ")}`.toLowerCase();
  return words.every((w) => {
    const syn = Object.entries(SYNONYMS).filter(([, ws]) => ws.includes(w)).flatMap(([label, ws]) => [label, ...ws]);
    return [w, ...syn].some((a) => hay.includes(a));
  });
}

/** Evidence report (Markdown) that can be downloaded and shared. */
export function buildReport(inv: Investigation, extra: { generatedAt: string; qa?: { q: string; a: string }[] }): string {
  const md: string[] = [];
  md.push(`# Sentinel Vision evidence report`, "", `**Source:** ${inv.source === "live" ? "live camera session" : inv.name}  `, `**Generated:** ${extra.generatedAt}  `);
  if (inv.source === "clip") md.push(`**Video length:** ${inv.duration.toFixed(1)}s · **Frames analysed:** ${inv.framesProcessed}  `);
  md.push("", "> Automatic analysis by an object detector and tracker on sampled frames. Every finding is an estimate to be reviewed, not proof of what happened.", "");
  md.push("## Summary", "", summarize(inv), "");
  md.push("## Timeline", "");
  if (!inv.timeline.length) md.push("No events.");
  for (const i of inv.timeline) md.push(`- **${mmss(i.t)}** · ${i.title}${i.trackId !== undefined ? ` · track #${i.trackId}` : ""} — ${i.detail}${i.reason && i.severity !== "info" ? ` _Evidence: ${i.reason}_` : ""}`);
  md.push("", "## Tracked objects", "", "| Track | Class | Colour | In view | Activity | Direction | Avg. confidence |", "|---|---|---|---|---|---|---|");
  for (const p of inv.profiles) md.push(`| #${p.id} | ${p.label} | ${p.color ?? "—"} | ${mmss(p.first)}–${mmss(p.last)} | ${p.activity} | ${[p.direction, p.approach].filter(Boolean).join(", ") || "—"} | ${(p.avgConfidence * 100).toFixed(0)}% |`);
  if (inv.zoneLines.length) md.push("", "## Zones and lines", "", ...inv.zoneLines.map((l) => `- ${l}`));
  if (extra.qa?.length) md.push("", "## Questions asked", "", ...extra.qa.flatMap((x) => [`**Q:** ${x.q}`, "", x.a, ""]));
  if (inv.runConfig) md.push("", "## Reproducibility", "", ...Object.entries(inv.runConfig).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `- ${k}: ${v}`));
  return md.join("\n") + "\n";
}
