// Acceptance scenarios written independently of the built-in tests (13 Nov 2026).
// Frames at 10 per second, as the API produces at FRAME_STRIDE=3 on 30 fps video. Frame 1280×720.
import test from "node:test";
import assert from "node:assert/strict";
import { BehaviourMonitor, answerLocally, buildTags, investigateClip, matchesSearch, summarize } from "../lib/intelligence.ts";
import { analyzeBatch, buildHeatmap, buildTracks } from "../lib/analytics.ts";

const W = 1280, H = 720, FPS = 10;
const P = (id, cx, cy = 420, w = 90, h = 260, extra = {}) => ({ track_id: id, label: "person", confidence: 0.85, x1: cx - w / 2, x2: cx + w / 2, y1: cy - h / 2, y2: cy + h / 2, ...extra });
const O = (id, label, cx, cy, s = 60) => ({ track_id: id, label, confidence: 0.7, x1: cx - s / 2, x2: cx + s / 2, y1: cy - s / 2, y2: cy + s / 2 });
const F = (t, ...detections) => ({ t: Math.round(t * 100) / 100, width: W, height: H, detections });
const seq = (from, to, fn) => Array.from({ length: Math.round((to - from) * FPS) }, (_, i) => fn(from + i / FPS));
const kinds = (frames) => { const m = new BehaviourMonitor(); return frames.flatMap((f) => m.update(f)).map((e) => e.kind); };
const clip = (frames, name = "test.mp4") => investigateClip(frames, { name, duration: frames.at(-1).t, framesProcessed: frames.length });

test("A1 a real run (about 2.5 body heights per second) raises one running alert", () => {
  assert.equal(kinds(seq(0, 3, (t) => F(t, P(1, 60 + 650 * t)))).filter((k) => k === "running").length, 1);
});
test("A2 a normal walk (about 0.6 body heights per second) raises none", () => {
  assert.ok(!kinds(seq(0, 8, (t) => F(t, P(1, 100 + 150 * t)))).includes("running"));
});
test("A3 a person falling (tall box turns wide and low in 1 s) raises a possible fall", () => {
  const frames = [...seq(0, 3, (t) => F(t, P(1, 600))), ...seq(3, 6, (t) => F(t, P(1, 600, 560, 260, 90)))];
  assert.ok(kinds(frames).includes("possible_fall"));
});
test("A4 sitting down (box only gets shorter, not wider) is not called a fall", () => {
  const frames = [...seq(0, 3, (t) => F(t, P(1, 600))), ...seq(3, 8, (t) => F(t, P(1, 600, 470, 110, 160)))];
  assert.ok(!kinds(frames).includes("possible_fall"));
});
test("A5 a bag dropped and walked away from is flagged as left behind", () => {
  const frames = [...seq(0, 3, (t) => F(t, P(1, 500), O(2, "backpack", 520, 540))), ...seq(3, 6, (t) => F(t, P(1, 500 + 250 * (t - 3)), O(2, "backpack", 520, 540))), ...seq(6, 20, (t) => F(t, O(2, "backpack", 520, 540)))];
  assert.ok(kinds(frames).includes("left_behind"));
});
test("A6 a bag whose owner stands next to it the whole time is not flagged", () => {
  assert.ok(!kinds(seq(0, 20, (t) => F(t, P(1, 500), O(2, "backpack", 520, 540)))).includes("left_behind"));
});
test("A7 a bag that sat still and then vanished mid-frame is flagged as removed", () => {
  const frames = [...seq(0, 12, (t) => F(t, O(2, "handbag", 640, 400))), ...seq(12, 13, (t) => F(t, P(1, 640), O(2, "handbag", 640, 400))), ...seq(13, 18, (t) => F(t, P(1, 640 + 200 * (t - 13))))];
  assert.ok(kinds(frames).includes("removed"));
});
test("A8 a crowd forming quickly (1 to 6 people) raises a crowd change", () => {
  const frames = [...seq(0, 5, (t) => F(t, P(1, 200))), ...seq(5, 10, (t) => F(t, ...[1, 2, 3, 4, 5, 6].map((i) => P(i, 150 * i))))];
  assert.ok(kinds(frames).includes("crowd_change"));
});
test("A9 a one-frame tracker jump of about one body height does not count as running", () => {
  // ByteTrack sometimes hands an ID to the person standing next to it; that is a jump, not a run.
  const frames = [...seq(0, 5, (t) => F(t, P(1, 300))), ...seq(5, 10, (t) => F(t, P(1, 600)))];
  assert.ok(!kinds(frames).includes("running"), "a single jump was reported as running");
});
test("A10 Ask Sentinel answers counting, left-behind, time-range and colour questions", () => {
  const frames = [...seq(0, 3, (t) => F(t, P(1, 500, 420, 90, 260, { color: "red" }), O(2, "backpack", 520, 540))), ...seq(3, 6, (t) => F(t, P(1, 500 + 250 * (t - 3), 420, 90, 260, { color: "red" }), O(2, "backpack", 520, 540), P(3, 1100, 420, 90, 260, { color: "blue" }))), ...seq(6, 20, (t) => F(t, O(2, "backpack", 520, 540)))];
  const inv = clip(frames);
  assert.match(answerLocally("How many people were there?", inv).answer, /2/);
  const left = answerLocally("Did anyone leave an object behind?", inv);
  assert.match(left.answer, /^Yes/); assert.ok(left.times.length > 0);
  assert.match(answerLocally("Describe the events between 00:02 and 00:05", inv).answer, /Between 00:02 and 00:05/);
  assert.match(answerLocally("When did a person in red appear?", inv).answer, /red/i);
  assert.ok(summarize(inv).length > 40);
  assert.ok(matchesSearch("bag left behind", { filename: "x.mp4", summary: summarize(inv), tags: buildTags(inv) }));
});
test("A11 zones and lines: entries, peak occupancy, dwell and crossings in each direction", () => {
  const frames = [...seq(0, 10, (t) => F(t, P(1, 100 + 100 * t), P(2, 1180 - 100 * t)))];
  const zone = { id: "z", name: "Door", color: "#0f0", points: [{ x: 0.4, y: 0 }, { x: 0.6, y: 0 }, { x: 0.6, y: 1 }, { x: 0.4, y: 1 }] };
  const line = { id: "l", name: "Middle", color: "#f00", a: { x: 0.5, y: 0 }, b: { x: 0.5, y: 1 } };
  const r = analyzeBatch(frames, [zone], [line]);
  assert.equal(r.zones[0].byLabel.person, 2);
  assert.ok(r.zones[0].maxConcurrent >= 1 && r.zones[0].avgDwell > 1);
  assert.equal(r.lines[0].forward + r.lines[0].backward, 2);
  assert.equal(Math.min(r.lines[0].forward, r.lines[0].backward), 1);
  assert.equal(buildTracks(frames).length, 2);
  assert.ok(buildHeatmap(frames).cells?.length ?? Object.keys(buildHeatmap(frames)).length);
});
test("A12 an ID switch onto a person about one body length away (then walking on) is not called running", () => {
  const frames = seq(0, 10, (t) => F(t, P(1, t < 5 ? 900 : 594 - 20 * (t - 5), 420, 90, 250)));
  assert.ok(!kinds(frames).includes("running"));
});
test("A13 a lower frame rate (3 per second) still catches a real run", () => {
  const frames = Array.from({ length: 12 }, (_, i) => F(i / 3, P(1, 60 + 650 * (i / 3))));
  assert.ok(kinds(frames).includes("running"));
});
