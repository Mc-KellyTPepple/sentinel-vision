import type { ReactNode } from "react";

const ICONS: Record<string, string> = {
  overview: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  camera: "M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  film: "M3 5h18v14H3z M7 5v14 M17 5v14 M3 9h4 M3 15h4 M17 9h4 M17 15h4",
  shield: "M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6l8-3z M9 12l2 2 4-4",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  layers: "M12 3l9 5-9 5-9-5 9-5z M3 13l9 5 9-5",
  polygon: "M5 7l7-4 7 5-3 11-10-2z",
  line: "M4 20L20 4 M4 20h.01 M20 4h.01",
  play: "M7 4l13 8-13 8z",
  pause: "M8 5v14 M16 5v14",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13",
  plus: "M12 5v14 M5 12h14",
  bell: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4l2-2z M10 20a2 2 0 0 0 4 0",
  check: "M5 12l5 5 9-10",
  x: "M6 6l12 12 M18 6L6 18",
  flame: "M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z",
  route: "M5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M19 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M7 17c6 0 2-10 10-10",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2",
  download: "M12 4v12 M7 11l5 5 5-5 M4 20h16",
  zap: "M13 2L4 14h7l-1 8 9-12h-7z",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 12h.01",
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Kpi({ label, value, hint, icon, tone = "green", children }: { label: string; value: ReactNode; hint?: ReactNode; icon?: IconName; tone?: "green" | "cyan" | "amber" | "red"; children?: ReactNode }) {
  return (
    <div className={`kpi kpi-${tone}`}>
      <div className="kpi-top">
        <span>{label}</span>
        {icon && <span className="kpi-icon"><Icon name={icon} size={16} /></span>}
      </div>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
      {children}
    </div>
  );
}

export function Sparkline({ values, color = "#b6f36b", height = 34 }: { values: number[]; color?: string; height?: number }) {
  if (values.length < 2) return <div className="spark-empty" style={{ height }} />;
  const W = 120;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, height - 3 - ((v - min) / span) * (height - 8)]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${W} ${height} L0 ${height} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ height }} aria-hidden="true">
      <path d={area} fill={color} opacity={0.16} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function BarChart({ items, height = 150, color = "#6ce3d0" }: { items: { label: string; value: number }[]; height?: number; color?: string }) {
  if (!items.length) return <p className="subcopy">No data yet.</p>;
  const W = 420;
  const pad = 22;
  const max = Math.max(...items.map((i) => i.value), 1);
  const bw = (W - pad) / items.length;
  return (
    <svg className="barchart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Bar chart">
      <defs>
        <linearGradient id="bar-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} />
          <stop offset="100%" stopColor="#4f7cff" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((g) => (
        <line key={g} x1={pad} x2={W} y1={height - 22 - (height - 40) * g} y2={height - 22 - (height - 40) * g} stroke="rgba(255,255,255,0.06)" />
      ))}
      {items.map((it, i) => {
        const h = ((height - 40) * it.value) / max;
        const x = pad + i * bw + bw * 0.18;
        return (
          <g key={`${it.label}-${i}`}>
            <rect x={x} y={height - 22 - h} width={bw * 0.64} height={Math.max(2, h)} rx={4} fill="url(#bar-grad)" />
            <text x={x + bw * 0.32} y={height - 26 - h} textAnchor="middle" className="chart-val">{it.value}</text>
            <text x={x + bw * 0.32} y={height - 7} textAnchor="middle" className="chart-lab">{it.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function Donut({ segments, size = 132, center }: { segments: { label: string; value: number; color: string }[]; size?: number; center?: ReactNode }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const r = 46;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut" style={{ width: size, height: size }}>
      <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label="Distribution">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="13" />
        {total > 0 && segments.filter((s) => s.value > 0).map((s) => {
          const len = (s.value / total) * c;
          const el = (
            <circle key={s.label} cx="60" cy="60" r={r} fill="none" stroke={s.color} strokeWidth="13" strokeDasharray={`${Math.max(0, len - 2)} ${c - len + 2}`} strokeDashoffset={-offset} transform="rotate(-90 60 60)" />
          );
          offset += len;
          return el;
        })}
      </svg>
      <div className="donut-center">{center}</div>
    </div>
  );
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
