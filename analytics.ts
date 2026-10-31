/**
 * Video-intelligence analytics: zones, counting lines, dwell time, trajectories, heatmaps and alert rules.
 *
 * Pure TypeScript with no React or browser dependencies, so it is unit-tested in isolation and used the
 * same way for live frames (incrementally) and for saved analyses (in one batch).
 *
 * Geometry is stored normalized (0..1 of the frame) so a zone drawn on the live camera also applies to a
 * saved clip of a different resolution.
 */

export type Pt = { x: number; y: number };
export type Zone = { id: string; name: string; color: string; points: Pt[] };
export type CountLine = { id: string; name: string; color: string; a: Pt; b: Pt };

/** One detection in frame pixels (as returned by the API). */
export type Det = {
  track_id: number | null;
  label: string;
  confidence: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

/** All detections of one frame. `t` is seconds (video time for clips, wall-clock seconds for live). */
export type FrameData = { t: number; width: number; height: number; detections: Det[] };

export type RuleKind = "occupancy" | "loiter" | "crossing";
export type Rule = {
  id: string;
  kind: RuleKind;
  name: string;
  /** zone id (occupancy, loiter) or line id (crossing) */
  target: string;
  /** class label, or "any" */
  label: string;
  /** objects (occupancy) or seconds (loiter); ignored for crossing */
  threshold: number;
  enabled: boolean;
};

export type EventKind = "enter" | "exit" | "cross" | "alert";
export type AnalyticsEvent = {
  id: string;
  t: number;
  kind: EventKind;
  message: string;
  severity: "info" | "warning" | "critical";
  ruleId?: string;
  trackId?: number;
};

export type TrackPath = {
  id: number;
  label: string;
  points: { t: number; x: number; y: number }[];
  /** seconds since this track was last seen, relative to the newest frame */
  age: number;
};

export type ZoneCount = { total: number; byLabel: Record<string, number> };
export type Snapshot = {
  t: number;
  activeTracks: number;
  zoneCounts: Record<string, ZoneCount>;
  lineCounts: Record<string, { forward: number; backward: number }>;
  paths: TrackPath[];
};

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The point used to decide whether an object is inside a zone or crossed a line, normalized.
 * Normally the bottom-centre of its box (where it touches the ground). If the box is cut off by the bottom
 * edge of the frame (a person at a laptop webcam, an object close to the camera), the real contact point is
 * outside the picture, so the centre of the box is used instead.
 */
export function footPoint(d: Det, width: number, height: number): Pt {
  const cutOff = d.y2 >= height * 0.985;
  const y = cutOff ? (d.y1 + d.y2) / 2 : d.y2;
  return { x: clamp01((d.x1 + d.x2) / 2 / width), y: clamp01(y / height) };
}

/** Centre of the box, normalized. Used for heatmaps and trajectories. */
export function centerPoint(d: Det, width: number, height: number): Pt {
  return { x: clamp01((d.x1 + d.x2) / 2 / width), y: clamp01((d.y1 + d.y2) / 2 / height) };
}

/** Ray casting. Points exactly on an edge may count as inside or outside. */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const crosses = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Which side of the directed line a→b the point is on: >0 left, <0 right, 0 on the line. */
export function side(a: Pt, b: Pt, p: Pt): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

function segmentsIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = side(p3, p4, p1);
  const d2 = side(p3, p4, p2);
  const d3 = side(p1, p2, p3);
  const d4 = side(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Did the movement prev→cur cross the counting line (a finite segment)?
 * "forward" = moved from the right of a→b to its left; "backward" = the opposite.
 */
export function crossedLine(prev: Pt, cur: Pt, line: { a: Pt; b: Pt }): "forward" | "backward" | null {
  if (!segmentsIntersect(prev, cur, line.a, line.b)) return null;
  return side(line.a, line.b, prev) < 0 ? "forward" : "backward";
}

// ---------------------------------------------------------------------------------------------
// Live / batch engine
// ---------------------------------------------------------------------------------------------

type ZoneVisit = { inside: boolean; dwell: number; entered: number; loiterAlerted: boolean };
type TrackState = {
  id: number;
  label: string;
  labelVotes: Record<string, number>;
  first: number;
  last: number;
  lastFoot: Pt;
  path: { t: number; x: number; y: number }[];
  visits: Record<string, ZoneVisit>;
};

export type ZoneSummary = {
  zoneId: string;
  uniqueTracks: number;
  byLabel: Record<string, number>;
  maxConcurrent: number;
  totalDwell: number;
  avgDwell: number;
};
export type LineSummary = { lineId: string; forward: number; backward: number; byLabel: Record<string, { forward: number; backward: number }> };

export type EngineOptions = {
  /** Trail length per track. */
  maxPath?: number;
  /** A track not seen for this long is considered gone (seconds). */
  staleSeconds?: number;
  /** Largest time step credited as dwell between two frames (seconds). */
  maxGap?: number;
};

let eventCounter = 0;
const nextId = (prefix: string) => `${prefix}-${++eventCounter}`;

export class AnalyticsEngine {
  zones: Zone[];
  lines: CountLine[];
  private opts: Required<EngineOptions>;
  private tracks = new Map<number, TrackState>();
  private zoneUnique: Record<string, Set<number>> = {};
  private zoneUniqueByLabel: Record<string, Record<string, Set<number>>> = {};
  private zoneMax: Record<string, number> = {};
  private zoneDwell: Record<string, number> = {};
  private lineStats: Record<string, LineSummary> = {};
  private occupancyActive: Record<string, boolean> = {};
  private lastT: number | null = null;

  constructor(zones: Zone[] = [], lines: CountLine[] = [], options: EngineOptions = {}) {
    this.zones = zones;
    this.lines = lines;
    this.opts = { maxPath: options.maxPath ?? 80, staleSeconds: options.staleSeconds ?? 8, maxGap: options.maxGap ?? 10 };
  }

  /** Replace zones and lines (user edited them). Per-zone state is reset; tracks and trails are kept. */
  setGeometry(zones: Zone[], lines: CountLine[]) {
    this.zones = zones;
    this.lines = lines;
    this.zoneUnique = {};
    this.zoneUniqueByLabel = {};
    this.zoneMax = {};
    this.zoneDwell = {};
    this.lineStats = {};
    this.occupancyActive = {};
    for (const t of this.tracks.values()) t.visits = {};
  }

  reset() {
    this.tracks.clear();
    this.setGeometry(this.zones, this.lines);
    this.lastT = null;
  }

  update(frame: FrameData, rules: Rule[] = []): { events: AnalyticsEvent[]; snapshot: Snapshot } {
    const events: AnalyticsEvent[] = [];
    const { t, width, height } = frame;
    const dt = this.lastT === null ? 0 : Math.max(0, Math.min(t - this.lastT, this.opts.maxGap));
    this.lastT = t;

    const zoneCounts: Record<string, ZoneCount> = {};
    for (const z of this.zones) zoneCounts[z.id] = { total: 0, byLabel: {} };

    const seen = new Set<number>();
    for (const d of frame.detections) {
      const foot = footPoint(d, width, height);
      const center = centerPoint(d, width, height);

      // zone occupancy counts every detection, tracked or not
      for (const z of this.zones) {
        if (pointInPolygon(foot, z.points)) {
          const c = zoneCounts[z.id];
          c.total += 1;
          c.byLabel[d.label] = (c.byLabel[d.label] || 0) + 1;
        }
      }
      if (d.track_id === null) continue;

      const id = d.track_id;
      seen.add(id);
      let tr = this.tracks.get(id);
      if (!tr) {
        tr = { id, label: d.label, labelVotes: {}, first: t, last: t, lastFoot: foot, path: [], visits: {} };
        this.tracks.set(id, tr);
      }
      tr.labelVotes[d.label] = (tr.labelVotes[d.label] || 0) + 1;
      tr.label = Object.entries(tr.labelVotes).sort((a, b) => b[1] - a[1])[0][0];
      const prevFoot = tr.lastFoot;
      const hadPrev = tr.last !== t || tr.path.length > 0;

      // counting lines: did this track cross since its previous position?
      if (hadPrev) {
        for (const line of this.lines) {
          const dir = crossedLine(prevFoot, foot, line);
          if (!dir) continue;
          const s = (this.lineStats[line.id] ||= { lineId: line.id, forward: 0, backward: 0, byLabel: {} });
          s[dir] += 1;
          const bl = (s.byLabel[tr.label] ||= { forward: 0, backward: 0 });
          bl[dir] += 1;
          events.push({
            id: nextId("cross"), t, kind: "cross", severity: "info", trackId: id,
            message: `${cap(tr.label)} #${id} crossed “${line.name}” (${dir === "forward" ? "forward" : "backward"}).`,
          });
          for (const r of rules) {
            if (r.enabled && r.kind === "crossing" && r.target === line.id && matchLabel(r.label, tr.label)) {
              events.push({
                id: nextId("alert"), t, kind: "alert", severity: "warning", ruleId: r.id, trackId: id,
                message: `${r.name}: ${tr.label} #${id} crossed “${line.name}”.`,
              });
            }
          }
        }
      }

      // zone entry / exit / dwell per track
      for (const z of this.zones) {
        const inside = pointInPolygon(foot, z.points);
        const v = (tr.visits[z.id] ||= { inside: false, dwell: 0, entered: 0, loiterAlerted: false });
        if (inside && !v.inside) {
          v.inside = true;
          v.entered = t;
          v.loiterAlerted = false;
          (this.zoneUnique[z.id] ||= new Set()).add(id);
          ((this.zoneUniqueByLabel[z.id] ||= {})[tr.label] ||= new Set()).add(id);
          events.push({ id: nextId("enter"), t, kind: "enter", severity: "info", trackId: id, message: `${cap(tr.label)} #${id} entered “${z.name}”.` });
        } else if (!inside && v.inside) {
          v.inside = false;
          events.push({ id: nextId("exit"), t, kind: "exit", severity: "info", trackId: id, message: `${cap(tr.label)} #${id} left “${z.name}” after ${v.dwell.toFixed(1)}s.` });
        }
        if (inside) {
          v.dwell += dt;
          this.zoneDwell[z.id] = (this.zoneDwell[z.id] || 0) + dt;
          for (const r of rules) {
            if (r.enabled && r.kind === "loiter" && r.target === z.id && matchLabel(r.label, tr.label) && !v.loiterAlerted && v.dwell >= r.threshold) {
              v.loiterAlerted = true;
              events.push({
                id: nextId("alert"), t, kind: "alert", severity: "critical", ruleId: r.id, trackId: id,
                message: `${r.name}: ${tr.label} #${id} has stayed in “${z.name}” for ${v.dwell.toFixed(0)}s.`,
              });
            }
          }
        }
      }

      tr.lastFoot = foot;
      tr.last = t;
      tr.path.push({ t, x: center.x, y: center.y });
      if (tr.path.length > this.opts.maxPath) tr.path.shift();
    }

    // tracks that disappeared while inside a zone: close their visit
    for (const tr of this.tracks.values()) {
      if (seen.has(tr.id)) continue;
      if (t - tr.last > this.opts.staleSeconds) {
        for (const z of this.zones) {
          const v = tr.visits[z.id];
          if (v?.inside) {
            v.inside = false;
            events.push({ id: nextId("exit"), t, kind: "exit", severity: "info", trackId: tr.id, message: `${cap(tr.label)} #${tr.id} left “${z.name}” (lost) after ${v.dwell.toFixed(1)}s.` });
          }
        }
      }
    }

    // occupancy rules are edge-triggered: one alert when the threshold is reached, re-armed when it drops
    for (const r of rules) {
      if (!r.enabled || r.kind !== "occupancy") continue;
      const zc = zoneCounts[r.target];
      if (!zc) continue;
      const n = r.label === "any" ? zc.total : zc.byLabel[r.label] || 0;
      const active = n >= r.threshold;
      if (active && !this.occupancyActive[r.id]) {
        events.push({
          id: nextId("alert"), t, kind: "alert", severity: "warning", ruleId: r.id,
          message: `${r.name}: ${n} ${r.label === "any" ? "object(s)" : r.label} in “${this.zones.find((z) => z.id === r.target)?.name ?? "zone"}” (limit ${r.threshold}).`,
        });
      }
      this.occupancyActive[r.id] = active;
    }

    for (const z of this.zones) {
      this.zoneMax[z.id] = Math.max(this.zoneMax[z.id] || 0, zoneCounts[z.id].total);
    }

    // drop long-gone tracks so memory stays flat in a long live session
    for (const [id, tr] of this.tracks) {
      if (t - tr.last > this.opts.staleSeconds * 6) this.tracks.delete(id);
    }

    const lineCounts: Record<string, { forward: number; backward: number }> = {};
    for (const l of this.lines) {
      const s = this.lineStats[l.id];
      lineCounts[l.id] = { forward: s?.forward ?? 0, backward: s?.backward ?? 0 };
    }
    const paths: TrackPath[] = [];
    for (const tr of this.tracks.values()) {
      const age = t - tr.last;
      if (age <= this.opts.staleSeconds && tr.path.length > 1) paths.push({ id: tr.id, label: tr.label, points: tr.path.slice(), age });
    }
    return {
      events,
      snapshot: { t, activeTracks: [...this.tracks.values()].filter((x) => t - x.last <= this.opts.staleSeconds).length, zoneCounts, lineCounts, paths },
    };
  }

  zoneSummaries(): ZoneSummary[] {
    return this.zones.map((z) => {
      const unique = this.zoneUnique[z.id]?.size ?? 0;
      const byLabel: Record<string, number> = {};
      for (const [label, set] of Object.entries(this.zoneUniqueByLabel[z.id] || {})) byLabel[label] = set.size;
      const total = this.zoneDwell[z.id] || 0;
      return { zoneId: z.id, uniqueTracks: unique, byLabel, maxConcurrent: this.zoneMax[z.id] || 0, totalDwell: total, avgDwell: unique ? total / unique : 0 };
    });
  }

  lineSummaries(): LineSummary[] {
    return this.lines.map((l) => this.lineStats[l.id] ?? { lineId: l.id, forward: 0, backward: 0, byLabel: {} });
  }
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
function matchLabel(ruleLabel: string, label: string) {
  return ruleLabel === "any" || ruleLabel === label;
}

// ---------------------------------------------------------------------------------------------
// Saved analyses (batch)
// ---------------------------------------------------------------------------------------------

/** A saved detection row as the page keeps it. */
export type SavedDetection = {
  frame: number;
  timestamp_seconds: number;
  label: string;
  confidence: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  track_id: number | null;
};

/** Saved analyses do not store the video size, so estimate it from the largest box edge. */
export function estimateFrameSize(rows: { x2: number; y2: number }[]): { width: number; height: number } {
  let w = 0;
  let h = 0;
  for (const r of rows) {
    if (r.x2 > w) w = r.x2;
    if (r.y2 > h) h = r.y2;
  }
  return { width: Math.max(1, Math.ceil(w)), height: Math.max(1, Math.ceil(h)) };
}

/** Group saved detection rows into frames ordered by time. */
export function framesFromSaved(rows: SavedDetection[], size = estimateFrameSize(rows)): FrameData[] {
  const byFrame = new Map<number, FrameData>();
  for (const r of rows) {
    let f = byFrame.get(r.frame);
    if (!f) {
      f = { t: r.timestamp_seconds, width: size.width, height: size.height, detections: [] };
      byFrame.set(r.frame, f);
    }
    f.detections.push({ track_id: r.track_id, label: r.label, confidence: r.confidence, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
  }
  return [...byFrame.entries()].sort((a, b) => a[0] - b[0]).map(([, f]) => f);
}

export type BatchResult = {
  zones: ZoneSummary[];
  lines: LineSummary[];
  events: AnalyticsEvent[];
};

/** Run the engine over a whole clip. */
export function analyzeBatch(frames: FrameData[], zones: Zone[], lines: CountLine[], rules: Rule[] = []): BatchResult {
  const engine = new AnalyticsEngine(zones, lines, { maxPath: 1, staleSeconds: 2, maxGap: 2 });
  const events: AnalyticsEvent[] = [];
  for (const f of frames) events.push(...engine.update(f, rules).events);
  return { zones: engine.zoneSummaries(), lines: engine.lineSummaries(), events };
}

export type FullTrack = { id: number; label: string; points: { t: number; x: number; y: number }[] };

/** Complete trajectory of every tracked object in a clip (centre of the box, normalized). */
export function buildTracks(frames: FrameData[], label?: string): FullTrack[] {
  const map = new Map<number, FullTrack & { votes: Record<string, number> }>();
  for (const f of frames) {
    for (const d of f.detections) {
      if (d.track_id === null) continue;
      if (label && label !== "all" && d.label !== label) continue;
      let tr = map.get(d.track_id);
      if (!tr) {
        tr = { id: d.track_id, label: d.label, points: [], votes: {} };
        map.set(d.track_id, tr);
      }
      tr.votes[d.label] = (tr.votes[d.label] || 0) + 1;
      const c = centerPoint(d, f.width, f.height);
      tr.points.push({ t: f.t, x: c.x, y: c.y });
    }
  }
  return [...map.values()].map(({ votes, ...tr }) => ({ ...tr, label: Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0] }));
}

// ---------------------------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------------------------

export type Heatmap = { cols: number; rows: number; cells: number[]; max: number; samples: number };

export class HeatAccumulator {
  readonly cols: number;
  readonly rows: number;
  private cells: Float32Array;
  private samples = 0;
  constructor(cols = 48, rows = 36) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Float32Array(cols * rows);
  }
  clear() {
    this.cells.fill(0);
    this.samples = 0;
  }
  /** Splat a soft blob at a normalized point. */
  add(p: Pt, weight = 1) {
    const cx = p.x * (this.cols - 1);
    const cy = p.y * (this.rows - 1);
    const radius = 2;
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(this.rows - 1, Math.ceil(cy + radius)); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(this.cols - 1, Math.ceil(cx + radius)); x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        this.cells[y * this.cols + x] += weight * Math.exp(-d2 / 2.2);
      }
    }
    this.samples += 1;
  }
  addFrame(frame: FrameData, label?: string) {
    for (const d of frame.detections) {
      if (label && label !== "all" && d.label !== label) continue;
      this.add(centerPoint(d, frame.width, frame.height));
    }
  }
  toHeatmap(): Heatmap {
    let max = 0;
    for (const v of this.cells) if (v > max) max = v;
    return { cols: this.cols, rows: this.rows, cells: Array.from(this.cells), max, samples: this.samples };
  }
}

export function buildHeatmap(frames: FrameData[], label?: string, cols = 48, rows = 36): Heatmap {
  const acc = new HeatAccumulator(cols, rows);
  for (const f of frames) acc.addFrame(f, label);
  return acc.toHeatmap();
}

// ---------------------------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------------------------

const PALETTE = ["#6ce3d0", "#b6f36b", "#ffd37a", "#ff9aa8", "#8fb4ff", "#d3a4ff", "#ffb27a", "#7ae0ff"];

/** Stable colour per class name. */
export function colorForLabel(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Heat colour ramp (transparent → teal → green → yellow → red) as rgba. */
export function heatColor(v: number): string {
  const x = Math.min(1, Math.max(0, v));
  if (x < 0.02) return "rgba(0,0,0,0)";
  const stops = [
    [0.0, [20, 60, 120, 0.0]],
    [0.25, [30, 160, 190, 0.45]],
    [0.5, [140, 230, 110, 0.6]],
    [0.75, [255, 211, 122, 0.72]],
    [1.0, [255, 98, 110, 0.85]],
  ] as const;
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [x0, c0] = stops[i - 1];
      const [x1, c1] = stops[i];
      const k = (x - x0) / (x1 - x0);
      const m = (j: number) => Math.round(c0[j] + (c1[j] - c0[j]) * k);
      const a = c0[3] + (c1[3] - c0[3]) * k;
      return `rgba(${m(0)},${m(1)},${m(2)},${a.toFixed(2)})`;
    }
  }
  return "rgba(255,98,110,0.85)";
}
