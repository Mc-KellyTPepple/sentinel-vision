// Run: node --test tests/*.test.mjs   (Node 22+ runs the TypeScript engine directly)
import test from "node:test";
import assert from "node:assert/strict";
import {
  AnalyticsEngine, HeatAccumulator, analyzeBatch, buildHeatmap, buildTracks, centerPoint, colorForLabel,
  crossedLine, estimateFrameSize, footPoint, framesFromSaved, heatColor, pointInPolygon,
} from "../lib/analytics.ts";

// 100x100 frame; a "person" whose feet are at (x, y) in pixels
const det = (id, x, y, label = "person") => ({ track_id: id, label, confidence: 0.9, x1: x - 5, x2: x + 5, y1: y - 10, y2: y });
const frame = (t, ...detections) => ({ t, width: 100, height: 100, detections });
const SQUARE = { id: "z1", name: "Door", color: "#fff", points: [{ x: 0.4, y: 0.4 }, { x: 0.8, y: 0.4 }, { x: 0.8, y: 0.8 }, { x: 0.4, y: 0.8 }] };
const LINE = { id: "l1", name: "Gate", color: "#fff", a: { x: 0.5, y: 0 }, b: { x: 0.5, y: 1 } };

test("pointInPolygon: inside, outside, concave and degenerate", () => {
  assert.equal(pointInPolygon({ x: 0.6, y: 0.6 }, SQUARE.points), true);
  assert.equal(pointInPolygon({ x: 0.2, y: 0.6 }, SQUARE.points), false);
  const L = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 1 }, { x: 0, y: 1 }];
  assert.equal(pointInPolygon({ x: 0.1, y: 0.8 }, L), true);
  assert.equal(pointInPolygon({ x: 0.8, y: 0.8 }, L), false); // the notch of the L
  assert.equal(pointInPolygon({ x: 0.5, y: 0.5 }, [{ x: 0, y: 0 }, { x: 1, y: 1 }]), false);
});

test("crossedLine detects direction and ignores misses", () => {
  const left = { x: 0.3, y: 0.5 }, right = { x: 0.7, y: 0.5 };
  const a = crossedLine(left, right, LINE), b = crossedLine(right, left, LINE);
  assert.ok(a && b && a !== b, "opposite directions give different answers");
  assert.equal(crossedLine({ x: 0.1, y: 0.5 }, { x: 0.4, y: 0.5 }, LINE), null, "stops before the line");
  assert.equal(crossedLine({ x: 0.3, y: 1.4 }, { x: 0.7, y: 1.4 }, LINE), null, "passes beyond the end of the segment");
});

test("foot and centre points are normalized and clamped", () => {
  const d = det(1, 50, 90); // box ends well inside the frame: bottom-centre is the contact point
  assert.deepEqual(footPoint(d, 100, 100), { x: 0.5, y: 0.9 });
  assert.deepEqual(centerPoint(d, 100, 100), { x: 0.5, y: 0.85 });
  const atEdge = det(1, 50, 100); // box touches the bottom edge: contact point is out of frame, so its centre is used
  assert.deepEqual(footPoint(atEdge, 100, 100), { x: 0.5, y: 0.95 });
  assert.equal(footPoint({ ...d, y2: 500 }, 100, 100).y, 1);
});

test("an object cut off by the bottom edge is located by its centre, so a webcam torso counts as inside a mid-frame zone", () => {
  const torso = { track_id: 1, label: "person", confidence: 0.9, x1: 30, x2: 70, y1: 30, y2: 100 }; // box touches the bottom of a 100px frame
  assert.deepEqual(footPoint(torso, 100, 100), { x: 0.5, y: 0.65 });
  const e = new AnalyticsEngine([SQUARE], []);
  assert.equal(e.update(frame(0, torso)).snapshot.zoneCounts.z1.total, 1);
  const upright = { ...torso, y2: 90 }; // full-length object that ends inside the frame keeps the bottom-centre rule
  assert.deepEqual(footPoint(upright, 100, 100), { x: 0.5, y: 0.9 });
});

test("zone occupancy, entry/exit events and dwell time", () => {
  const e = new AnalyticsEngine([SQUARE], []);
  let r = e.update(frame(0, det(1, 20, 20), det(2, 60, 60, "dog")));
  assert.equal(r.snapshot.zoneCounts.z1.total, 1);
  assert.deepEqual(r.snapshot.zoneCounts.z1.byLabel, { dog: 1 });
  assert.ok(r.events.some((x) => x.kind === "enter" && /Dog #2/.test(x.message)));
  r = e.update(frame(2, det(1, 20, 20), det(2, 60, 60, "dog")));
  r = e.update(frame(5, det(1, 20, 20), det(2, 60, 60, "dog")));
  const s = e.zoneSummaries()[0];
  assert.equal(s.uniqueTracks, 1);
  assert.equal(s.maxConcurrent, 1);
  assert.equal(Math.round(s.totalDwell), 5);
  assert.equal(Math.round(s.avgDwell), 5);
  r = e.update(frame(6, det(2, 10, 10, "dog")));
  assert.ok(r.events.some((x) => x.kind === "exit" && /after 5\.0s/.test(x.message)));
});

test("a track that vanishes inside a zone is closed as lost after the stale window", () => {
  const e = new AnalyticsEngine([SQUARE], [], { staleSeconds: 3 });
  e.update(frame(0, det(1, 60, 60)));
  const r = e.update(frame(10));
  assert.ok(r.events.some((x) => x.kind === "exit" && /lost/.test(x.message)));
});

test("line crossings are counted per direction and per class", () => {
  const e = new AnalyticsEngine([], [LINE]);
  e.update(frame(0, det(1, 30, 50), det(2, 70, 50, "car")));
  const r = e.update(frame(1, det(1, 70, 50), det(2, 30, 50, "car")));
  const c = r.snapshot.lineCounts.l1;
  assert.equal(c.forward + c.backward, 2);
  assert.equal(c.forward, 1);
  assert.equal(c.backward, 1);
  const s = e.lineSummaries()[0];
  assert.equal(s.byLabel.person.forward + s.byLabel.person.backward, 1);
  assert.equal(s.byLabel.car.forward + s.byLabel.car.backward, 1);
  assert.equal(r.events.filter((x) => x.kind === "cross").length, 2);
});

test("no crossing is invented for a track seen for the first time beyond the line", () => {
  const e = new AnalyticsEngine([], [LINE]);
  const r = e.update(frame(0, det(1, 70, 50)));
  assert.equal(r.snapshot.lineCounts.l1.forward + r.snapshot.lineCounts.l1.backward, 0);
});

test("crossing rule raises an alert; disabled and wrong-class rules do not", () => {
  const rules = [
    { id: "r1", kind: "crossing", name: "Gate watch", target: "l1", label: "person", threshold: 0, enabled: true },
    { id: "r2", kind: "crossing", name: "Cars only", target: "l1", label: "car", threshold: 0, enabled: true },
    { id: "r3", kind: "crossing", name: "Off", target: "l1", label: "any", threshold: 0, enabled: false },
  ];
  const e = new AnalyticsEngine([], [LINE]);
  e.update(frame(0, det(1, 30, 50)), rules);
  const alerts = e.update(frame(1, det(1, 70, 50)), rules).events.filter((x) => x.kind === "alert");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].ruleId, "r1");
});

test("occupancy rule is edge-triggered and re-arms after the zone empties", () => {
  const rule = { id: "o1", kind: "occupancy", name: "Crowd", target: "z1", label: "any", threshold: 2, enabled: true };
  const e = new AnalyticsEngine([SQUARE], []);
  const alerts = (t, ...d) => e.update(frame(t, ...d), [rule]).events.filter((x) => x.kind === "alert").length;
  assert.equal(alerts(0, det(1, 50, 50)), 0);
  assert.equal(alerts(1, det(1, 50, 50), det(2, 60, 60)), 1);
  assert.equal(alerts(2, det(1, 50, 50), det(2, 60, 60)), 0, "still above the limit: no repeat");
  assert.equal(alerts(3, det(1, 50, 50)), 0);
  assert.equal(alerts(4, det(1, 50, 50), det(2, 60, 60)), 1, "re-armed");
});

test("loiter rule fires once per visit after the threshold", () => {
  const rule = { id: "l", kind: "loiter", name: "Loitering", target: "z1", label: "person", threshold: 4, enabled: true };
  const e = new AnalyticsEngine([SQUARE], []);
  const n = (t) => e.update(frame(t, det(1, 60, 60)), [rule]).events.filter((x) => x.kind === "alert").length;
  assert.deepEqual([n(0), n(2), n(3), n(5), n(6), n(9)], [0, 0, 0, 1, 0, 0]);
});

test("occupancy counts untracked detections too; dwell and crossings need a track", () => {
  const e = new AnalyticsEngine([SQUARE], [LINE]);
  e.update(frame(0, det(null, 30, 50)));
  const r = e.update(frame(1, det(null, 60, 60)));
  assert.equal(r.snapshot.zoneCounts.z1.total, 1);
  assert.equal(e.zoneSummaries()[0].uniqueTracks, 0);
  assert.equal(r.snapshot.lineCounts.l1.forward + r.snapshot.lineCounts.l1.backward, 0);
});

test("trails are returned for recent moving tracks and capped", () => {
  const e = new AnalyticsEngine([], [], { maxPath: 5 });
  let snap;
  for (let i = 0; i < 12; i++) snap = e.update(frame(i, det(7, 10 + i * 5, 50))).snapshot;
  assert.equal(snap.paths.length, 1);
  assert.equal(snap.paths[0].points.length, 5);
  assert.equal(snap.paths[0].id, 7);
  assert.equal(snap.activeTracks, 1);
});

test("setGeometry resets zone statistics but keeps tracking", () => {
  const e = new AnalyticsEngine([SQUARE], []);
  e.update(frame(0, det(1, 60, 60)));
  e.update(frame(3, det(1, 60, 60)));
  e.setGeometry([SQUARE], []);
  assert.equal(e.zoneSummaries()[0].uniqueTracks, 0);
  assert.equal(e.update(frame(4, det(1, 60, 60))).snapshot.paths.length, 1);
});

test("saved detections: size estimate, framing and batch analysis", () => {
  const rows = [
    { frame: 0, timestamp_seconds: 0, label: "person", confidence: 0.9, x1: 100, y1: 100, x2: 200, y2: 300, track_id: 1 },
    { frame: 0, timestamp_seconds: 0, label: "dog", confidence: 0.8, x1: 300, y1: 200, x2: 640, y2: 480, track_id: 2 },
    { frame: 3, timestamp_seconds: 0.1, label: "person", confidence: 0.9, x1: 400, y1: 100, x2: 500, y2: 300, track_id: 1 },
  ];
  assert.deepEqual(estimateFrameSize(rows), { width: 640, height: 480 });
  const frames = framesFromSaved(rows);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].detections.length, 2);
  assert.equal(frames[1].t, 0.1);
  const tracks = buildTracks(frames);
  assert.equal(tracks.find((t) => t.id === 1).points.length, 2);
  assert.equal(buildTracks(frames, "dog").length, 1);
  const line = { id: "v", name: "Mid", color: "#fff", a: { x: 0.5, y: 0 }, b: { x: 0.5, y: 1 } };
  const res = analyzeBatch(frames, [], [line]);
  assert.equal(res.lines[0].forward + res.lines[0].backward, 1, "person 1 moved from x=150 to x=450 across x=320");
});

test("heatmap peaks where objects are, respects the class filter, and starts empty", () => {
  const frames = [frame(0, det(1, 20, 20), det(2, 20, 20, "dog")), frame(1, det(1, 21, 21))];
  const hm = buildHeatmap(frames, "person", 20, 20);
  const peak = hm.cells.indexOf(hm.max);
  const px = peak % 20, py = Math.floor(peak / 20);
  assert.ok(px <= 6 && py <= 6, `peak at ${px},${py} should be near the top-left`);
  assert.equal(hm.samples, 2);
  assert.equal(buildHeatmap(frames, "cat").max, 0);
  const acc = new HeatAccumulator(10, 10);
  acc.add({ x: 0.5, y: 0.5 }); acc.clear();
  assert.equal(acc.toHeatmap().max, 0);
});

test("class colours are stable and the heat ramp is monotonic in alpha up to the hot end", () => {
  assert.equal(colorForLabel("person"), colorForLabel("person"));
  assert.match(colorForLabel("cat"), /^#[0-9a-f]{6}$/);
  assert.equal(heatColor(0), "rgba(0,0,0,0)");
  const alpha = (v) => Number(/,([\d.]+)\)$/.exec(heatColor(v))[1]);
  assert.ok(alpha(0.3) < alpha(0.6) && alpha(0.6) < alpha(1));
});
