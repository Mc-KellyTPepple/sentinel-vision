"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AnalyticsEngine, HeatAccumulator, type AnalyticsEvent, type CountLine, type FrameData, type Heatmap,
  type Pt, type Rule, type Snapshot, type Zone,
} from "./analytics";
import {
  BehaviourMonitor, DEFAULT_BEHAVIOUR, investigateLive, normalizeBehaviour, type BehaviourEvent, type BehaviourSettings, type Investigation,
} from "./intelligence";

export type StageMode = "view" | "zone" | "line";
export type Setup = { zones: Zone[]; lines: CountLine[]; rules: Rule[]; behaviour: BehaviourSettings };

const STORAGE_KEY = "sentinel-vision.setup.v1";
const EMPTY: Setup = { zones: [], lines: [], rules: [], behaviour: DEFAULT_BEHAVIOUR };
export const GEOMETRY_COLORS = ["#6ce3d0", "#b6f36b", "#ffd37a", "#ff9aa8", "#8fb4ff", "#d3a4ff"];

const uid = () => Math.random().toString(36).slice(2, 9);
const isPt = (p: unknown): p is Pt => !!p && typeof (p as Pt).x === "number" && typeof (p as Pt).y === "number";

function loadSetup(): Setup {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const p = JSON.parse(raw) as Partial<Setup>;
    return {
      zones: Array.isArray(p.zones) ? p.zones.filter((z) => z && Array.isArray(z.points) && z.points.every(isPt)) : [],
      lines: Array.isArray(p.lines) ? p.lines.filter((l) => l && isPt(l.a) && isPt(l.b)) : [],
      rules: Array.isArray(p.rules) ? p.rules : [],
      behaviour: normalizeBehaviour(p.behaviour),
    };
  } catch {
    return EMPTY;
  }
}

function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.14);
    osc.onended = () => void ctx.close();
  } catch {
    /* audio is optional */
  }
}

/** Zones, counting lines, rules and the live analytics they feed. Setup is remembered in this browser. */
export function useVideoAnalytics() {
  const [setup, setSetup] = useState<Setup>(EMPTY);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<StageMode>("view");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<AnalyticsEvent[]>([]);
  const [heat, setHeat] = useState<Heatmap | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 640, height: 480 });
  const [soundOn, setSoundOn] = useState(false);

  const engineRef = useRef<AnalyticsEngine | null>(null);
  const heatRef = useRef<HeatAccumulator | null>(null);
  const rulesRef = useRef<Rule[]>([]);
  const soundRef = useRef(false);
  const framesRef = useRef(0);
  const monitorRef = useRef<BehaviourMonitor | null>(null);
  const behaviourLogRef = useRef<BehaviourEvent[]>([]);
  const zoneLogRef = useRef<AnalyticsEvent[]>([]);
  const sessionStartRef = useRef<number | null>(null);
  const lastTRef = useRef(0);
  const dismissedRef = useRef<Set<string>>(new Set());
  const engine = () => (engineRef.current ||= new AnalyticsEngine());
  const monitor = () => (monitorRef.current ||= new BehaviourMonitor(DEFAULT_BEHAVIOUR, { leaveAfter: 4 }));
  const heatAcc = () => (heatRef.current ||= new HeatAccumulator());

  useEffect(() => {
    setSetup(loadSetup());
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(setup));
    } catch {
      /* private mode: setup just will not persist */
    }
  }, [setup, ready]);
  useEffect(() => {
    engine().setGeometry(setup.zones, setup.lines);
  }, [setup.zones, setup.lines]);
  useEffect(() => {
    rulesRef.current = setup.rules;
  }, [setup.rules]);
  useEffect(() => {
    soundRef.current = soundOn;
  }, [soundOn]);
  useEffect(() => {
    monitor().settings = setup.behaviour;
  }, [setup.behaviour]);

  const ingest = useCallback((frame: FrameData) => {
    const { events: zoneEv, snapshot: snap } = engine().update(frame, rulesRef.current);
    if (sessionStartRef.current === null) sessionStartRef.current = frame.t;
    lastTRef.current = frame.t;
    zoneLogRef.current = [...zoneLogRef.current, ...zoneEv].slice(-300);
    // behaviour alerts (running, possible falls, left-behind or removed objects, crowd changes); routine
    // appear/leave events go to the session log for questions, not to the alert feed
    const behaviour = monitor().update(frame);
    if (behaviour.length) behaviourLogRef.current = [...behaviourLogRef.current, ...behaviour].slice(-400);
    const alerts: AnalyticsEvent[] = behaviour
      .filter((b) => b.severity !== "info")
      .map((b) => ({ id: b.id, t: b.t, kind: "behaviour", severity: b.severity, message: b.message, reason: b.reason, trackId: b.trackId }));
    const ev = [...zoneEv, ...alerts];
    heatAcc().addFrame(frame);
    framesRef.current += 1;
    setSnapshot(snap);
    setFrameSize((prev) => (prev.width === frame.width && prev.height === frame.height ? prev : { width: frame.width, height: frame.height }));
    if (framesRef.current % 2 === 1) setHeat(heatAcc().toHeatmap());
    if (ev.length) {
      setEvents((old) => [...ev.slice().reverse(), ...old].slice(0, 80));
      if (soundRef.current && ev.some((e) => e.kind === "alert" || e.kind === "behaviour")) beep();
    }
  }, []);

  /** New camera session: clear statistics, keep the zones and rules. */
  const resetSession = useCallback(() => {
    engine().reset();
    heatAcc().clear();
    framesRef.current = 0;
    monitor().reset();
    behaviourLogRef.current = [];
    zoneLogRef.current = [];
    sessionStartRef.current = null;
    setSnapshot(null);
    setEvents([]);
    setHeat(null);
  }, []);

  const clearEvents = useCallback(() => setEvents([]), []);
  /** "Not an issue": hide one alert (false-positive management). */
  const dismissEvent = useCallback((id: string) => {
    dismissedRef.current.add(id);
    setEvents((old) => old.filter((e) => e.id !== id));
  }, []);
  const setBehaviour = useCallback((patch: Partial<BehaviourSettings>) => {
    setSetup((s) => ({ ...s, behaviour: normalizeBehaviour({ ...s.behaviour, ...patch }) }));
  }, []);
  /** What the live session has seen so far, for the AI investigator. */
  const liveInvestigation = useCallback((): Investigation => {
    const dismissed = dismissedRef.current;
    return investigateLive(
      monitor(),
      behaviourLogRef.current.filter((e) => !dismissed.has(e.id)),
      zoneLogRef.current.filter((e) => !dismissed.has(e.id)),
      sessionStartRef.current,
      lastTRef.current,
    );
  }, []);

  const addZone = useCallback((points: Pt[]) => {
    setSetup((s) => ({ ...s, zones: [...s.zones, { id: uid(), name: `Zone ${s.zones.length + 1}`, color: GEOMETRY_COLORS[s.zones.length % GEOMETRY_COLORS.length], points }] }));
    setMode("view");
  }, []);
  const addLine = useCallback((a: Pt, b: Pt) => {
    setSetup((s) => ({ ...s, lines: [...s.lines, { id: uid(), name: `Line ${s.lines.length + 1}`, color: GEOMETRY_COLORS[(s.lines.length + 3) % GEOMETRY_COLORS.length], a, b }] }));
    setMode("view");
  }, []);
  const rename = useCallback((kind: "zone" | "line", id: string, name: string) => {
    setSetup((s) => (kind === "zone"
      ? { ...s, zones: s.zones.map((z) => (z.id === id ? { ...z, name } : z)) }
      : { ...s, lines: s.lines.map((l) => (l.id === id ? { ...l, name } : l)) }));
  }, []);
  const remove = useCallback((kind: "zone" | "line", id: string) => {
    setSetup((s) => ({
      ...s,
      zones: kind === "zone" ? s.zones.filter((z) => z.id !== id) : s.zones,
      lines: kind === "line" ? s.lines.filter((l) => l.id !== id) : s.lines,
      rules: s.rules.filter((r) => r.target !== id),
    }));
  }, []);
  const addRule = useCallback((rule: Omit<Rule, "id" | "enabled">) => {
    setSetup((s) => ({ ...s, rules: [...s.rules, { ...rule, id: uid(), enabled: true }] }));
  }, []);
  const toggleRule = useCallback((id: string) => {
    setSetup((s) => ({ ...s, rules: s.rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)) }));
  }, []);
  const removeRule = useCallback((id: string) => {
    setSetup((s) => ({ ...s, rules: s.rules.filter((r) => r.id !== id) }));
  }, []);
  const clearSetup = useCallback(() => setSetup((s) => ({ ...EMPTY, behaviour: s.behaviour })), []);
  /** A ready-made setup so the features can be tried without drawing anything first. */
  const loadExample = useCallback(() => {
    const zone: Zone = { id: uid(), name: "Center zone", color: GEOMETRY_COLORS[0], points: [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.7, y: 0.95 }, { x: 0.3, y: 0.95 }] };
    const line: CountLine = { id: uid(), name: "Center line", color: GEOMETRY_COLORS[3], a: { x: 0.5, y: 0.05 }, b: { x: 0.5, y: 0.95 } };
    setSetup((s) => ({
      behaviour: s.behaviour,
      zones: [zone],
      lines: [line],
      rules: [
        { id: uid(), kind: "occupancy", name: "Crowding", target: zone.id, label: "any", threshold: 2, enabled: true },
        { id: uid(), kind: "loiter", name: "Loitering", target: zone.id, label: "person", threshold: 10, enabled: true },
        { id: uid(), kind: "crossing", name: "Line crossing", target: line.id, label: "any", threshold: 0, enabled: true },
      ],
    }));
  }, []);

  return {
    setup, ready, mode, setMode, snapshot, events, heat, frameSize, soundOn, setSoundOn,
    ingest, resetSession, clearEvents, dismissEvent, setBehaviour, liveInvestigation, addZone, addLine, rename, remove, addRule, toggleRule, removeRule, clearSetup, loadExample,
  };
}

export type VideoAnalytics = ReturnType<typeof useVideoAnalytics>;
