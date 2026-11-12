// Run: node --experimental-strip-types --test tests/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  BehaviourMonitor, DEFAULT_BEHAVIOUR, answerLocally, buildContext, buildReport, buildTags, buildTimeline, guessScene,
  investigateClip, labelsIn, matchesSearch, mmss, nameTrack, normalizeBehaviour, searchTimeline, summarize,
} from "../lib/intelligence.ts";

const W = 640, H = 480, FPS = 10;
// a standing person 40 px wide and 120 px tall whose box centre is at (x, y)
const person = (id, x, y = 240, extra = {}) => ({ track_id: id, label: "person", confidence: 0.9, x1: x - 20, x2: x + 20, y1: y - 60, y2: y + 60, ...extra });
const thing = (id, label, x, y, size = 30) => ({ track_id: id, label, confidence: 0.8, x1: x - size / 2, x2: x + size / 2, y1: y - size / 2, y2: y + size / 2 });
const frame = (t, ...detections) => ({ t, width: W, height: H, detections });
const run = (frames, settings) => {
  const m = new BehaviourMonitor(settings);
  const events = frames.flatMap((f) => m.update(f));
  return { m, events, kinds: events.map((e) => e.kind) };
};
const seq = (seconds, fn) => Array.from({ length: Math.round(seconds * FPS) }, (_, i) => fn(i / FPS, i));

test("a walking person gets an appearance, a direction, an activity and a leave event", () => {
  const frames = [...seq(4, (t) => frame(t, person(1, 60 + 120 * t, 240, { color: "red" }))), ...seq(3, (t) => frame(4 + t))];
  const { m, events } = run(frames);
  const appear = events.find((e) => e.kind === "appear");
  assert.equal(appear.t, 0);
  assert.match(appear.message, /Person #1 \(red top\) appeared on the left side/);
  const leave = events.find((e) => e.kind === "leave");
  assert.ok(leave && Math.abs(leave.t - 3.9) < 1e-9);
  const [p] = m.profiles();
  assert.equal(p.direction, "left to right");
  assert.equal(p.activity, "walking");
  assert.equal(p.color, "red");
  assert.equal(p.endRegion, "the right side");
  assert.ok(!events.some((e) => e.kind === "running"));
});

test("running is flagged once, and an ID switch jump is not mistaken for running", () => {
  const runner = seq(3, (t) => frame(t, person(1, 40 + 300 * t)));
  const r = run(runner);
  assert.equal(r.kinds.filter((k) => k === "running").length, 1);
  assert.match(r.events.find((e) => e.kind === "running").reason, /body lengths per second/);
  // standing still, then the tracker hands ID 1 to someone far away
  const jump = [...seq(2, (t) => frame(t, person(1, 100))), ...seq(2, (t) => frame(2 + t, person(1, 560)))];
  assert.ok(!run(jump).kinds.includes("running"));
  assert.ok(!run(runner, { ...DEFAULT_BEHAVIOUR, running: false }).kinds.includes("running"), "can be switched off");
});

test("a standing person whose box becomes wide and low is a possible fall; sitting at the frame edge is not", () => {
  const lying = (id, x) => ({ track_id: id, label: "person", confidence: 0.9, x1: x - 60, x2: x + 60, y1: 380, y2: 420 });
  const frames = [...seq(2, (t) => frame(t, person(1, 300))), ...seq(2, (t) => frame(2 + t, lying(1, 300)))];
  const { events } = run(frames);
  const fall = events.filter((e) => e.kind === "possible_fall");
  assert.equal(fall.length, 1);
  assert.equal(fall[0].severity, "critical");
  // a webcam user: box cut off by the bottom of the frame is never judged by its shape
  const webcam = (t) => frame(t, { track_id: 1, label: "person", confidence: 0.9, x1: 100, x2: 540, y1: 200, y2: 480 });
  assert.ok(!run(seq(4, webcam)).kinds.includes("possible_fall"));
});

test("a bag put down by a person who then walks away is possibly left behind", () => {
  const frames = [
    ...seq(2, (t) => frame(t, person(1, 300), thing(2, "backpack", 310, 280))), // carried/next to the person
    ...seq(2, (t) => frame(2 + t, person(1, 300 + 150 * t), thing(2, "backpack", 310, 280))), // person walks off
    ...seq(10, (t) => frame(4 + t, thing(2, "backpack", 310, 280))), // bag alone
  ];
  const { events } = run(frames);
  const left = events.filter((e) => e.kind === "left_behind");
  assert.equal(left.length, 1);
  assert.equal(left[0].trackId, 2);
  assert.ok(left[0].t >= 8 && left[0].t <= 12.5, `alert at ${left[0].t}`);
  assert.match(left[0].reason, /nobody has been near it/);
  // the same bag that nobody ever went near is just part of the scene
  assert.ok(!run(seq(14, (t) => frame(t, thing(2, "backpack", 310, 280)))).kinds.includes("left_behind"));
  // a chair is not something people carry in and leave
  const chair = frames.map((f) => ({ ...f, detections: f.detections.map((d) => (d.label === "backpack" ? { ...d, label: "chair" } : d)) }));
  assert.ok(!run(chair).kinds.includes("left_behind"));
});

test("an object that sat still and then vanished is possibly removed, unless it is re-detected in place", () => {
  const base = seq(10, (t) => frame(t, thing(5, "laptop", 320, 300, 60)));
  const gone = [...base, ...seq(5, (t) => frame(10 + t, person(9, 100)))];
  const r = run(gone);
  const removed = r.events.filter((e) => e.kind === "removed");
  assert.equal(removed.length, 1);
  assert.equal(removed[0].t, 9.9);
  const redetected = [...base, ...seq(5, (t) => frame(10 + t, ...(t >= 1.5 ? [thing(6, "laptop", 322, 301, 60)] : [])))];
  assert.ok(!run(redetected).kinds.includes("removed"));
  const leftViaEdge = [...seq(10, (t) => frame(t, thing(5, "laptop", 10, 300, 60))), ...seq(5, (t) => frame(10 + t))];
  assert.ok(!run(leftViaEdge).kinds.includes("removed"), "objects at the frame edge just left the view");
});

test("a sudden rise in people is a crowd change; the peak is remembered", () => {
  const few = seq(5, (t) => frame(t, person(1, 100)));
  const many = seq(2, (t) => frame(5 + t, ...[1, 2, 3, 4, 5, 6].map((i) => person(i, 60 + i * 80))));
  const { m, events } = run([...few, ...many]);
  const crowd = events.filter((e) => e.kind === "crowd_change");
  assert.equal(crowd.length, 1);
  assert.match(crowd[0].message, /rose quickly to 6/);
  assert.deepEqual(m.peakPeople(), { t: 5, count: 6 });
});

test("the timeline keeps every warning and thins out routine items", () => {
  const ev = (i, severity) => ({ id: `e${i}`, t: i, kind: severity === "info" ? "appear" : "running", severity, message: `m${i}`, reason: "r" });
  const behaviour = Array.from({ length: 100 }, (_, i) => ev(i, i % 25 === 0 ? "warning" : "info"));
  const tl = buildTimeline(behaviour, [], 20);
  assert.equal(tl.length, 20);
  assert.equal(tl.filter((i) => i.severity === "warning").length, 4);
  assert.ok(tl.every((x, k) => k === 0 || tl[k - 1].t <= x.t), "sorted by time");
  const zone = [{ id: "z", t: 3.5, kind: "enter", severity: "info", message: "Person #1 entered “Door”." }];
  assert.equal(buildTimeline([], zone)[0].title, "Entered zone");
});

function sampleInvestigation() {
  const frames = [
    ...seq(2, (t) => frame(t, person(1, 300, 240, { color: "red" }), thing(2, "backpack", 310, 280))),
    ...seq(2, (t) => frame(2 + t, person(1, 300 + 150 * t, 240, { color: "red" }), thing(2, "backpack", 310, 280), person(3, 100 + 20 * t, 240, { color: "blue" }))),
    ...seq(10, (t) => frame(4 + t, thing(2, "backpack", 310, 280), thing(4, "couch", 500, 400, 120))),
  ];
  return investigateClip(frames, { name: "lobby <script>.mp4", duration: 14, framesProcessed: frames.length, runConfig: { model: "yolo11n.pt", confidence_threshold: 0.35 } });
}

test("investigateClip counts unique objects, guesses the scene and summarizes", () => {
  const inv = sampleInvestigation();
  assert.deepEqual(inv.uniqueByLabel, { person: 2, backpack: 1, couch: 1 });
  assert.equal(inv.peakPeople.count, 2);
  assert.equal(inv.scene.name, "a living room or home");
  const s = summarize(inv);
  assert.match(s, /14-second clip shows 2 people, 1 backpack, 1 couch/);
  assert.match(s, /Needs a look: .*may have been left behind/);
  assert.ok(inv.timeline.some((i) => i.kind === "peak"));
});

test("the built-in analyst answers common questions from the event data", () => {
  const inv = sampleInvestigation();
  assert.match(answerLocally("How many people were there?", inv).answer, /^2 people/);
  const left = answerLocally("Did anyone leave an object behind?", inv);
  assert.match(left.answer, /Backpack #2/);
  assert.ok(left.times.length === 1);
  assert.match(answerLocally("When did the person wearing a red shirt appear?", inv).answer, /Person #1 \(red top\) first appeared at 00:00/);
  assert.match(answerLocally("anyone in green?", inv).answer, /no person whose main colour was green/);
  const range = answerLocally("Describe the events between 00:02 and 00:04", inv).answer;
  assert.match(range, /Between 00:02 and 00:04/);
  assert.match(range, /Person #3/);
  assert.match(answerLocally("What happened in this video?", inv).answer, /Key moments/);
  assert.match(answerLocally("Did anyone fall?", inv).answer, /No possible falls/);
  assert.match(answerLocally("How many people entered the room?", inv).answer, /No zone is set up.*2 people appeared/);
  assert.match(answerLocally("xyzzy plugh", inv).answer, /could not find that/);
});

test("context for the LLM is compact, cites times and cannot smuggle markup through the file name", () => {
  const ctx = buildContext(sampleInvestigation());
  assert.ok(!ctx.includes("<script>"));
  assert.match(ctx, /^SOURCE: uploaded clip "lobby  script \.mp4"/);
  assert.match(ctx, /#1 person, red top, 00:00-00:03/);
  assert.match(ctx, /\[warning\] Backpack #2 may have been left behind\. Evidence: /);
  assert.match(ctx, /SETTINGS: model=yolo11n.pt, confidence_threshold=0.35/);
  assert.ok(buildContext(sampleInvestigation(), 300).length <= 300);
});

test("search understands synonyms; saved analyses are searchable by tags", () => {
  const inv = sampleInvestigation();
  const hits = searchTimeline(inv.timeline, "bag left behind");
  assert.equal(hits[0].kind, "left_behind");
  const tags = buildTags(inv);
  assert.ok(tags.includes("red person") && tags.includes("left behind") && tags.includes("backpack"));
  const doc = { filename: "lobby.mp4", summary: summarize(inv), tags };
  assert.ok(matchesSearch("person wearing red", doc));
  assert.ok(matchesSearch("bag left behind", doc));
  assert.ok(!matchesSearch("car", doc));
  assert.deepEqual(labelsIn("how many bags and people", ["person", "backpack"]).sort(), ["backpack", "handbag", "person", "suitcase"]);
});

test("report, names, time format and settings validation", () => {
  const md = buildReport(sampleInvestigation(), { generatedAt: "2026-11-12", qa: [{ q: "Q?", a: "A." }] });
  for (const h of ["## Summary", "## Timeline", "## Tracked objects", "## Questions asked", "## Reproducibility"]) assert.ok(md.includes(h), h);
  assert.equal(mmss(75.9), "01:15");
  assert.equal(nameTrack("backpack", 7, "black"), "Backpack #7 (black)");
  assert.deepEqual(normalizeBehaviour({ running: false, leftBehindSeconds: 9999 }), { ...DEFAULT_BEHAVIOUR, running: false, leftBehindSeconds: 600 });
  assert.deepEqual(normalizeBehaviour("junk"), DEFAULT_BEHAVIOUR);
  assert.equal(guessScene({ car: 2, person: 1 }).name, "a street, road or parking area");
  assert.equal(guessScene({}), null);
});
