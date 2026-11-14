"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { FrameData } from "../lib/analytics";
import {
  answerLocally, buildContext, buildReport, mmss, nameTrack, searchTimeline, summarize,
  type Investigation, type Keyframe, type TimelineItem,
} from "../lib/intelligence";
import OverlayStage, { type StageBox } from "./OverlayStage";
import { Icon } from "./ui";

export type AiInfo = { available: boolean; model: string | null };
type Answer = { q: string; a: string; source: string; times: number[] };

const CLIP_QUESTIONS = ["What happened in this video?", "How many people were there?", "Did anyone leave an object behind?", "Describe the events between 00:00 and 00:10", "When did a person in red appear?"];
const LIVE_QUESTIONS = ["What is happening?", "How many people have been seen?", "Anything that needs my attention?", "Did anyone leave an object behind?"];

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Times like 00:12 mentioned in an AI answer, so they can be clicked as evidence. */
function timesInText(text: string): number[] {
  return [...text.matchAll(/\b(\d{1,2}):(\d{2})\b/g)].map((m) => Number(m[1]) * 60 + Number(m[2])).slice(0, 8);
}

export default function Investigator({
  inv, keyframes = [], frames = [], api, getToken, ai, compact = false,
}: {
  inv: Investigation;
  keyframes?: Keyframe[];
  frames?: FrameData[];
  api: string;
  getToken: () => Promise<string | null>;
  ai: AiInfo;
  compact?: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [asking, setAsking] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryNote, setSummaryNote] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<{ t: number; item?: TimelineItem } | null>(null);

  const summary = useMemo(() => summarize(inv), [inv]);
  const timeline = useMemo(() => (search.trim() ? searchTimeline(inv.timeline, search) : inv.timeline), [inv, search]);
  const objects = Object.values(inv.uniqueByLabel).reduce((a, b) => a + b, 0);
  const needsLook = inv.timeline.filter((i) => i.severity !== "info").length;

  async function callAi(mode: "answer" | "summary", q: string): Promise<{ text: string; model: string }> {
    const token = await getToken();
    if (!token) throw new Error("Sign in again to use the AI analyst.");
    const res = await fetch(`${api}/api/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ question: q, context: buildContext(inv), mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `AI request failed (${res.status}).`);
    return { text: String(data.answer || ""), model: String(data.model || "AI") };
  }

  async function ask(q: string) {
    const text = q.trim();
    if (!text || asking) return;
    setAsking(true);
    setQuestion("");
    let answer: Answer;
    if (ai.available) {
      try {
        const r = await callAi("answer", text);
        answer = { q: text, a: r.text, source: `AI analyst · ${r.model}`, times: timesInText(r.text) };
      } catch (err) {
        const local = answerLocally(text, inv);
        answer = { q: text, a: local.answer, source: `Built-in analyst (${err instanceof Error ? err.message : "AI unavailable"})`, times: local.times };
      }
    } else {
      const local = answerLocally(text, inv);
      answer = { q: text, a: local.answer, source: "Built-in analyst", times: local.times };
    }
    setAnswers((old) => [answer, ...old].slice(0, 12));
    setAsking(false);
  }

  async function writeSummary() {
    setSummaryBusy(true);
    setSummaryNote("");
    try {
      const r = await callAi("summary", "");
      setAiSummary(r.text);
      setSummaryNote(`Written by ${r.model} from the event data below. Check it against the evidence.`);
    } catch (err) {
      setSummaryNote(err instanceof Error ? err.message : "The AI summary is unavailable.");
    } finally {
      setSummaryBusy(false);
    }
  }

  // evidence for the selected moment: nearest keyframe, plus boxes rebuilt from the saved detections
  const evidence = useMemo(() => {
    if (!selected) return null;
    const t = selected.t;
    const kf = keyframes.length ? keyframes.reduce((best, k) => (Math.abs(k.t - t) < Math.abs(best.t - t) ? k : best)) : null;
    let frame: FrameData | null = null;
    for (const f of frames) if (!frame || Math.abs(f.t - t) < Math.abs(frame.t - t)) frame = f;
    const boxes: StageBox[] = frame
      ? frame.detections
          .filter((d) => selected.item?.trackId === undefined || d.track_id === selected.item.trackId || d.label === "person")
          .map((d) => ({ x1: d.x1 / frame!.width, y1: d.y1 / frame!.height, x2: d.x2 / frame!.width, y2: d.y2 / frame!.height, label: d.label, track_id: d.track_id, confidence: d.confidence }))
      : [];
    return { t, kf, frame, boxes, item: selected.item };
  }, [selected, keyframes, frames]);

  const report = () => buildReport(inv, { generatedAt: new Date().toLocaleString(), qa: answers.map((x) => ({ q: x.q, a: `${x.a}\n_(${x.source})_` })) });
  const baseName = (inv.source === "live" ? "live-session" : inv.name.replace(/\.[a-z0-9]+$/i, "")).replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60) || "analysis";

  const askForm = (
    <form className="ask-row" onSubmit={(e: FormEvent) => { e.preventDefault(); void ask(question); }}>
      <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={compact ? "Ask about this session…" : "Ask Sentinel about this video…"} aria-label="Question about the video" maxLength={500} />
      <button className="primary-button" type="submit" disabled={asking || !question.trim()}>{asking ? <span className="spinner" /> : "Ask"}</button>
    </form>
  );

  return (
    <section className="inv" aria-label="Sentinel AI Investigator">
      <div className="inv-head">
        <h3><Icon name="eye" size={18} /> Sentinel AI Investigator</h3>
        <span className="pill">{ai.available ? `AI on · ${ai.model ?? "LLM"}` : "Built-in analyst"}</span>
      </div>

      <div className="inv-kpis">
        <div><span>Objects tracked</span><strong>{objects}</strong></div>
        <div><span>People</span><strong>{inv.uniqueByLabel.person || 0}</strong></div>
        <div className={needsLook ? "warn" : ""}><span>Need a look</span><strong>{needsLook}</strong></div>
        <div><span>{inv.source === "live" ? "Session" : "Video"}</span><strong>{inv.duration >= 60 ? mmss(inv.duration) : `${Math.round(inv.duration)}s`}</strong></div>
      </div>

      <p className="inv-summary">{summary}</p>
      {aiSummary && <><p className="inv-summary ai" style={{ marginTop: 10 }}>{aiSummary}</p></>}
      {(summaryNote || !compact) && (
        <div className="inv-tools" style={{ marginTop: 8, alignItems: "center" }}>
          {ai.available && <button type="button" className="small-button" onClick={() => void writeSummary()} disabled={summaryBusy}>{summaryBusy ? "Writing…" : aiSummary ? "Rewrite with AI" : "Write summary with AI"}</button>}
          {summaryNote && <span className="inv-source">{summaryNote}</span>}
        </div>
      )}

      <div className="inv-section">
        <h4>Ask Sentinel</h4>
        {askForm}
        {!answers.length && (
          <div className="suggestions">
            {(compact ? LIVE_QUESTIONS : CLIP_QUESTIONS).map((s) => <button key={s} type="button" onClick={() => void ask(s)}>{s}</button>)}
          </div>
        )}
        {answers.length > 0 && (
          <ul className="qa">
            {answers.map((x, i) => (
              <li key={i}>
                <div className="q">{x.q}</div>
                <div className="a">{x.a}</div>
                {!compact && x.times.length > 0 && <div>{[...new Set(x.times.map((t) => Math.round(t * 10) / 10))].slice(0, 6).map((t) => <button key={t} type="button" className="time-chip" onClick={() => setSelected({ t })}>{mmss(t)} evidence</button>)}</div>}
                <span className="inv-source">{x.source}</span>
              </li>
            ))}
          </ul>
        )}
        {!ai.available && !compact && <p className="footnote" style={{ marginTop: 8 }}>Answers come from the built-in analyst, which handles common questions about what appeared, when and where. Answers are based on the event timeline below, not on the video itself.</p>}
      </div>

      <div className="inv-section">
        <h4>Event timeline ({inv.timeline.length})</h4>
        {!compact && <input className="inv-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search events, e.g. “bag left behind”, “person #2”, “crossed”" aria-label="Search events" />}
        {!timeline.length ? <p className="subcopy" style={{ margin: 0 }}>{search ? "No events match this search." : "No events yet."}</p> : (
          <ul className="timeline">
            {(compact ? timeline.slice(-8).reverse() : timeline).map((i) => (
              <li key={i.id}>
                <button type="button" className={`sev-${i.severity}${selected?.item?.id === i.id ? " on" : ""}`} onClick={() => setSelected({ t: i.t, item: i })} disabled={compact}>
                  <time>{mmss(i.t)}</time>
                  <span><strong>{i.title}</strong>{i.detail}{i.reason && i.severity !== "info" && <small>Why: {i.reason}</small>}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {evidence && !compact && (
          <div className="evidence">
            <div>
              {evidence.kf ? <img src={evidence.kf.image} alt={`Annotated frame at ${mmss(evidence.kf.t)}`} /> : evidence.frame ? (
                <OverlayStage width={evidence.frame.width} height={evidence.frame.height} backdrop boxes={evidence.boxes} ariaLabel={`Detections at ${mmss(evidence.frame.t)}`} />
              ) : <p className="subcopy">No frame data for this moment.</p>}
            </div>
            <div>
              <p><strong>Evidence at {mmss(evidence.t)}</strong></p>
              {evidence.item && <p>{evidence.item.detail}</p>}
              {evidence.item?.reason && <p className="subcopy" style={{ margin: "0 0 6px" }}>Why: {evidence.item.reason}</p>}
              {evidence.item?.trackId !== undefined && <p>Track #{evidence.item.trackId}</p>}
              <p className="subcopy" style={{ margin: 0 }}>
                {evidence.kf
                  ? `Annotated keyframe from ${mmss(evidence.kf.t)} (frame ${evidence.kf.frame}), the nearest kept frame. Shows ${Object.entries(evidence.kf.labels).map(([k, v]) => `${v} ${k}`).join(", ") || "no objects"}.`
                  : evidence.frame ? `Boxes rebuilt from the saved detections at ${mmss(evidence.frame.t)}; the video itself is not stored.` : ""}
              </p>
              <button type="button" className="small-button" style={{ marginLeft: 0, marginTop: 8 }} onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
        )}
      </div>

      {!compact && inv.profiles.length > 0 && (
        <details className="fold inv-section">
          <summary>Tracked objects ({inv.profiles.length})</summary>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Track</th><th>Colour</th><th>In view</th><th>Activity</th><th>Direction</th><th>Confidence</th></tr></thead>
              <tbody>
                {inv.profiles.map((p) => (
                  <tr key={p.id}>
                    <td><button type="button" className="time-chip" style={{ margin: 0 }} onClick={() => setSelected({ t: p.first })}>{nameTrack(p.label, p.id)}</button></td>
                    <td>{p.color ?? "—"}</td>
                    <td>{mmss(p.first)}–{mmss(p.last)}</td>
                    <td>{p.activity}</td>
                    <td>{[p.direction, p.approach].filter(Boolean).join(", ") || "—"}</td>
                    <td>{(p.avgConfidence * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="footnote">Colour is the main colour of the box (a person&apos;s torso). Activity and direction come from how the box moves on screen; they are estimates.</p>
        </details>
      )}

      {!compact && inv.runConfig && Object.keys(inv.runConfig).length > 0 && (
        <details className="fold inv-section">
          <summary>How this was analysed (reproducibility)</summary>
          <dl className="config-list">
            {Object.entries(inv.runConfig).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, " ")}</dt><dd>{String(v)}</dd></div>)}
          </dl>
        </details>
      )}

      {!compact && (
        <div className="inv-tools inv-section">
          <button type="button" className="small-button" onClick={() => download(`${baseName}-evidence-report.md`, report(), "text/markdown")}><Icon name="download" size={15} /> Evidence report (.md)</button>
          <button type="button" className="small-button" onClick={() => download(`${baseName}-events.json`, JSON.stringify({ summary, ...inv, questions: answers }, null, 2), "application/json")}><Icon name="download" size={15} /> Event data (.json)</button>
        </div>
      )}
      <p className="footnote" style={{ marginBottom: 0 }}>Findings are automatic estimates from detected boxes, never proof of what happened or of anyone&apos;s intent. Review the evidence before acting.</p>
    </section>
  );
}
