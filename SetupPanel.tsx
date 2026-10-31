"use client";

import { useState } from "react";
import type { Rule, RuleKind } from "../lib/analytics";
import type { VideoAnalytics } from "../lib/useVideoAnalytics";
import { Icon } from "./ui";

const COMMON_CLASSES = ["person", "car", "truck", "bus", "bicycle", "motorcycle", "dog", "cat", "backpack", "handbag", "suitcase", "bottle", "cell phone", "laptop", "chair", "couch"];

const KIND_LABEL: Record<RuleKind, string> = {
  occupancy: "Crowding: too many objects in a zone",
  loiter: "Loitering: stays in a zone too long",
  crossing: "Crossing: object crosses a line",
};

function describe(rule: Rule, va: VideoAnalytics): string {
  const what = rule.label === "any" ? "any object" : rule.label;
  if (rule.kind === "crossing") return `${what} crosses “${va.setup.lines.find((l) => l.id === rule.target)?.name ?? "deleted line"}”`;
  const zone = va.setup.zones.find((z) => z.id === rule.target)?.name ?? "deleted zone";
  return rule.kind === "occupancy" ? `${rule.threshold}+ ${what} in “${zone}”` : `${what} stays in “${zone}” for ${rule.threshold}s`;
}

export default function SetupPanel({ va }: { va: VideoAnalytics }) {
  const { setup, snapshot, mode } = va;
  const [kind, setKind] = useState<RuleKind>("occupancy");
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("any");
  const [threshold, setThreshold] = useState(2);
  const [name, setName] = useState("");

  const targets = kind === "crossing" ? setup.lines : setup.zones;
  const chosen = targets.some((t) => t.id === target) ? target : targets[0]?.id ?? "";
  const empty = !setup.zones.length && !setup.lines.length;

  const submit = () => {
    if (!chosen) return;
    const fallback = kind === "occupancy" ? "Crowding" : kind === "loiter" ? "Loitering" : "Line crossing";
    va.addRule({ kind, name: name.trim() || fallback, target: chosen, label: label.trim().toLowerCase() || "any", threshold: kind === "crossing" ? 0 : Math.max(1, threshold) });
    setName("");
  };

  return (
    <div className="setup">
      <div className="setup-head">
        <h3>Zones and lines</h3>
        <div className="setup-actions">
          <button type="button" className={`small-button${mode === "zone" ? " is-on" : ""}`} onClick={() => va.setMode(mode === "zone" ? "view" : "zone")}><Icon name="polygon" size={15} /> Draw zone</button>
          <button type="button" className={`small-button${mode === "line" ? " is-on" : ""}`} onClick={() => va.setMode(mode === "line" ? "view" : "line")}><Icon name="line" size={15} /> Draw line</button>
          <button type="button" className="small-button" onClick={va.loadExample}><Icon name="zap" size={15} /> Load example</button>
          {!empty && <button type="button" className="small-button" onClick={va.clearSetup}>Clear all</button>}
        </div>
      </div>

      {empty ? (
        <p className="subcopy">Draw a zone on the video to count what is inside it, or a line to count crossings in each direction. Your setup is remembered in this browser. <strong>Load example</strong> adds a ready-made zone, line and three alert rules.</p>
      ) : (
        <ul className="geo-list">
          {setup.zones.map((z) => {
            const c = snapshot?.zoneCounts[z.id];
            return (
              <li key={z.id}>
                <span className="geo-dot" style={{ background: z.color }} />
                <input className="geo-name" value={z.name} aria-label="Zone name" onChange={(e) => va.rename("zone", z.id, e.target.value)} />
                <span className="geo-stat" title={c ? Object.entries(c.byLabel).map(([k, v]) => `${v} ${k}`).join(", ") : ""}>{c ? `${c.total} inside` : "zone"}</span>
                <button type="button" className="icon-button" aria-label={`Delete ${z.name}`} onClick={() => va.remove("zone", z.id)}><Icon name="trash" size={15} /></button>
              </li>
            );
          })}
          {setup.lines.map((l) => {
            const c = snapshot?.lineCounts[l.id];
            return (
              <li key={l.id}>
                <span className="geo-dot geo-dot-line" style={{ background: l.color }} />
                <input className="geo-name" value={l.name} aria-label="Line name" onChange={(e) => va.rename("line", l.id, e.target.value)} />
                <span className="geo-stat">{c ? `▸ ${c.forward}  ◂ ${c.backward}` : "line"}</span>
                <button type="button" className="icon-button" aria-label={`Delete ${l.name}`} onClick={() => va.remove("line", l.id)}><Icon name="trash" size={15} /></button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="setup-head" style={{ marginTop: 18 }}>
        <h3>Alert rules</h3>
        <label className="toggle"><input type="checkbox" checked={va.soundOn} onChange={(e) => va.setSoundOn(e.target.checked)} /> Sound</label>
      </div>
      {setup.rules.length > 0 && (
        <ul className="rule-list">
          {setup.rules.map((r) => (
            <li key={r.id} className={r.enabled ? "" : "is-off"}>
              <label className="toggle"><input type="checkbox" checked={r.enabled} onChange={() => va.toggleRule(r.id)} aria-label={`Enable ${r.name}`} /></label>
              <span><strong>{r.name}</strong><small>{describe(r, va)}</small></span>
              <button type="button" className="icon-button" aria-label={`Delete rule ${r.name}`} onClick={() => va.removeRule(r.id)}><Icon name="trash" size={15} /></button>
            </li>
          ))}
        </ul>
      )}
      {targets.length === 0 ? (
        <p className="subcopy">{kind === "crossing" ? "Draw a line first to add a crossing rule." : "Draw a zone first to add this rule."}</p>
      ) : null}
      <div className="rule-form">
        <select value={kind} onChange={(e) => { setKind(e.target.value as RuleKind); setTarget(""); }} aria-label="Rule type">
          {(Object.keys(KIND_LABEL) as RuleKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select value={chosen} onChange={(e) => setTarget(e.target.value)} aria-label={kind === "crossing" ? "Line" : "Zone"} disabled={!targets.length}>
          {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <input list="class-options" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Object class" placeholder="any" />
        <datalist id="class-options"><option value="any" />{COMMON_CLASSES.map((c) => <option key={c} value={c} />)}</datalist>
        <div className={`rule-row${kind === "crossing" ? " single" : ""}`}>
          {kind !== "crossing" && <input type="number" min={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} aria-label={kind === "occupancy" ? "Object limit" : "Seconds"} title={kind === "occupancy" ? "Alert at this many objects" : "Alert after this many seconds"} />}
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Rule name" placeholder="Rule name (optional)" />
        </div>
        <button type="button" className="small-button rule-add" onClick={submit} disabled={!chosen}><Icon name="plus" size={15} /> Add rule</button>
      </div>

      <div className="setup-head" style={{ marginTop: 18 }}>
        <h3>Alerts and events</h3>
        {va.events.length > 0 && <button type="button" className="small-button" onClick={va.clearEvents}>Clear</button>}
      </div>
      {!va.events.length ? (
        <p className="subcopy">Entries, exits, line crossings and rule alerts appear here as they happen.</p>
      ) : (
        <ul className="event-list">
          {va.events.slice(0, 12).map((e) => (
            <li key={e.id} className={`ev-${e.kind === "alert" ? e.severity : "info"}`}>
              <Icon name={e.kind === "alert" ? "bell" : e.kind === "cross" ? "route" : "target"} size={15} />
              <span>{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
