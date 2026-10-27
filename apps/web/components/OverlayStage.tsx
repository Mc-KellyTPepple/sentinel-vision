"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { colorForLabel, heatColor, type CountLine, type Heatmap, type Pt, type TrackPath, type Zone } from "../lib/analytics";
import type { StageMode } from "../lib/useVideoAnalytics";

/** A box in normalized (0..1) coordinates. */
export type StageBox = { x1: number; y1: number; x2: number; y2: number; label: string; track_id: number | null; confidence: number };

type Scene = {
  zones: Zone[];
  lines: CountLine[];
  paths: TrackPath[];
  heat: Heatmap | null;
  heatOpacity: number;
  boxes: StageBox[];
  zoneCounts: Record<string, { total: number }>;
  lineCounts: Record<string, { forward: number; backward: number }>;
  showZones: boolean;
  showTrails: boolean;
  draft: Pt[];
  cursor: Pt | null;
  mode: StageMode;
};

type Props = {
  /** Frame size in pixels; only its aspect ratio matters. */
  width: number;
  height: number;
  zones?: Zone[];
  lines?: CountLine[];
  paths?: TrackPath[];
  heat?: Heatmap | null;
  heatOpacity?: number;
  boxes?: StageBox[];
  zoneCounts?: Record<string, { total: number }>;
  lineCounts?: Record<string, { forward: number; backward: number }>;
  showZones?: boolean;
  showTrails?: boolean;
  mode?: StageMode;
  onZoneDrawn?: (points: Pt[]) => void;
  onLineDrawn?: (a: Pt, b: Pt) => void;
  onCancelDraw?: () => void;
  /** Dark grid backdrop for views that have no video behind them. */
  backdrop?: boolean;
  /** Adds the subtle scanning effect while a camera is running. */
  live?: boolean;
  ariaLabel?: string;
  children?: ReactNode;
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function chip(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  ctx.font = "600 12px 'DM Sans', system-ui, sans-serif";
  const w = ctx.measureText(text).width + 14;
  const h = 20;
  const px = Math.max(2, x);
  const py = Math.max(2, y - h);
  ctx.fillStyle = "rgba(8,13,22,0.82)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(px, py, w, h, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#e9eef7";
  ctx.textBaseline = "middle";
  ctx.fillText(text, px + 7, py + h / 2 + 0.5);
}

function drawHeat(ctx: CanvasRenderingContext2D, W: number, H: number, heat: Heatmap, opacity: number) {
  if (heat.max <= 0) return;
  const small = document.createElement("canvas");
  small.width = heat.cols;
  small.height = heat.rows;
  const sctx = small.getContext("2d");
  if (!sctx) return;
  for (let i = 0; i < heat.cells.length; i++) {
    const v = heat.cells[i] / heat.max;
    if (v < 0.02) continue;
    sctx.fillStyle = heatColor(Math.sqrt(v));
    sctx.fillRect(i % heat.cols, Math.floor(i / heat.cols), 1, 1);
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.globalAlpha = opacity;
  ctx.drawImage(small, 0, 0, W, H);
  ctx.restore();
}

function drawScene(ctx: CanvasRenderingContext2D, W: number, H: number, s: Scene) {
  if (s.heat) drawHeat(ctx, W, H, s.heat, s.heatOpacity);

  if (s.showTrails) {
    for (const p of s.paths) {
      if (p.points.length < 2) continue;
      const color = colorForLabel(p.label);
      const fade = Math.max(0.25, 1 - p.age / 8);
      const n = p.points.length;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 1; i < n; i++) {
        ctx.strokeStyle = rgba(color, (0.12 + (0.8 * i) / n) * fade);
        ctx.lineWidth = 1.6 + (2 * i) / n;
        ctx.beginPath();
        ctx.moveTo(p.points[i - 1].x * W, p.points[i - 1].y * H);
        ctx.lineTo(p.points[i].x * W, p.points[i].y * H);
        ctx.stroke();
      }
      const head = p.points[n - 1];
      ctx.fillStyle = rgba(color, fade);
      ctx.beginPath();
      ctx.arc(head.x * W, head.y * H, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const b of s.boxes) {
    const color = colorForLabel(b.label);
    const x = b.x1 * W, y = b.y1 * H, w = (b.x2 - b.x1) * W, h = (b.y2 - b.y1) * H;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    chip(ctx, `${b.label}${b.track_id !== null ? ` #${b.track_id}` : ""} ${(b.confidence * 100).toFixed(0)}%`, x, y, color);
  }

  if (s.showZones) {
    for (const z of s.zones) {
      if (z.points.length < 3) continue;
      const count = s.zoneCounts[z.id]?.total ?? 0;
      ctx.beginPath();
      z.points.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
      ctx.closePath();
      ctx.fillStyle = rgba(z.color, count > 0 ? 0.28 : 0.12);
      ctx.fill();
      ctx.strokeStyle = z.color;
      ctx.lineWidth = count > 0 ? 3 : 2;
      ctx.stroke();
      const top = z.points.reduce((a, p) => (p.y < a.y ? p : a), z.points[0]);
      chip(ctx, `${z.name} · ${count}`, top.x * W, top.y * H - 4 > 22 ? top.y * H - 4 : top.y * H + 26, z.color);
    }
    for (const l of s.lines) {
      const ax = l.a.x * W, ay = l.a.y * H, bx = l.b.x * W, by = l.b.y * H;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 6]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      // arrow towards the "forward" side (see crossedLine in analytics.ts)
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      ctx.fillStyle = l.color;
      ctx.beginPath();
      ctx.moveTo(mx + nx * 22, my + ny * 22);
      ctx.lineTo(mx + nx * 8 - (dx / len) * 7, my + ny * 8 - (dy / len) * 7);
      ctx.lineTo(mx + nx * 8 + (dx / len) * 7, my + ny * 8 + (dy / len) * 7);
      ctx.closePath();
      ctx.fill();
      const c = s.lineCounts[l.id] ?? { forward: 0, backward: 0 };
      chip(ctx, `${l.name} · ▸${c.forward} ◂${c.backward}`, Math.min(ax, bx), Math.min(ay, by) + 24, l.color);
    }
  }

  // shape being drawn
  if (s.draft.length) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    s.draft.forEach((p, i) => (i ? ctx.lineTo(p.x * W, p.y * H) : ctx.moveTo(p.x * W, p.y * H)));
    if (s.cursor) ctx.lineTo(s.cursor.x * W, s.cursor.y * H);
    ctx.stroke();
    ctx.setLineDash([]);
    s.draft.forEach((p, i) => {
      ctx.fillStyle = i === 0 && s.mode === "zone" && s.draft.length >= 3 ? "#b6f36b" : "#ffffff";
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, i === 0 ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

export default function OverlayStage({
  width, height, zones = [], lines = [], paths = [], heat = null, heatOpacity = 0.85, boxes = [], zoneCounts = {}, lineCounts = {},
  showZones = true, showTrails = true, mode = "view", onZoneDrawn, onLineDrawn, onCancelDraw, backdrop = false, live = false, ariaLabel, children,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [draft, setDraft] = useState<Pt[]>([]);
  const [cursor, setCursor] = useState<Pt | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setDraft([]);
    setCursor(null);
  }, [mode]);

  const finishZone = () => {
    if (draft.length >= 3) {
      onZoneDrawn?.(draft);
      setDraft([]);
    }
  };
  const cancel = () => {
    setDraft([]);
    onCancelDraw?.();
  };

  useEffect(() => {
    if (mode === "view") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDraft([]);
        onCancelDraw?.();
      } else if (e.key === "Enter" && mode === "zone" && draft.length >= 3) {
        onZoneDrawn?.(draft);
        setDraft([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, draft, onCancelDraw, onZoneDrawn]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    drawScene(ctx, size.w, size.h, { zones, lines, paths, heat, heatOpacity, boxes, zoneCounts, lineCounts, showZones, showTrails, draft, cursor, mode });
  }, [size, zones, lines, paths, heat, heatOpacity, boxes, zoneCounts, lineCounts, showZones, showTrails, draft, cursor, mode]);

  const toPoint = (e: ReactPointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };
  const near = (a: Pt, b: Pt, px: number) => Math.hypot((a.x - b.x) * size.w, (a.y - b.y) * size.h) < px;

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (mode === "view") return;
    const p = toPoint(e);
    if (mode === "zone") {
      if (draft.length >= 3 && near(p, draft[0], 14)) return finishZone();
      if (draft.length && near(p, draft[draft.length - 1], 6)) return;
      setDraft((d) => [...d, p]);
    } else if (draft.length === 0) {
      setDraft([p]);
    } else if (!near(p, draft[0], 6)) {
      onLineDrawn?.(draft[0], p);
      setDraft([]);
    }
  };

  const drawing = mode !== "view";
  return (
    <div
      ref={wrapRef}
      className={`stage${backdrop ? " stage-backdrop" : ""}${drawing ? " stage-drawing" : ""}${live ? " stage-live" : ""}`}
      style={{ aspectRatio: `${Math.max(1, width)} / ${Math.max(1, height)}`, width: `min(100%, calc(70vh * ${Math.max(1, width) / Math.max(1, height)}))` }}
    >
      {children}
      <canvas
        ref={canvasRef}
        className="stage-canvas"
        style={{ pointerEvents: drawing ? "auto" : "none", cursor: drawing ? "crosshair" : "default" }}
        role="img"
        aria-label={ariaLabel || "Video overlay"}
        onPointerDown={onDown}
        onPointerMove={(e) => drawing && setCursor(toPoint(e))}
        onPointerLeave={() => setCursor(null)}
        onDoubleClick={() => mode === "zone" && finishZone()}
      />
      {drawing && (
        <div className="stage-toolbar" role="status">
          <span>
            {mode === "zone"
              ? draft.length < 3 ? "Click to place the corners of the zone" : "Click the green point or press Enter to finish"
              : draft.length === 0 ? "Click where the counting line starts" : "Click where it ends"}
          </span>
          {mode === "zone" && draft.length >= 3 && <button type="button" className="small-button" onClick={finishZone}>Finish zone</button>}
          <button type="button" className="small-button" onClick={cancel}>Cancel</button>
        </div>
      )}
    </div>
  );
}
