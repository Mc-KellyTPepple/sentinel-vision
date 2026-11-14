"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import AnalysisVisuals from "../components/AnalysisVisuals";
import CommandCenter from "../components/CommandCenter";
import Investigator, { type AiInfo } from "../components/Investigator";
import OverlayStage from "../components/OverlayStage";
import SetupPanel from "../components/SetupPanel";
import { Icon } from "../components/ui";
import { useVideoAnalytics } from "../lib/useVideoAnalytics";
import { analyzeBatch, estimateFrameSize, framesFromSaved, type FrameData } from "../lib/analytics";
import { buildTags, investigateClip, matchesSearch, mmss, summarize, type Investigation, type Keyframe } from "../lib/intelligence";

const MAX_UPLOAD_MB = process.env.NEXT_PUBLIC_MAX_UPLOAD_MB || "20";
const MAX_VIDEO_SECONDS = process.env.NEXT_PUBLIC_MAX_VIDEO_SECONDS || "15";
type Tab = "overview" | "analyze" | "live" | "incidents";

type Detection = { frame:number; timestamp_seconds:number; class_id:number; label:string; confidence:number; x1:number; y1:number; x2:number; y2:number; track_id:number|null; color?:string|null };
type Evidence = { t:number; track_id:number|null; reason:string; message?:string; keyframe?:string|null; keyframe_t?:number|null };
type Incident = { id:string; title:string; description:string|null; severity:"low"|"medium"|"high"|"critical"; status:"open"|"acknowledged"|"resolved"; event_type:string; occurred_at:string; job_id:string; evidence?:Evidence|null; false_positive?:boolean; resolution_note?:string|null };
type Job = { id:string; original_filename:string; status:string; created_at:string; detections_count:number; duration_seconds:number|null; frames_processed:number; processing_seconds:number|null; average_inference_fps:number|null; run_config?:Record<string,unknown>|null; summary?:string|null; tags?:string[]|null };
const JOB_COLUMNS = "id,original_filename,status,created_at,detections_count,duration_seconds,frames_processed,processing_seconds,average_inference_fps";
const INCIDENT_COLUMNS = "id,title,description,severity,status,event_type,occurred_at,job_id";
/** True when Supabase reports a column that does not exist yet (migration 008 not applied). */
const missingColumn = (e:{code?:string;message?:string}|null) => !!e && (e.code==="42703"||e.code==="PGRST204"||/column|schema cache/i.test(e.message||""));
const BEHAVIOUR_INCIDENTS: Record<string,{title:string;severity:"low"|"medium"|"high"}> = {
  possible_fall:{title:"Possible fall",severity:"high"}, left_behind:{title:"Object possibly left behind",severity:"high"},
  removed:{title:"Object possibly removed",severity:"medium"}, crowd_change:{title:"Sudden crowd change",severity:"medium"}, running:{title:"Possible running",severity:"low"},
};
type IncidentAudit = { id:string; incident_id:string; user_id:string; previous_status:string; new_status:string; changed_at:string; changed_by:string|null };
const formatAuditTimestamp = (value:string) => `${new Date(value).toLocaleString("en-GB",{timeZone:"UTC",year:"numeric",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false})} UTC`;
type Analysis = {
  filename:string; duration_seconds:number; frames_processed:number; processing_seconds:number|null;
  average_inference_fps:number|null; detections_count:number; class_counts:Record<string,number>;
  detections:Detection[]; preview_image:string|null; note:string;
  frame_width?:number|null; frame_height?:number|null;
  keyframes?:Keyframe[]; run_config?:Record<string,unknown>|null;
};
const API = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000").replace(/\/$/, "");
type LiveDetection = { track_id:number|null; label:string; confidence:number; x1:number; y1:number; x2:number; y2:number };
type LiveResponse = { session_id:string; processed_ms:number; detections:LiveDetection[]; annotated_image:string|null; frame_width:number; frame_height:number };
type LiveEvent = { id:string; time:string; message:string; kind:"track"|"warning"|"system" };

export default function Home() {
  const [file,setFile] = useState<File|null>(null);
  const [tab,setTab] = useState<Tab>("overview");
  const va = useVideoAnalytics();
  const ingest = va.ingest;
  const resetAnalyticsSession = va.resetSession;
  const setVaMode = va.setMode;
  const [showTrails,setShowTrails] = useState(true);
  const [showHeat,setShowHeat] = useState(false);
  const [showZones,setShowZones] = useState(true);
  const [apiLatency,setApiLatency] = useState<number|null>(null);
  const apiFailsRef = useRef(0);
  useEffect(()=>{ setVaMode("view"); },[tab,setVaMode]);
  // On narrow screens the tab bar scrolls sideways: keep the selected tab fully in view.
  const tabsRef = useRef<HTMLElement|null>(null);
  useEffect(()=>{
    const nav = tabsRef.current, el = nav?.querySelector<HTMLElement>(".tab.active");
    if (nav && el && nav.scrollWidth > nav.clientWidth) nav.scrollTo({left:Math.max(0,el.offsetLeft-(nav.clientWidth-el.offsetWidth)/2),behavior:"smooth"});
  },[tab]);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [saveNotice,setSaveNotice] = useState("");
  const [result,setResult] = useState<Analysis|null>(null);
  const [apiStatus,setApiStatus] = useState<"checking"|"waking"|"online"|"offline">("checking");
  const [apiCheckedAt,setApiCheckedAt] = useState("");
  const [session,setSession] = useState<Session|null>(null);
  const [authReady,setAuthReady] = useState(false);
  const [authMode,setAuthMode] = useState<"signin"|"signup">("signin");
  const [email,setEmail] = useState("");
  const [password,setPassword] = useState("");
  const [authBusy,setAuthBusy] = useState(false);
  const [authMessage,setAuthMessage] = useState("");
  const [jobs,setJobs] = useState<Job[]>([]);
  const [aiInfo,setAiInfo] = useState<AiInfo>({available:false,model:null});
  const [schemaV8,setSchemaV8] = useState(true);
  const [jobQuery,setJobQuery] = useState("");
  const [jobResults,setJobResults] = useState<Job[]|null>(null);
  const [jobSearching,setJobSearching] = useState(false);
  const [confirmDeleteId,setConfirmDeleteId] = useState<string|null>(null);
  const [retentionDays,setRetentionDays] = useState(30);
  const [confirmRetention,setConfirmRetention] = useState(false);
  const [noteFor,setNoteFor] = useState<string|null>(null);
  const [noteText,setNoteText] = useState("");
  const [liveSendWidth,setLiveSendWidth] = useState(640);
  const liveWidthRef = useRef(640);
  const liveSlowRef = useRef(0);
  const liveFastRef = useRef(0);
  const [selectedJobId,setSelectedJobId] = useState<string|null>(null);
  const [loadingSavedJob,setLoadingSavedJob] = useState(false);
  const [loadingSavedJobId,setLoadingSavedJobId] = useState<string|null>(null);
  const [incidents,setIncidents] = useState<Incident[]>([]);
  /** Analyses that incidents belong to, so older groups show their file name and report button (the job list only holds the latest 5). */
  const [incidentJobs,setIncidentJobs] = useState<Job[]>([]);
  const [auditByIncident,setAuditByIncident] = useState<Record<string,IncidentAudit[]>>({});
  const [auditOpenId,setAuditOpenId] = useState<string|null>(null);
  const [auditLoadingId,setAuditLoadingId] = useState<string|null>(null);
  const [auditErrorByIncident,setAuditErrorByIncident] = useState<Record<string,string>>({});
  const [incidentNotice,setIncidentNotice] = useState("");
  const [incidentFilter,setIncidentFilter] = useState<"all"|"open"|"acknowledged"|"resolved">("all");
  const [detectionClassFilter,setDetectionClassFilter] = useState("all");
  const [selectedTimelineBucket,setSelectedTimelineBucket] = useState<number|null>(null);
  const [selectedTrackId,setSelectedTrackId] = useState<number|null>(null);
  const autoRestoreAttempted = useRef(false);
  const liveVideoRef = useRef<HTMLVideoElement|null>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement|null>(null);
  const liveStreamRef = useRef<MediaStream|null>(null);
  const liveSessionIdRef = useRef("");
  const liveSeenTrackIdsRef = useRef<Set<string>>(new Set());
  const liveConsecutiveErrorsRef = useRef(0);
  const liveHadErrorRef = useRef(false);
  const [liveRunning,setLiveRunning] = useState(false);
  const [liveStarting,setLiveStarting] = useState(false);
  const [liveError,setLiveError] = useState("");
  const [liveFrame,setLiveFrame] = useState("");
  const [liveDetections,setLiveDetections] = useState<LiveDetection[]>([]);
  const [liveFrames,setLiveFrames] = useState(0);
  const [liveFps,setLiveFps] = useState(0);
  const [liveTrackCounts,setLiveTrackCounts] = useState<Record<string,{label:string;labelVotes:Record<string,number>;count:number;confidenceTotal:number;lastSeen:number}>>({});
  const [liveEvents,setLiveEvents] = useState<LiveEvent[]>([]);
  const [liveProcessedMs,setLiveProcessedMs] = useState(0);
  const [liveLastFrameAt,setLiveLastFrameAt] = useState("");
  useEffect(()=>{setDetectionClassFilter("all");setSelectedTimelineBucket(null);setSelectedTrackId(null);},[selectedJobId,result?.filename,result?.detections_count]);

  async function getToken() {
    if (!supabase) return null;
    const {data} = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }

  /** Behaviour, timeline and summary for an analysis, using the current zones, lines, rules and behaviour settings. */
  function investigationFor(a:Analysis): {inv:Investigation; frames:FrameData[]} {
    const size = a.frame_width && a.frame_height ? {width:a.frame_width,height:a.frame_height} : estimateFrameSize(a.detections);
    const frames = framesFromSaved(a.detections,size);
    const {zones,lines,rules,behaviour} = va.setup;
    const zoneBatch = zones.length||lines.length ? analyzeBatch(frames,zones,lines,rules) : null;
    const inv = investigateClip(frames,{name:a.filename,duration:a.duration_seconds,framesProcessed:a.frames_processed,settings:behaviour,runConfig:a.run_config??null,zoneBatch,zones,lines});
    return {inv,frames};
  }

  async function startLiveCamera() {
    setLiveError(""); setLiveStarting(true);
    try {
      if (!session?.access_token) throw new Error("Sign in to use live tracking.");
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires localhost or a secure HTTPS connection and browser permission.");
      const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment",width:{ideal:640},height:{ideal:480}},audio:false});
      liveStreamRef.current = stream;
      if (liveVideoRef.current) { liveVideoRef.current.srcObject = stream; await liveVideoRef.current.play(); }
      liveSessionIdRef.current = (typeof crypto !== "undefined" && "randomUUID" in crypto) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      liveSeenTrackIdsRef.current = new Set(); liveConsecutiveErrorsRef.current = 0; liveHadErrorRef.current = false;
      liveWidthRef.current = 640; liveSlowRef.current = 0; liveFastRef.current = 0; setLiveSendWidth(640);
      resetAnalyticsSession(); setLiveFrame(""); setLiveDetections([]); setLiveFrames(0); setLiveFps(0); setLiveTrackCounts({}); setLiveLastFrameAt(""); setLiveEvents([{id:`start-${Date.now()}`,time:new Date().toLocaleTimeString(),message:"Live camera session started.",kind:"system" as const}]); setLiveProcessedMs(0); setLiveRunning(true);
    } catch(err) { setLiveError(err instanceof Error ? err.message : "Could not start the camera."); liveStreamRef.current?.getTracks().forEach(track=>track.stop()); liveStreamRef.current=null; }
    finally { setLiveStarting(false); }
  }
  function stopLiveCamera() {
    setLiveRunning(false); liveStreamRef.current?.getTracks().forEach(track=>track.stop()); liveStreamRef.current=null;
    if (liveVideoRef.current) liveVideoRef.current.srcObject = null;
    setLiveEvents(old=>[{id:`stop-${Date.now()}`,time:new Date().toLocaleTimeString(),message:"Live camera session stopped.",kind:"system" as const},...old].slice(0,20));
  }
  useEffect(()=>{
    if (!liveRunning || !session?.access_token) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>|undefined;
    let previous = performance.now();
    const processFrame = async () => {
      const video = liveVideoRef.current, canvas = liveCanvasRef.current;
      if (!video || !canvas || video.readyState < 2 || cancelled) { timeout=setTimeout(processFrame,250); return; }
      const width = video.videoWidth || 640, height = video.videoHeight || 480;
      // Adaptive frame size: smaller frames when the server or connection is slow, back up when it is fast.
      canvas.width = Math.min(width,liveWidthRef.current); canvas.height = Math.round(height * canvas.width / width);
      const ctx = canvas.getContext("2d");
      if (!ctx) { setLiveError("Could not prepare a camera frame."); stopLiveCamera(); return; }
      ctx.drawImage(video,0,0,canvas.width,canvas.height);
      const blob:Blob|null = await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",0.72));
      if (!blob || cancelled) { timeout=setTimeout(processFrame,250); return; }
      let pause = 450;
      try {
        const sentAt = performance.now();
        const body = new FormData(); body.append("file",blob,"webcam.jpg"); body.append("session_id",liveSessionIdRef.current);
        const response = await fetch(`${API}/api/v1/live/frame`,{method:"POST",headers:{Authorization:`Bearer ${session.access_token}`},body});
        if (!response.ok) { const payload=await response.json().catch(()=>({})); throw new Error(payload.detail || `Live inference failed (${response.status}).`); }
        const data:LiveResponse = await response.json();
        if (cancelled) return;
        const roundTrip = performance.now()-sentAt;
        if (roundTrip > 2500) { liveSlowRef.current += 1; liveFastRef.current = 0; } else if (roundTrip < 1000) { liveFastRef.current += 1; liveSlowRef.current = 0; }
        if (liveSlowRef.current >= 3 && liveWidthRef.current > 320) { liveWidthRef.current -= 160; liveSlowRef.current = 0; setLiveSendWidth(liveWidthRef.current); setLiveEvents(old=>[{id:`adapt-${Date.now()}`,time:new Date().toLocaleTimeString(),message:`The server is slow; sending smaller frames (${liveWidthRef.current}px wide) to keep up.`,kind:"system" as const},...old].slice(0,20)); }
        if (liveFastRef.current >= 6 && liveWidthRef.current < 640) { liveWidthRef.current += 160; liveFastRef.current = 0; setLiveSendWidth(liveWidthRef.current); }
        // give a busy shared CPU room to breathe instead of queueing frames behind each other; when the detector is
        // quick (ONNX Runtime: ~0.2 s a frame on the free host) send the next frame almost at once
        const processed = data.processed_ms||0;
        pause = processed > 1500 ? 900 : processed > 500 ? 450 : 120;
        setLiveFrame(data.annotated_image || ""); ingest({t:Date.now()/1000,width:data.frame_width||640,height:data.frame_height||480,detections:data.detections||[]}); setLiveDetections(data.detections || []); setLiveFrames(count=>count+1); setLiveProcessedMs(data.processed_ms || 0); setLiveLastFrameAt(new Date().toLocaleTimeString());
        const now=performance.now(); setLiveFps(1000/Math.max(1,now-previous)); previous=now;
        liveConsecutiveErrorsRef.current = 0;
        if (liveHadErrorRef.current) { liveHadErrorRef.current=false; setLiveEvents(old=>[{id:`recovered-${Date.now()}`,time:new Date().toLocaleTimeString(),message:"Connection recovered; live inference resumed.",kind:"system" as const},...old].slice(0,20)); }
        const newlySeen = (data.detections || []).filter(d=>d.track_id!==null && !liveSeenTrackIdsRef.current.has(String(d.track_id)));
        for (const d of newlySeen) liveSeenTrackIdsRef.current.add(String(d.track_id));
        if (newlySeen.length) setLiveEvents(old=>[...newlySeen.map(d=>({id:`track-${d.track_id}-${Date.now()}-${Math.random()}`,time:new Date().toLocaleTimeString(),message:`New track #${d.track_id} detected: ${d.label}.`,kind:"track" as const})),...old].slice(0,20));
        setLiveTrackCounts(old=>{const next={...old}; for (const d of data.detections || []) { if(d.track_id===null) continue; const key=String(d.track_id), prior=next[key], labelVotes={...(prior?.labelVotes||{})}; labelVotes[d.label]=(labelVotes[d.label]||0)+1; const label=Object.entries(labelVotes).sort((a,b)=>b[1]-a[1]||(a[0]===prior?.label?-1:1))[0]?.[0]||d.label; next[key]={label,labelVotes,count:(prior?.count||0)+1,confidenceTotal:(prior?.confidenceTotal||0)+d.confidence,lastSeen:Date.now()}; } return next;});
        setLiveError("");
      } catch(err) { if (!cancelled) { const message=err instanceof Error ? err.message : "Live inference failed."; setLiveError(message); liveConsecutiveErrorsRef.current += 1; if (!liveHadErrorRef.current) { liveHadErrorRef.current=true; setLiveEvents(old=>[{id:`warning-${Date.now()}`,time:new Date().toLocaleTimeString(),message:`Live inference interrupted: ${message}`,kind:"warning" as const},...old].slice(0,20)); } if (/401|sign in|expired/i.test(message)) stopLiveCamera(); } }
      const backoff = liveConsecutiveErrorsRef.current ? Math.min(5000,500*Math.pow(2,Math.min(liveConsecutiveErrorsRef.current-1,3))) : pause;
      timeout=setTimeout(processFrame,backoff);
    };
    void processFrame();
    return ()=>{cancelled=true;if(timeout)clearTimeout(timeout);};
  },[liveRunning,session?.access_token,ingest]);
  useEffect(()=>()=>{liveStreamRef.current?.getTracks().forEach(track=>track.stop());},[]);

  useEffect(() => {
    if (!supabase) { setAuthReady(true); return; }
    supabase.auth.getSession().then(({data}) => { setSession(data.session); setAuthReady(true); });
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_event,nextSession) => setSession(nextSession));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => { if (session?.user && supabase) { void loadJobs(); void loadIncidents(); } else { autoRestoreAttempted.current = false; setJobs([]); setIncidents([]); setIncidentJobs([]); } }, [session?.user.id]);

  async function loadJobs() {
    if (!supabase || !session?.user) return;
    const full = await supabase.from("analysis_jobs").select(`${JOB_COLUMNS},run_config,summary,tags`).order("created_at",{ascending:false}).limit(5);
    let data = full.data as Job[]|null, loadError = full.error;
    if (missingColumn(loadError)) {
      setSchemaV8(false);
      const basic = await supabase.from("analysis_jobs").select(JOB_COLUMNS).order("created_at",{ascending:false}).limit(5);
      data = basic.data as Job[]|null; loadError = basic.error;
    }
    if (loadError) {
      setSaveNotice(`Could not load saved jobs: ${loadError.message}`);
      autoRestoreAttempted.current = true;
    } else {
      const savedJobs = (data || []) as Job[];
      setJobs(savedJobs);
      // Restore only once per page session, so later refreshes of the job list
      // cannot replace a report the user has just run or explicitly opened.
      if (!autoRestoreAttempted.current) {
        autoRestoreAttempted.current = true;
        if (savedJobs.length > 0) await loadSavedAnalysis(savedJobs[0]);
        else {
          setResult(null);
          setSelectedJobId(null);
        }
      }
    }
  }

  async function loadSavedAnalysis(job: Pick<Job,"id"|"original_filename"|"duration_seconds"|"frames_processed"|"detections_count"|"processing_seconds"|"average_inference_fps"> & {run_config?:Record<string,unknown>|null}) {
    if (!supabase || !session?.user) return;
    setLoadingSavedJob(true); setLoadingSavedJobId(job.id); setError(""); setSaveNotice(""); setIncidentNotice("");
    try {
      const {data:rows,error:eventsError} = await supabase.from("detection_events").select("label,confidence,frame_index,timestamp_seconds,bbox,track_id").eq("job_id",job.id).order("frame_index",{ascending:true}).order("timestamp_seconds",{ascending:true}).limit(10000);
      if (eventsError) throw eventsError;
      const detections: Detection[] = (rows || []).map((row:any) => {
        const box = row.bbox && typeof row.bbox === "object" ? row.bbox : {};
        return {frame:Number(row.frame_index)||0,timestamp_seconds:Number(row.timestamp_seconds)||0,class_id:0,label:String(row.label),confidence:Number(row.confidence)||0,x1:Number(box.x1)||0,y1:Number(box.y1)||0,x2:Number(box.x2)||0,y2:Number(box.y2)||0,track_id:row.track_id==null?null:Number(row.track_id),color:typeof box.color==="string"?box.color:null};
      });
      const class_counts:Record<string,number> = {};
      for (const d of detections) class_counts[d.label] = (class_counts[d.label] || 0) + 1;
      const savedBox = (rows || []).find((r:any) => r.bbox && typeof r.bbox === "object" && Number(r.bbox.frame_width) > 0 && Number(r.bbox.frame_height) > 0)?.bbox;
      setResult({run_config:job.run_config??null,keyframes:[],frame_width:savedBox?Number(savedBox.frame_width):null,frame_height:savedBox?Number(savedBox.frame_height):null,filename:job.original_filename,duration_seconds:Number(job.duration_seconds)||0,frames_processed:job.frames_processed||0,processing_seconds:job.processing_seconds,average_inference_fps:job.average_inference_fps,detections_count:job.detections_count||detections.length,class_counts,detections,preview_image:null,note:`Loaded from your saved analysis. ${job.average_inference_fps == null || job.processing_seconds == null ? "Performance metrics were not recorded for this older analysis, so those values are shown as unavailable." : "Saved performance metrics were restored for this analysis."} The original video and annotated preview image are not stored; bounding boxes and detection samples were reconstructed from saved metadata.`});
      setSelectedJobId(job.id);
    } catch(err) { setError(`Could not load this saved analysis: ${err instanceof Error ? err.message : "Unknown database error"}`); }
    finally { setLoadingSavedJob(false); setLoadingSavedJobId(null); }
  }

  async function loadIncidents() {
    if (!supabase || !session?.user) return;
    const full = await supabase.from("incidents").select(`${INCIDENT_COLUMNS},evidence,false_positive,resolution_note`).order("occurred_at",{ascending:false}).limit(20);
    let data = full.data as Incident[]|null, incidentError = full.error;
    if (missingColumn(incidentError)) {
      setSchemaV8(false);
      const basic = await supabase.from("incidents").select(INCIDENT_COLUMNS).order("occurred_at",{ascending:false}).limit(20);
      data = basic.data as Incident[]|null; incidentError = basic.error;
    }
    if (incidentError) { setIncidentNotice(`Could not load incidents: ${incidentError.message}`); return; }
    const loaded = (data || []) as Incident[];
    setIncidents(loaded);
    const jobIds = Array.from(new Set(loaded.map(i=>i.job_id).filter(Boolean)));
    if (jobIds.length) {
      const {data:owners} = await supabase.from("analysis_jobs").select(JOB_COLUMNS).in("id",jobIds);
      setIncidentJobs((owners || []) as Job[]);
    } else setIncidentJobs([]);
  }

  async function loadIncidentAudit(id:string) {
    if (!supabase) return;
    if (auditOpenId===id) { setAuditOpenId(null); return; }
    setAuditOpenId(id); setAuditLoadingId(id);
    setAuditErrorByIncident(prev=>({...prev,[id]:""}));
    try {
      const {data,error:auditError} = await supabase.from("incident_status_history").select("id,incident_id,user_id,previous_status,new_status,changed_at,changed_by").eq("incident_id",id).order("changed_at",{ascending:false}).limit(50);
      if (auditError) {
        setAuditErrorByIncident(prev=>({...prev,[id]:`Could not load status history: ${auditError.message}`}));
        setAuditByIncident(prev=>({...prev,[id]:[]}));
      } else {
        setAuditByIncident(prev=>({...prev,[id]:(data||[]) as IncidentAudit[]}));
      }
    } catch (e) {
      setAuditErrorByIncident(prev=>({...prev,[id]:`Could not load status history: ${e instanceof Error?e.message:"Unknown error"}`}));
      setAuditByIncident(prev=>({...prev,[id]:[]}));
    } finally { setAuditLoadingId(null); }
  }

  async function updateIncident(id:string,status:"acknowledged"|"resolved",review?:{falsePositive:boolean;note:string}) {
    if (!supabase) return;
    const now = new Date().toISOString();
    const patch:Record<string,unknown> = status === "acknowledged" ? {status,acknowledged_at:now} : {status,resolved_at:now};
    if (review) { patch.false_positive = review.falsePositive; patch.resolution_note = review.note.trim().slice(0,500) || null; }
    const {error:updateError} = await supabase.from("incidents").update(patch).eq("id",id);
    if (updateError) setIncidentNotice(missingColumn(updateError) ? "Marking false alarms and saving notes needs database migration 008. Run it in the Supabase SQL editor, then try again." : `Could not update incident: ${updateError.message}`);
    else { setNoteFor(null); setNoteText(""); setIncidentNotice(review?.falsePositive ? "Marked as a false alarm and closed. Thanks: this helps you tune your rules and thresholds." : status === "acknowledged" ? "Incident acknowledged." : "Incident resolved."); await loadIncidents(); if (auditOpenId===id) { setAuditOpenId(null); await loadIncidentAudit(id); } }
  }

  async function authenticate(e:FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!supabase) { setAuthMessage("Supabase is not configured. Check apps/web/.env.local and restart the web server."); return; }
    setAuthBusy(true); setAuthMessage("");
    try {
      if (authMode === "signup") {
        const {data,error:authError} = await supabase.auth.signUp({email,password,options:{emailRedirectTo:window.location.origin}});
        if (authError) throw authError;
        setAuthMessage(data.session ? "Account created and signed in." : "Account created. Check your email to confirm your address, then sign in.");
      } else {
        const {error:authError} = await supabase.auth.signInWithPassword({email,password});
        if (authError) throw authError;
        setAuthMessage("Signed in successfully.");
      }
      setPassword("");
    } catch(err) { setAuthMessage(err instanceof Error ? err.message : "Authentication failed."); }
    finally { setAuthBusy(false); }
  }

  async function signOut() {
    if (!supabase) return;
    const {error:signOutError} = await supabase.auth.signOut();
    if (signOutError) setAuthMessage(signOutError.message);
    else {
      setAuthMessage("Signed out.");
      setSaveNotice("");
      setResult(null);
      setSelectedJobId(null);
      setFile(null);
      setError("");
    }
  }

  async function persistAnalysis(data:Analysis) {
    if (!supabase || !session?.user) { setSaveNotice("Analysis completed, but it was not saved. Sign in to save future analysis results."); return; }
    const {inv} = investigationFor(data);
    const baseJob = {
      user_id:session.user.id, original_filename:data.filename, status:"completed", progress:100,
      duration_seconds:data.duration_seconds, frames_processed:data.frames_processed,
      detections_count:data.detections_count, processing_seconds:data.processing_seconds, average_inference_fps:data.average_inference_fps, completed_at:new Date().toISOString()
    };
    // Summary, tags and settings make saved analyses searchable and reproducible (needs migration 008).
    let {data:job,error:jobError} = await supabase.from("analysis_jobs").insert({...baseJob,summary:summarize(inv),tags:buildTags(inv),run_config:data.run_config??null}).select("id").single();
    if (missingColumn(jobError)) {
      setSchemaV8(false);
      ({data:job,error:jobError} = await supabase.from("analysis_jobs").insert(baseJob).select("id").single());
    }
    if (jobError || !job) { setSaveNotice(`Analysis succeeded, but saving the job failed: ${jobError?.message || "Unknown database error"}`); return; }
    const rows = data.detections.map(d => ({
      job_id:job.id, user_id:session.user.id, event_type:d.label, label:d.label,
      confidence:d.confidence, frame_index:d.frame, timestamp_seconds:d.timestamp_seconds,
      bbox:{x1:d.x1,y1:d.y1,x2:d.x2,y2:d.y2,...(d.color?{color:d.color}:{}),...(data.frame_width&&data.frame_height?{frame_width:data.frame_width,frame_height:data.frame_height}:{})}, track_id:d.track_id
    }));
    for (let i=0; i<rows.length; i+=100) {
      const {error:eventsError} = await supabase.from("detection_events").insert(rows.slice(i,i+100));
      if (eventsError) { setSaveNotice(`Job saved, but some detections could not be saved: ${eventsError.message}. Run the detection-write SQL migration in Supabase, then retry with another clip.`); await loadJobs(); return; }
    }
    // Create an incident only when a class appears in at least half of the sampled frames.
    // This is a transparent persistence heuristic, not person tracking or a restricted-zone rule.
    const framesByClass = new Map<string,Set<number>>();
    for (const detection of data.detections) {
      if (!framesByClass.has(detection.label)) framesByClass.set(detection.label,new Set<number>());
      framesByClass.get(detection.label)!.add(detection.frame);
    }
    const incidentRows = Array.from(framesByClass.entries()).filter(([,frames]) => data.frames_processed > 0 && frames.size / data.frames_processed >= 0.5).map(([label,frames]) => {
      const ratio = frames.size / data.frames_processed;
      const first = data.detections.find(d => d.label === label);
      return {job_id:job.id,user_id:session.user.id,title:`Sustained detection: ${label}`,description:`${label} was detected in ${frames.size} of ${data.frames_processed} analyzed frames (${Math.round(ratio*100)}%). Automatically generated from object detections; review before taking action.`,severity:ratio >= 0.8 ? "high" : "medium",status:"open",event_type:"sustained_detection",occurred_at:new Date((first?.timestamp_seconds || 0)*1000 + Date.now() - data.duration_seconds*1000).toISOString()};
    });
    let incidentMessage = "No sustained-detection incidents met the 50% frame threshold.";
    if (incidentRows.length) {
      // Avoid repeating the same open/acknowledged class alert for the same account within 24 hours.
      const cutoff = new Date(Date.now() - 24*60*60*1000).toISOString();
      const titles = incidentRows.map(row=>row.title);
      const {data:existingIncidents,error:dedupeError} = await supabase.from("incidents").select("title").eq("user_id",session.user.id).in("title",titles).in("status",["open","acknowledged"]).gte("occurred_at",cutoff);
      if (dedupeError) incidentMessage = `Detections saved, but duplicate-check failed: ${dedupeError.message}. No new incidents were created to avoid duplicate alerts.`;
      else {
        const existingTitles = new Set((existingIncidents||[]).map(row=>row.title));
        const newIncidentRows = incidentRows.filter(row=>!existingTitles.has(row.title));
        if (!newIncidentRows.length) incidentMessage = "No new incidents created: matching sustained-detection alerts are already open or acknowledged from the last 24 hours.";
        else {
          const {error:incidentError} = await supabase.from("incidents").insert(newIncidentRows);
          if (incidentError) incidentMessage = `Detections saved, but incident creation failed: ${incidentError.message}. Check the incident-write SQL migration.`;
          else incidentMessage = `Created ${newIncidentRows.length} new sustained-detection incident${newIncidentRows.length===1?"":"s"}${newIncidentRows.length<incidentRows.length?`; skipped ${incidentRows.length-newIncidentRows.length} duplicate alert${incidentRows.length-newIncidentRows.length===1?"":"s"}`:""}.`;
        }
      }
    }
    // Behaviour incidents (possible falls, left-behind or removed objects, crowd changes, running), each with its evidence.
    const nearestKeyframe = (t:number) => (data.keyframes||[]).reduce<Keyframe|null>((best,k)=>Math.abs(k.t-t)<=3&&(!best||Math.abs(k.t-t)<Math.abs(best.t-t))?k:best,null);
    const seenBehaviour = new Set<string>();
    const behaviourRows = inv.behaviour.filter(e=>BEHAVIOUR_INCIDENTS[e.kind]).filter(e=>{const key=`${e.kind}-${e.trackId??e.t}`;if(seenBehaviour.has(key))return false;seenBehaviour.add(key);return true;}).slice(0,10).map(e=>{
      const spec = BEHAVIOUR_INCIDENTS[e.kind], kf = nearestKeyframe(e.t);
      const what = e.label ? `${e.label}${e.trackId!==undefined?` #${e.trackId}`:""}` : `at ${mmss(e.t)}`;
      return {job_id:job.id,user_id:session.user.id,title:`${spec.title}: ${what}`,description:`${e.message} At ${mmss(e.t)} in the clip. Why: ${e.reason} Automatically estimated from detections; review the evidence before taking action.`,severity:spec.severity,status:"open",event_type:e.kind,occurred_at:new Date(e.t*1000 + Date.now() - data.duration_seconds*1000).toISOString(),
        evidence:{t:e.t,track_id:e.trackId??null,reason:e.reason,message:e.message,keyframe:kf?.image??null,keyframe_t:kf?.t??null}};
    });
    if (behaviourRows.length) {
      let {error:behaviourError} = await supabase.from("incidents").insert(behaviourRows);
      if (missingColumn(behaviourError)) { setSchemaV8(false); ({error:behaviourError} = await supabase.from("incidents").insert(behaviourRows.map(({evidence:_e,...row})=>row))); }
      incidentMessage += behaviourError ? ` Behaviour incidents could not be saved: ${behaviourError.message}.` : ` Created ${behaviourRows.length} behaviour incident${behaviourRows.length===1?"":"s"} with evidence.`;
    }
    setSaveNotice(`Saved this analysis and ${rows.length} detections to your account. ${incidentMessage}`);
    setSelectedJobId(job.id);
    await loadJobs(); await loadIncidents();
  }

  /** Search past analyses by what they contain ("person in red", "bag left behind", "cat"), not only by file name. */
  async function searchJobs(e?:FormEvent) {
    e?.preventDefault();
    if (!supabase || !session?.user) return;
    const q = jobQuery.trim();
    if (!q) { setJobResults(null); return; }
    setJobSearching(true);
    const full = await supabase.from("analysis_jobs").select(`${JOB_COLUMNS},run_config,summary,tags`).order("created_at",{ascending:false}).limit(200);
    let data = full.data as Job[]|null, searchError = full.error;
    if (missingColumn(searchError)) {
      setSchemaV8(false);
      const basic = await supabase.from("analysis_jobs").select(JOB_COLUMNS).order("created_at",{ascending:false}).limit(200);
      data = basic.data as Job[]|null; searchError = basic.error;
    }
    setJobSearching(false);
    if (searchError) { setSaveNotice(`Search failed: ${searchError.message}`); return; }
    setJobResults(((data||[]) as Job[]).filter(j=>matchesSearch(q,{filename:j.original_filename,summary:j.summary,tags:j.tags})));
  }

  async function afterDeletion(ids:string[]) {
    if (selectedJobId && ids.includes(selectedJobId)) { setResult(null); setSelectedJobId(null); }
    setJobResults(r=>r?r.filter(j=>!ids.includes(j.id)):r);
    autoRestoreAttempted.current = true;
    await loadJobs(); await loadIncidents();
  }

  /** Delete one saved analysis with its detections and incidents (privacy: nothing is kept that you do not want). */
  async function deleteJob(id:string) {
    if (!supabase) return;
    if (confirmDeleteId !== id) { setConfirmDeleteId(id); return; }
    setConfirmDeleteId(null);
    const {data,error:deleteError} = await supabase.from("analysis_jobs").delete().eq("id",id).select("id");
    if (deleteError) setSaveNotice(`Could not delete: ${deleteError.message}`);
    else if (!data?.length) setSaveNotice("Nothing was deleted. Deleting saved analyses needs database migration 008 (it adds the delete permission).");
    else { setSaveNotice("Deleted the analysis with its detections and incidents."); await afterDeletion([id]); }
  }

  async function applyRetention() {
    if (!supabase || !session?.user) return;
    if (!confirmRetention) { setConfirmRetention(true); return; }
    setConfirmRetention(false);
    const days = Math.max(1, Math.min(3650, Math.round(retentionDays)));
    const cutoff = new Date(Date.now() - days*86400000).toISOString();
    const {data,error:deleteError} = await supabase.from("analysis_jobs").delete().eq("user_id",session.user.id).lt("created_at",cutoff).select("id");
    if (deleteError) setSaveNotice(`Could not apply retention: ${deleteError.message}`);
    else { setSaveNotice(data?.length ? `Deleted ${data.length} analys${data.length===1?"is":"es"} older than ${days} days.` : `No saved analyses are older than ${days} days${schemaV8?"":" (or migration 008, which allows deleting, has not been run)"}.`); if (data?.length) await afterDeletion(data.map(r=>r.id as string)); }
  }

  async function checkApi() {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(),6000);
    const started = performance.now();
    try {
      const r = await fetch(`${API}/health`,{cache:"no-store",signal:controller.signal});
      if (r.ok) { apiFailsRef.current = 0; setApiStatus("online"); setApiLatency(Math.round(performance.now()-started)); }
      else { setApiStatus("offline"); }
    } catch {
      // A sleeping free-tier server answers nothing for up to a minute: call that "waking up", not "offline".
      apiFailsRef.current += 1; setApiStatus(apiFailsRef.current <= 9 ? "waking" : "offline");
    } finally { clearTimeout(timeout); setApiCheckedAt(new Date().toLocaleTimeString()); }
  }
  useEffect(()=>{
    if (apiStatus!=="online") return;
    let active = true;
    fetch(`${API}/ready`,{cache:"no-store"}).then(r=>r.ok?r.json():null).then(d=>{ if(active&&d) setAiInfo({available:!!d.ai_assistant,model:d.ai_model??null}); }).catch(()=>{});
    return ()=>{active=false;};
  },[apiStatus]);
  useEffect(()=>{ let active=true; const check=async()=>{ if(!active)return; await checkApi(); }; void check(); const interval=setInterval(()=>{void check();},10000); return ()=>{active=false;clearInterval(interval);}; },[]);
  async function analyze(e:FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!file) return;
    setBusy(true); setError(""); setSaveNotice(""); setResult(null); setSelectedJobId(null);
    try {
      if (!supabase) throw new Error("Sign in is unavailable because Supabase is not configured.");
      const {data:sessionData,error:sessionError} = await supabase.auth.getSession();
      if (sessionError || !sessionData.session?.access_token) throw new Error("Your session has expired. Please sign in again.");
      const body = new FormData(); body.append("file",file);
      // Never spin forever: the API stops itself after 90 s of inference, so 3 minutes covers upload, a cold start
      // and the response (14 Nov 2026: an analysis on the free server appeared to load indefinitely).
      const controller = new AbortController();
      const timer = setTimeout(()=>controller.abort(), 180_000);
      let response: Response;
      try {
        response = await fetch(`${API}/api/v1/analyze`,{
          method:"POST",body,signal:controller.signal,
          headers:{Authorization:`Bearer ${sessionData.session.access_token}`}
        });
      } catch(e) {
        if (controller.signal.aborted) throw new Error("The analysis took more than 3 minutes, so it was stopped. The free API server may be overloaded or still busy with an earlier clip: wait a minute and try again, or try a shorter clip.");
        throw e;
      } finally { clearTimeout(timer); }
      if (response.status===429) throw new Error("The detector is still busy with another clip (it can take a minute or two on the free server). Please try again shortly.");
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Analysis failed");
      const analysis = data as Analysis;
      analysis.note = (analysis.note || "CPU-based sampled-frame analysis.").replace(/Results are not yet persisted as incidents\.?/i, "Sustained-detection incidents are saved separately when the configured threshold is met.");
      setResult(analysis);
      await persistAnalysis(analysis);
    } catch(err) { setError(err instanceof Error ? err.message : "Could not reach the API"); }
    finally { setBusy(false); }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const clipInvestigation = useMemo(()=>result?investigationFor(result):null,[result,va.setup]);
  const liveInvestigation = useMemo(()=>va.liveInvestigation(),[va.snapshot,va.events,va.liveInvestigation]);

  const timelineBucketCount = 24;
  const trackSummaries = result ? Array.from(result.detections.reduce((map,d)=>{
    if(d.track_id===null||!Number.isFinite(d.track_id)) return map;
    const current=map.get(d.track_id);
    if(current){current.detections.push(d);current.confidenceTotal+=d.confidence;}
    else map.set(d.track_id,{trackId:d.track_id,label:d.label,detections:[d],confidenceTotal:d.confidence});
    return map;
  },new Map<number,{trackId:number;label:string;detections:Detection[];confidenceTotal:number}>()).values()).map(track=>{
    const ordered=[...track.detections].sort((a,b)=>a.timestamp_seconds-b.timestamp_seconds);
    const first=ordered[0],last=ordered[ordered.length-1];
    const center=(d:Detection)=>({x:(d.x1+d.x2)/2,y:(d.y1+d.y2)/2});
    const firstCenter=center(first),lastCenter=center(last);
    return {...track,count:ordered.length,first,last,firstCenter,lastCenter,averageConfidence:track.confidenceTotal/ordered.length,observedSeconds:Math.max(0,last.timestamp_seconds-first.timestamp_seconds),centerDisplacement:Math.hypot(lastCenter.x-firstCenter.x,lastCenter.y-firstCenter.y)};
  }).sort((a,b)=>a.trackId-b.trackId) : [];
  const selectedTrack = trackSummaries.find(track=>track.trackId===selectedTrackId) || null;
  const filteredDetections = result ? result.detections.filter(d=>detectionClassFilter==="all"||d.label===detectionClassFilter).filter(d=>selectedTrackId===null||d.track_id===selectedTrackId).filter(d=>selectedTimelineBucket===null||(()=>{const start=result.duration_seconds*selectedTimelineBucket/timelineBucketCount;const end=result.duration_seconds*(selectedTimelineBucket+1)/timelineBucketCount;return d.timestamp_seconds>=start&&(selectedTimelineBucket===timelineBucketCount-1?d.timestamp_seconds<=end:d.timestamp_seconds<end);})()) : [];
  const timelineBuckets = Array.from({length:timelineBucketCount},(_,index)=>{
    const start = result && result.duration_seconds > 0 ? result.duration_seconds*index/timelineBucketCount : 0;
    const end = result && result.duration_seconds > 0 ? result.duration_seconds*(index+1)/timelineBucketCount : 0;
    const count = result ? result.detections.filter(d=>(detectionClassFilter==="all"||d.label===detectionClassFilter)&&d.timestamp_seconds >= start && (index===timelineBucketCount-1 ? d.timestamp_seconds <= end : d.timestamp_seconds < end)).length : 0;
    return {index,start,end,count};
  });
  const maxTimelineCount = Math.max(1,...timelineBuckets.map(bucket=>bucket.count));

  return <main className="shell">
    <header className="topbar">
      <a className="brand" href="/" onClick={e=>{if(session){e.preventDefault();setTab("overview");window.scrollTo({top:0,behavior:"smooth"});}}}><span className="brand-mark" aria-hidden="true">◉</span><span className="brand-text"><span>Sentinel<span className="muted">Vision</span></span><span className="brand-sub">Real-time AI video intelligence</span></span></a>
      <div className="topbar-right"><div className="status"><span className={`dot ${apiStatus}`} /> {apiStatus==="waking"?"API waking up…":`API ${apiStatus}`}
        <button className="small-button" onClick={()=>void checkApi()}>Check API</button>{apiCheckedAt&&<small style={{display:"block",fontSize:10,color:"var(--muted, #98a2b3)"}}>{apiStatus==="online"&&apiLatency!==null?`${apiLatency} ms · `:""}Checked {apiCheckedAt}</small>}
      </div>
      {session&&<div className="account-chip"><span title={session.user.email||""}>{session.user.email}</span><button className="small-button" onClick={signOut}>Sign out</button></div>}</div>
    </header>
    <div className={authReady && session ? undefined : "landing"}>
    {!(authReady && session) && <section className="hero">
      <div className="eyebrow"><span className="pulse" /> REAL-TIME AI VIDEO INTELLIGENCE</div>
      <h1>See the events<br/><span className="gradient">that matter.</span></h1>
      <p className="hero-copy">Track objects live through your camera, draw zones and counting lines, get rule-based and behaviour alerts, replay what happened, and ask questions about any video, powered by YOLO11 detection and ByteTrack tracking.</p>
      <div className="landing-features"><span><Icon name="target" size={15}/> Live tracking</span><span><Icon name="polygon" size={15}/> Zones and rules</span><span><Icon name="flame" size={15}/> Heatmaps and replay</span><span><Icon name="shield" size={15}/> Incident audit trail</span><span><Icon name="eye" size={15}/> AI investigator</span></div>
    </section>}
    {!(authReady && session) && <section className="auth-panel">
      <div className="auth-heading"><div><span className="step">ACCOUNT</span><h2>{session ? "Your Sentinel Vision account" : "Sign in to access Sentinel Vision"}</h2></div><span className="pill">Secure sign-in</span></div>
      {!supabase && <p className="error">Supabase is not configured. Add your project URL and publishable key to apps/web/.env.local, then restart Next.js.</p>}
      {!authReady && <p className="subcopy">Checking your session…</p>}
      {session && <div className="account-row"><div><strong>{session.user.email}</strong><p className="subcopy">Signed in. Your saved jobs and detections are scoped to your account.</p></div><button className="small-button" onClick={signOut}>Sign out</button></div>}
      {authReady && !session && <form className="auth-form" onSubmit={authenticate}>
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" /></label>
        <label>Password<input type="password" autoComplete={authMode === "signin" ? "current-password" : "new-password"} minLength={6} required value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 6 characters" /></label>
        <button className="primary-button" type="submit" disabled={authBusy || !supabase}>{authBusy ? "Please wait…" : authMode === "signin" ? "Sign in" : "Create account"}</button>
        <button className="auth-switch" type="button" onClick={()=>{setAuthMode(authMode === "signin" ? "signup" : "signin");setAuthMessage("");}}>{authMode === "signin" ? "New here? Create an account" : "Already registered? Sign in"}</button>
      </form>}
      {authMessage && <p className="auth-message">{authMessage}</p>}
      {saveNotice && <p className="save-notice">{saveNotice}</p>}

    </section>}
    </div>
    {authReady && session ? <section className="workspace">
      <nav ref={tabsRef} className="tabs" role="tablist" aria-label="Workspaces">
        <button type="button" role="tab" aria-selected={tab==="overview"} className={`tab${tab==="overview"?" active":""}`} onClick={()=>setTab("overview")}><Icon name="overview" size={16} /> Overview</button>
        <button type="button" role="tab" aria-selected={tab==="live"} className={`tab${tab==="live"?" active":""}`} onClick={()=>setTab("live")}><Icon name="camera" size={16} /> Live operations{(liveRunning||liveStarting)&&<span className="tab-dot" aria-label="camera running" />}</button>
        <button type="button" role="tab" aria-selected={tab==="analyze"} className={`tab${tab==="analyze"?" active":""}`} onClick={()=>setTab("analyze")}><Icon name="film" size={16} /> Analysis studio</button>
        <button type="button" role="tab" aria-selected={tab==="incidents"} className={`tab${tab==="incidents"?" active":""}`} onClick={()=>setTab("incidents")}><Icon name="shield" size={16} /> Incidents<span className="tab-count">{incidents.filter(i=>i.status!=="resolved").length} active</span></button>
      </nav>
      <div hidden={tab!=="overview"}>
        <CommandCenter
          jobs={jobs}
          incidents={incidents}
          apiStatus={apiStatus}
          apiLatencyMs={apiLatency}
          live={{running:liveRunning,frames:liveFrames,processedMs:liveProcessedMs,objects:liveDetections.length,tracks:Object.keys(liveTrackCounts).length}}
          setup={{zones:va.setup.zones.length,lines:va.setup.lines.length,rules:va.setup.rules.length,alerts:va.events.length}}
          onOpenJob={(job)=>{void loadSavedAnalysis(job);setTab("analyze");}}
          onGoto={setTab}
          onStartLive={()=>void startLiveCamera()}
        />
      </div>
      <div className="panel live-panel" hidden={tab!=="live"}>
        <div className="panel-heading"><div><span className="step">LIVE</span><h2>Live operations</h2></div><span className="pill">{liveStarting?"Starting":liveRunning?(liveFrames===0?"Waiting for first frame":liveError?"Reconnecting":"Live") : "Stopped · last results retained"}</span></div>
        <p className="subcopy">Track objects through your webcam in near real time. Draw zones and counting lines on the video and add alert rules. Frames are sent to the detector for inference only; they are not recorded or saved to your account.</p>
        <div className="live-layout">
          <div className="live-main">
            <canvas ref={liveCanvasRef} style={{display:"none"}} />
            <OverlayStage
              live={liveRunning}
              width={va.frameSize.width}
              height={va.frameSize.height}
              zones={va.setup.zones}
              lines={va.setup.lines}
              paths={liveRunning?(va.snapshot?.paths??[]):[]}
              heat={showHeat?va.heat:null}
              heatOpacity={0.7}
              zoneCounts={va.snapshot?.zoneCounts}
              lineCounts={va.snapshot?.lineCounts}
              showZones={showZones}
              showTrails={showTrails}
              mode={va.mode}
              onZoneDrawn={va.addZone}
              onLineDrawn={va.addLine}
              onCancelDraw={()=>va.setMode("view")}
              ariaLabel="Live camera with zones, counting lines and motion trails"
            >
              <video ref={liveVideoRef} className="stage-media" muted playsInline autoPlay style={{display:liveRunning?"block":"none"}} />
              {liveRunning && liveFrame && <img className="stage-media" src={liveFrame} alt="Latest live webcam frame annotated with detected objects and track IDs" style={{pointerEvents:"none"}} />}
              {!liveRunning && <div className="stage-empty"><strong>Camera is stopped</strong><span>Start the camera to begin live detection. Zones and lines you draw are remembered.</span></div>}
              {liveRunning && liveFrames===0 && <div className="stage-hint" role="status"><span className="hint-dot" aria-hidden="true"/><div><strong>{liveError?"The detector is starting up":"Connecting to the detector"}</strong><span>After the server wakes up, the detector needs about a minute to load. This happens once per wake-up; the first results appear by themselves.</span></div></div>}
              {liveRunning && <span className="live-badge"><i />LIVE</span>}
            </OverlayStage>
            <div className="live-toolbar">
              {!liveRunning
                ? <button type="button" className="primary-button" style={{width:"auto",margin:0,padding:"10px 18px"}} onClick={()=>void startLiveCamera()} disabled={liveStarting}>{liveStarting?<><span className="spinner"/> Starting camera…</>:<><Icon name="camera" size={16}/> Start live camera</>}</button>
                : <button type="button" className="primary-button" style={{width:"auto",margin:0,padding:"10px 18px"}} onClick={stopLiveCamera}>Stop camera</button>}
              <button type="button" className={`small-button${showTrails?" is-on":""}`} onClick={()=>setShowTrails(v=>!v)}><Icon name="route" size={15}/> Trails</button>
              <button type="button" className={`small-button${showHeat?" is-on":""}`} onClick={()=>setShowHeat(v=>!v)}><Icon name="flame" size={15}/> Heatmap</button>
              <button type="button" className={`small-button${showZones?" is-on":""}`} onClick={()=>setShowZones(v=>!v)}><Icon name="polygon" size={15}/> Zones</button>
              {liveRunning&&<button type="button" className="small-button" onClick={()=>{setLiveTrackCounts({});setLiveFrames(0);liveSeenTrackIdsRef.current=new Set();resetAnalyticsSession();setLiveEvents(old=>[{id:`reset-${Date.now()}`,time:new Date().toLocaleTimeString(),message:"Session counters and new-track alerts reset.",kind:"system" as const},...old].slice(0,20));}}>Reset stats</button>}
            </div>
            <div className="live-kpis">
              <div className="metric"><span>Objects now</span><strong>{liveDetections.length}</strong></div>
              <div className="metric"><span>Tracks observed</span><strong>{Object.keys(liveTrackCounts).length}</strong></div>
              <div className="metric"><span>API latency</span><strong>{liveRunning?`${liveProcessedMs.toFixed(0)} ms`:"—"}</strong></div>
              <div className="metric"><span>Frames analyzed</span><strong>{liveFrames}</strong></div>
            </div>
            {liveError&&!(liveFrames===0&&/starting up/i.test(liveError))&&<div className="error">{liveError}</div>}
            {!liveRunning&&(liveDetections.length>0||liveLastFrameAt)&&<p className="subcopy" style={{margin:0}}>Showing stale session results from {liveLastFrameAt||"the last camera run"}; these are not current live detections.</p>}
            {liveRunning&&liveError&&<p className="subcopy" style={{margin:0}}>Latest successful frame: {liveLastFrameAt||"none yet"}. Results may be stale until the connection recovers.</p>}
            <p className="privacy-note" style={{margin:0}}>Tracking IDs are temporary and may change if objects disappear or tracking is restarted. Browser camera permission is required. The hosted demo runs on a small shared CPU, so expect a few frames per second.</p>
            {(liveRunning||liveLastFrameAt)&&<p className="live-diag" aria-live="polite"><span><b>Status</b> {!liveRunning?"Stopped":liveFrames===0?"Waiting for first frame":liveError?"Retrying":"Connected"}</span><span><b>Last frame</b> {liveLastFrameAt||"—"}</span><span><b>Speed</b> {liveRunning?`${liveFps.toFixed(1)} FPS`:"—"}</span><span><b>Frame size</b> {liveSendWidth}px, adjusts to server speed</span></p>}
            <details className="fold"><summary>Ask about this session</summary><div>
              <Investigator compact inv={liveInvestigation} api={API} getToken={getToken} ai={aiInfo} />
            </div></details>
            <details className="fold"><summary>Current detections ({liveDetections.length})</summary><div>
              {!liveDetections.length?<p className="subcopy" style={{margin:0}}>No objects detected in the latest frame, or the camera has not started.</p>:<div className="class-list">{liveDetections.map((d,i)=><div className="class-row" key={`${d.track_id}-${d.label}-${i}`}><span>{d.label}{d.track_id!==null?` · Track #${d.track_id}`:" · untracked"}</span><strong>{(d.confidence*100).toFixed(1)}%</strong></div>)}</div>}
            </div></details>
            <details className="fold"><summary>Session events ({liveEvents.length})</summary><div>
              {!liveEvents.length?<p className="subcopy" style={{margin:0}}>Camera starts, new tracks, and connection changes will appear here.</p>:<div className="class-list">{liveEvents.slice(0,10).map(event=><div className="class-row" key={event.id}><span><strong>{event.kind==="warning"?"Connection warning":event.kind==="track"?"New track":"Session event"}</strong><small style={{display:"block",color:"var(--muted, #98a2b3)"}}>{event.time} · {event.message}</small></span><span className="pill">{event.kind}</span></div>)}</div>}
            </div></details>
            <details className="fold"><summary>Tracks this session ({Object.keys(liveTrackCounts).length})</summary><div>
              {!Object.keys(liveTrackCounts).length?<p className="subcopy" style={{margin:0}}>Track summaries appear after objects are detected.</p>:<div className="class-list">{Object.entries(liveTrackCounts).sort((a,b)=>Number(a[0])-Number(b[0])).map(([id,t])=><div className="class-row" key={id}><span><strong>#{id}</strong> · {t.label}<small style={{display:"block",color:"var(--muted, #98a2b3)"}}>{t.count} frame observations · {(t.confidenceTotal/t.count*100).toFixed(1)}% avg. confidence</small></span><span className="pill">{liveRunning&&!liveError?"Seen this session":"Last seen"}</span></div>)}</div>}
            </div></details>
          </div>
          <div className="live-side">
            <div className="card"><SetupPanel va={va} /></div>
          </div>
        </div>
      </div>
      <div className="analyze" hidden={tab!=="analyze"}>
      <div className="analyze-top">
      <div className="panel analyze-upload">
        <div className="panel-heading"><div><span className="step">01</span><h2>Analyze footage</h2></div><span className="pill">CPU inference</span></div>
        <p className="subcopy">Upload a short MP4, MOV, AVI, MKV, or WebM clip. Limits: {MAX_UPLOAD_MB} MB and {MAX_VIDEO_SECONDS} seconds.</p>
        <form onSubmit={analyze}>
          <label className="dropzone"><span className="upload-icon">↑</span>
            <strong>{file ? file.name : "Choose a video file"}</strong>
            <span>{file ? `${(file.size/1024/1024).toFixed(2)} MB` : "Click to browse · Keep clips short"}</span>
            <input type="file" accept="video/*,.mkv" onChange={e=>{setFile(e.target.files?.[0]||null);setResult(null);setError("");setSaveNotice("");}}/>
          </label>
          <button className="primary-button" type="submit" disabled={!file||busy||liveRunning||liveStarting}>{busy?<><span className="spinner"/> Analyzing video…</>:"Run AI analysis"} <span>↗</span></button>
        </form>
        {(liveRunning||liveStarting)&&<p className="subcopy">Stop the live camera to run an analysis: uploads and live tracking share one detector.</p>}
        {error&&<div className="error">{error}</div>}
        <div className="privacy-note"><span>◈</span> Video clips are processed temporarily. Saved analyses retain metadata and detection coordinates, not the original video file or annotated preview.</div>
        {saveNotice && <p className="save-notice">{saveNotice}</p>}
      </div>
      <div className="panel analyze-saved"><div className="saved-jobs">
        {!jobs.length&&!jobResults ? <><h3>Saved analyses</h3><div className="saved-empty"><Icon name="clock" size={18}/><strong>No saved analyses yet</strong><span>Every clip you analyse is saved here with its detections, so you can reopen the report, search it by content (for example “bag left behind”) and delete old ones.</span></div></> : <>
        <h3>{jobResults ? `Search results (${jobResults.length})` : "Recent saved analyses"}</h3>
        <form className="job-search" onSubmit={e=>void searchJobs(e)}>
          <input value={jobQuery} onChange={e=>{setJobQuery(e.target.value); if(!e.target.value.trim()) setJobResults(null);}} placeholder="Search by content, e.g. “person in red”, “bag left behind”" aria-label="Search saved analyses" />
          <button className="small-button" type="submit" disabled={jobSearching}>{jobSearching?"Searching…":"Search"}</button>
          {jobResults&&<button className="small-button" type="button" onClick={()=>{setJobQuery("");setJobResults(null);}}>Clear</button>}
        </form>
        {jobResults&&!jobResults.length&&<p className="subcopy" style={{margin:"4px 0"}}>No saved analysis matches. {schemaV8?"Analyses saved before this update can only be found by file name.":"Run database migration 008 to search by content; until then only file names are searched."}</p>}
        <div className="saved-list">{(jobResults??jobs).map(job=><div className="saved-job" key={job.id}><span><strong>{job.original_filename}</strong><small>{new Date(job.created_at).toLocaleString()}</small>{job.summary&&<small title={job.summary}>{job.summary.length>120?job.summary.slice(0,118)+"…":job.summary}</small>}</span><span>{job.detections_count} detections · {job.status}</span><span style={{display:"flex",gap:6}}><button className="small-button" type="button" disabled={loadingSavedJob} onClick={()=>void loadSavedAnalysis(job)}>{loadingSavedJobId===job.id ? "Loading…" : selectedJobId===job.id ? "Viewing" : "Open report"}</button><button className={`small-button${confirmDeleteId===job.id?" danger":""}`} type="button" onClick={()=>void deleteJob(job.id)} onBlur={()=>setConfirmDeleteId(c=>c===job.id?null:c)} title="Delete this analysis, its detections and incidents">{confirmDeleteId===job.id?"Confirm delete":<Icon name="trash" size={14}/>}</button></span></div>)}</div>
        <div className="retention"><Icon name="clock" size={14}/> Data retention: delete analyses older than <input type="number" min={1} max={3650} value={retentionDays} onChange={e=>{setRetentionDays(Number(e.target.value));setConfirmRetention(false);}} aria-label="Days to keep analyses"/> days <button type="button" className={`small-button${confirmRetention?" danger":""}`} onClick={()=>void applyRetention()} onBlur={()=>setConfirmRetention(false)}>{confirmRetention?"Confirm: delete permanently":"Apply now"}</button></div>
        </>}
      </div></div>
      </div>
      <div className="panel analyze-report">
        <div className="panel-heading"><div><span className="step">02</span><h2>Analysis report</h2></div><span className="pill">{busy?"Processing":result?(selectedJobId?"Saved report":"Complete"):"Awaiting video"}</span></div>
        {!result&&!busy&&!loadingSavedJob&&<div className="empty-state"><div className="empty-icon">⌁</div><strong>{jobs.length ? "Choose a saved analysis or upload a video" : "Your results will appear here"}</strong><p>{jobs.length ? "Your most recent saved analysis is restored automatically when available. Choose any saved report above, or run a new analysis." : "No saved analyses yet. Upload a video and run an analysis to see detected objects and performance metrics."}</p></div>}
        {loadingSavedJob&&<div className="empty-state"><span className="spinner large"/><strong>Loading saved report</strong><p>Restoring saved detections and metadata from your account.</p></div>}
        {busy&&<div className="empty-state"><span className="spinner large"/><strong>Processing on CPU</strong><p>The first request may take longer while model weights load.</p></div>}
        {result&&<div className="results">
          <div className="metrics">
            <div className="metric"><span>Detections</span><strong>{result.detections_count}</strong></div>
            <div className="metric"><span>Frames processed</span><strong>{result.frames_processed}</strong></div>
            <div className="metric"><span>Inference FPS</span><strong>{result.average_inference_fps == null ? "N/A" : result.average_inference_fps}</strong></div>
            <div className="metric"><span>Processing time</span><strong>{result.processing_seconds == null ? "N/A" : `${result.processing_seconds}s`}</strong></div>
          </div>
          <div className="result-meta"><span>{result.filename}</span><span>{result.duration_seconds}s video</span></div>
          {/* Two balanced columns: what happened (visuals, tracks, activity) beside the AI Investigator (13 Nov 2026) */}
          <div className={`report-cols${clipInvestigation?"":" single"}`}><div className="report-col">
          {result.preview_image&&<div className="preview-block"><h3>Detection preview</h3><p className="subcopy">Bounding boxes and labels from the first analyzed frame.</p><img className="detection-preview" src={result.preview_image} alt="First analyzed video frame with AI detection boxes" /></div>}
          <AnalysisVisuals detections={result.detections} va={va} frameSize={result.frame_width&&result.frame_height?{width:result.frame_width,height:result.frame_height}:null} />
          {!clipInvestigation&&<>
          <h3>Detected classes</h3>
          {!Object.keys(result.class_counts).length?<p className="subcopy">No objects above the confidence threshold were detected.</p>:
            <div className="class-list">{Object.entries(result.class_counts).sort((a,b)=>b[1]-a[1]).map(([label,count])=><div className="class-row" key={label}><span>{label}</span><strong>{count}</strong></div>)}</div>}
          </>}
          <div className="tracking-summary" style={{margin:"18px 0",padding:16,border:"1px solid var(--border, #293244)",borderRadius:14,background:"rgba(127,140,160,0.045)"}}>
            <h3 style={{marginTop:0,marginBottom:6}}>Object tracking</h3>
            <p className="subcopy" style={{margin:0}}>{trackSummaries.length} unique track{trackSummaries.length===1?"":"s"} detected · {result.detections.filter(d=>d.track_id!==null).length} detection{result.detections.filter(d=>d.track_id!==null).length===1?"":"s"} linked to a track. IDs are estimated within this clip and may split when objects are occluded or missed.</p>
            {trackSummaries.length>0&&<>
              <h4 className="sub-heading">Track details</h4>
              <p className="subcopy" style={{marginTop:0}}>Select a track to inspect its observation history and movement estimate. Selecting a track also filters the detection table.</p>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:10}}>
                {trackSummaries.map(track=><button key={track.trackId} type="button" aria-pressed={selectedTrackId===track.trackId} onClick={()=>setSelectedTrackId(selectedTrackId===track.trackId?null:track.trackId)} style={{textAlign:"left",padding:12,borderRadius:12,border:selectedTrackId===track.trackId?"2px solid #70e1bd":"1px solid var(--border, #293244)",background:selectedTrackId===track.trackId?"rgba(112,225,189,.10)":"var(--panel, rgba(127,140,160,.04))",color:"inherit",cursor:"pointer"}}><span style={{display:"block",fontSize:12,color:"var(--muted, #98a2b3)"}}>TRACK #{track.trackId}</span><strong style={{display:"block",marginTop:3}}>{track.label}</strong><span style={{display:"block",marginTop:5,fontSize:12}}>{track.count} detections · {(track.averageConfidence*100).toFixed(1)}% avg.</span></button>)}
              </div>
              {selectedTrack&&<div style={{marginTop:12,padding:14,border:"1px solid rgba(112,225,189,.45)",borderRadius:12,background:"rgba(112,225,189,.055)"}}>
                <div style={{display:"flex",alignItems:"start",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}><div><h4 style={{margin:"0 0 4px"}}>Track #{selectedTrack.trackId} · {selectedTrack.label}</h4><p className="subcopy" style={{margin:0}}>Observed from {selectedTrack.first.timestamp_seconds.toFixed(2)}s to {selectedTrack.last.timestamp_seconds.toFixed(2)}s</p></div><button type="button" className="small-button" onClick={()=>setSelectedTrackId(null)}>Clear selected track</button></div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(145px,1fr))",gap:12,marginTop:14}}>
                  <div><span className="subcopy">Detections</span><strong style={{display:"block",fontSize:20}}>{selectedTrack.count}</strong></div>
                  <div><span className="subcopy">Average confidence</span><strong style={{display:"block",fontSize:20}}>{(selectedTrack.averageConfidence*100).toFixed(1)}%</strong></div>
                  <div><span className="subcopy">First / last frame</span><strong style={{display:"block",fontSize:16}}>{selectedTrack.first.frame} / {selectedTrack.last.frame}</strong></div>
                  <div><span className="subcopy">Observed duration</span><strong style={{display:"block",fontSize:20}}>{selectedTrack.observedSeconds.toFixed(2)}s</strong></div>
                  <div><span className="subcopy">Center displacement</span><strong style={{display:"block",fontSize:20}}>{selectedTrack.centerDisplacement.toFixed(1)} px</strong></div>
                </div>
                <p className="subcopy" style={{marginBottom:0,marginTop:12}}>First center: ({selectedTrack.firstCenter.x.toFixed(1)}, {selectedTrack.firstCenter.y.toFixed(1)}) px · Last center: ({selectedTrack.lastCenter.x.toFixed(1)}, {selectedTrack.lastCenter.y.toFixed(1)}) px. Displacement is the straight-line change between first and last observed box centers, not a physical-world distance.</p>
              </div>}
            </>}
          </div>
          <div className="timeline-block" style={{margin:"22px 0 26px",padding:18,border:"1px solid var(--border, #293244)",borderRadius:16,background:"rgba(127,140,160,0.045)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:12,flexWrap:"wrap"}}><h3 style={{margin:0}}>Detection activity timeline</h3><span className="subcopy">{timelineBucketCount} time intervals · {result.detections.length} saved detections</span></div>
            <p className="subcopy" style={{marginTop:6}}>Select a bar to inspect detections in that time interval. The chart respects the object-class filter below.</p>
            <div aria-label={`Interactive detection activity across ${result.duration_seconds} seconds`} style={{display:"grid",gridTemplateColumns:`repeat(${timelineBucketCount}, minmax(0, 1fr))`,alignItems:"end",gap:4,height:112,marginTop:16,paddingTop:8}}>
              {timelineBuckets.map(bucket=><button type="button" key={bucket.index} aria-pressed={selectedTimelineBucket===bucket.index} aria-label={`${bucket.start.toFixed(2)} to ${bucket.end.toFixed(2)} seconds, ${bucket.count} detections`} title={`${bucket.start.toFixed(2)}s–${bucket.end.toFixed(2)}s: ${bucket.count} detections · Select interval`} onClick={()=>setSelectedTimelineBucket(selectedTimelineBucket===bucket.index?null:bucket.index)} style={{height:"100%",display:"flex",flexDirection:"column",justifyContent:"flex-end",alignItems:"stretch",minWidth:0,padding:0,border:0,cursor:"pointer",background:"transparent",outline:selectedTimelineBucket===bucket.index?"2px solid #70e1bd":"none",outlineOffset:2,borderRadius:5}}><span style={{height:`${Math.max(bucket.count ? 7 : 2,bucket.count/maxTimelineCount*100)}%`,minHeight:2,borderRadius:"5px 5px 2px 2px",background:bucket.count?"linear-gradient(180deg, #70e1bd, #477be8)":"rgba(127,140,160,0.22)",opacity:bucket.count?0.95:0.65}} /></button>)}
            </div>
            <div style={{display:"flex",justifyContent:"space-between",gap:8,marginTop:8,fontSize:12,color:"var(--muted, #98a2b3)"}}><span>0.00s</span><span>{(result.duration_seconds/2).toFixed(2)}s</span><span>{result.duration_seconds.toFixed(2)}s</span></div>
          </div>
          </div>
          {clipInvestigation&&<div className="report-col">
            <Investigator key={`${selectedJobId||"new"}-${result.filename}-${result.detections_count}`} inv={clipInvestigation.inv} keyframes={result.keyframes||[]} frames={clipInvestigation.frames} api={API} getToken={getToken} ai={aiInfo} />
            <h3>Detected classes</h3>
            {!Object.keys(result.class_counts).length?<p className="subcopy">No objects above the confidence threshold were detected.</p>:
              <div className="class-list">{Object.entries(result.class_counts).sort((a,b)=>b[1]-a[1]).map(([label,count])=><div className="class-row" key={label}><span>{label}</span><strong>{count}</strong></div>)}</div>}
          </div>}
          </div>
          <div style={{display:"flex",alignItems:"end",justifyContent:"space-between",gap:12,flexWrap:"wrap",marginTop:18}}><div><h3 style={{marginBottom:4}}>Detection samples</h3><p className="subcopy" style={{margin:0}}>Filter by object class or select a timeline interval. Bounding boxes and confidence values come from saved detector output.</p></div><label className="field-label" style={{minWidth:190}}>Object class<select value={detectionClassFilter} onChange={e=>{setDetectionClassFilter(e.target.value);setSelectedTimelineBucket(null);}} style={{display:"block",width:"100%",marginTop:6,padding:"10px 12px",borderRadius:10,border:"1px solid var(--border, #293244)",background:"var(--panel, #101827)",color:"inherit"}}><option value="all">All classes</option>{Object.keys(result.class_counts).sort().map(label=><option key={label} value={label}>{label}</option>)}</select></label></div>
          {(detectionClassFilter!=="all"||selectedTimelineBucket!==null||selectedTrackId!==null)&&<div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",margin:"12px 0"}}><span className="pill">{detectionClassFilter==="all"?"All classes":detectionClassFilter}{selectedTimelineBucket!==null?` · ${timelineBuckets[selectedTimelineBucket].start.toFixed(2)}–${timelineBuckets[selectedTimelineBucket].end.toFixed(2)}s`:""}{selectedTrackId!==null?` · Track #${selectedTrackId}`:""}</span><button type="button" className="small-button" onClick={()=>{setDetectionClassFilter("all");setSelectedTimelineBucket(null);setSelectedTrackId(null);}}>Clear filters</button></div>}
          <p className="subcopy">Showing {Math.min(filteredDetections.length,12)} of {filteredDetections.length} matching detections.</p>
          <div className="table-wrap"><table><thead><tr><th>Time</th><th>Frame</th><th>Track ID</th><th>Object</th><th>Bounding box (x1, y1 → x2, y2)</th><th>Confidence</th></tr></thead><tbody>
            {filteredDetections.slice(0,12).map((d,i)=><tr key={`${d.frame}-${d.label}-${i}`}><td>{d.timestamp_seconds.toFixed(2)}s</td><td>{d.frame}</td><td>{d.track_id===null?"—":<button type="button" className="small-button" aria-label={`Inspect track ${d.track_id}`} onClick={()=>setSelectedTrackId(d.track_id)} style={{padding:"3px 7px"}}>#{d.track_id}</button>}</td><td>{d.label}</td><td style={{whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"}}>{d.x1.toFixed(1)}, {d.y1.toFixed(1)} → {d.x2.toFixed(1)}, {d.y2.toFixed(1)}</td><td><div style={{display:"flex",alignItems:"center",gap:8,minWidth:100}}><span style={{minWidth:44}}>{(d.confidence*100).toFixed(1)}%</span><span aria-hidden="true" style={{display:"block",height:6,width:64,overflow:"hidden",borderRadius:99,background:"rgba(127,140,160,0.2)"}}><span style={{display:"block",height:"100%",width:`${Math.max(0,Math.min(100,d.confidence*100))}%`,borderRadius:99,background:"#70e1bd"}} /></span></div></td></tr>)}
            {filteredDetections.length===0&&<tr><td colSpan={6}>No detections match these filters. Clear filters or select another interval.</td></tr>}
          </tbody></table></div>
          <p className="footnote">{result.note}</p>
        </div>}
      </div>
      </div>
      <section className="panel incidents-panel" hidden={tab!=="incidents"}>
        <div className="panel-heading"><div><span className="step">03</span><h2>Incident management</h2></div><span className="pill">{incidents.filter(i=>i.status!=="resolved").length} active</span></div>
        <p className="subcopy">Incidents come from uploaded clips: an object class seen in at least 50% of analysed frames (high severity at 80%), and behaviour alerts such as possible falls or objects left behind, each with its evidence. They are review cues, not proof of a security event. Mark wrong ones as false alarms.</p>
        {!schemaV8&&<p className="save-notice" style={{color:"var(--amber)"}}>Run database migration 008 in Supabase to keep evidence frames with incidents, mark false alarms, search analyses by content and delete old analyses.</p>}
        {incidentNotice && <p className="save-notice">{incidentNotice}</p>}
        <div className="incident-filters" style={{display:"flex",gap:8,flexWrap:"wrap",margin:"14px 0"}}>{(["all","open","acknowledged","resolved"] as const).map(status=><button key={status} type="button" className="small-button" aria-pressed={incidentFilter===status} onClick={()=>setIncidentFilter(status)} style={{opacity:incidentFilter===status?1:.65,fontWeight:incidentFilter===status?700:400}}>{status==="all"?`All (${incidents.length})`:`${status[0].toUpperCase()+status.slice(1)} (${incidents.filter(i=>i.status===status).length})`}</button>)}</div>
        {incidents.length===0 ? <div className="empty-state"><strong>No incidents yet</strong><p>Analyze a clip to create sustained-detection incidents, or check your Supabase incident-write policy.</p></div> : (()=>{const visible=incidents.filter(i=>incidentFilter==="all"||i.status===incidentFilter);const groups=Array.from(visible.reduce((map,i)=>{const key=i.job_id||"unknown";if(!map.has(key))map.set(key,[]);map.get(key)!.push(i);return map;},new Map<string,Incident[]>()));return visible.length===0?<div className="empty-state"><strong>No {incidentFilter} incidents</strong><p>Choose another status filter to see more incidents.</p></div>:<div className="incident-groups">{groups.map(([jobId,items],groupIndex)=>{const job=jobs.find(j=>j.id===jobId)||incidentJobs.find(j=>j.id===jobId);return <details key={jobId} className="incident-group" open={groupIndex===0}><summary className="incident-group-heading"><div><h3 style={{marginBottom:4}}>{job?.original_filename||"Saved analysis"}</h3><small>{items.length} incident{items.length===1?"":"s"} · {items.filter(i=>i.status==="open").length} open · {new Date(items[0].occurred_at).toLocaleString()}</small></div>{job&&<button className="small-button" type="button" disabled={loadingSavedJob} onClick={()=>void loadSavedAnalysis(job)}>{loadingSavedJobId===job.id?"Loading…":selectedJobId===job.id?"Viewing report":"Open analysis report"}</button>}</summary><div className="incident-list">{items.map(incident=><article className="incident-card" key={incident.id}><div className="incident-top"><div><span className={`incident-severity ${incident.severity}`}>{incident.severity}</span><h3>{incident.title}</h3></div><span className={`incident-status ${incident.status}`}>{incident.status}</span></div>{incident.description&&<p title={incident.description}>{(()=>{const first=incident.description.split(". ")[0];return first.endsWith(".")?first:first+".";})()}</p>}{incident.evidence&&<div className="incident-evidence">{incident.evidence.keyframe&&<img src={incident.evidence.keyframe} alt={`Evidence frame near ${mmss(incident.evidence.keyframe_t??incident.evidence.t)}`}/>}<span><strong>Evidence:</strong> {mmss(incident.evidence.t)} in the clip{incident.evidence.track_id!=null?` · track #${incident.evidence.track_id}`:""}. {incident.evidence.reason}</span></div>}{incident.false_positive&&<span className="false-alarm">False alarm</span>}{incident.resolution_note&&<p className="subcopy" style={{margin:"6px 0"}}>Note: {incident.resolution_note}</p>}<small>{new Date(incident.occurred_at).toLocaleString()}</small><div className="incident-actions">{incident.status==="open"&&<button className="small-button" onClick={()=>void updateIncident(incident.id,"acknowledged")}>Acknowledge</button>}{incident.status!=="resolved"&&<button className="small-button" onClick={()=>void updateIncident(incident.id,"resolved",noteFor===incident.id&&noteText.trim()?{falsePositive:false,note:noteText}:undefined)}>Resolve</button>}{incident.status!=="resolved"&&<button className="small-button" type="button" onClick={()=>{setNoteFor(noteFor===incident.id?null:incident.id);setNoteText("");}}>{noteFor===incident.id?"Cancel":"False alarm…"}</button>}<button className="small-button" type="button" onClick={()=>void loadIncidentAudit(incident.id)}>{auditLoadingId===incident.id?"Loading history…":auditOpenId===incident.id?"Hide audit history":"View audit history"}</button></div>{noteFor===incident.id&&<div><input className="note-input" value={noteText} onChange={e=>setNoteText(e.target.value)} maxLength={500} placeholder="Optional note, e.g. “staff member's bag”, “reflection on the glass”" aria-label="Review note"/><div className="incident-actions"><button className="small-button danger" type="button" onClick={()=>void updateIncident(incident.id,"resolved",{falsePositive:true,note:noteText})}>Mark as false alarm and close</button></div><p className="subcopy" style={{margin:"4px 0 0"}}>If the same false alarm keeps coming back, raise the threshold or switch that behaviour off in Live operations → Behaviour alerts.</p></div>}{auditOpenId===incident.id&&<div style={{marginTop:10,padding:12,border:"1px solid var(--border, #334155)",borderRadius:8}}><strong>Status change history</strong><p className="subcopy" style={{margin:"6px 0",overflowWrap:"anywhere"}}>Incident ID: <code>{incident.id}</code></p>{auditLoadingId===incident.id?<p className="subcopy">Loading history…</p>:auditErrorByIncident[incident.id]?<p role="alert" style={{marginBottom:0}}>{auditErrorByIncident[incident.id]}</p>:(auditByIncident[incident.id]||[]).length===0?<p className="subcopy" style={{marginBottom:0}}>No status changes have been recorded for this incident yet.</p>:<ol style={{paddingLeft:20,marginBottom:0}}>{(auditByIncident[incident.id]||[]).map(entry=><li key={entry.id} style={{marginBottom:8}}><strong>{entry.previous_status} → {entry.new_status}</strong><div className="subcopy">{formatAuditTimestamp(entry.changed_at)} · User {entry.user_id.slice(0,8)}{entry.changed_by&&entry.changed_by!==entry.user_id?` · Actor ${entry.changed_by.slice(0,8)}`:""}</div></li>)}</ol>}</div>}</article>)}</div></details>})}</div>})()}
      </section>
    </section> : <section className="panel access-panel">
      <div className="panel-heading"><div><span className="step">ACCESS</span><h2>{authReady ? "Sign in to access video analysis" : "Checking account access"}</h2></div><span className="pill">Account required</span></div>
      <p className="subcopy">{authReady ? "Create a Sentinel Vision account or sign in above to upload footage, run AI analysis, and view your reports. Your saved analyses remain associated with your account." : "Please wait while we verify your session."}</p>
    </section>}
    <footer><span>SENTINEL VISION · EARLY ACCESS</span><span>Built for measurable, responsible AI</span></footer>
  </main>;
}
