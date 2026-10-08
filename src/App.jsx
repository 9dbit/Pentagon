import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  RefreshCw, ShieldAlert, CheckCircle, AlertTriangle, Ban, Lock, LogOut,
  Settings, Send, Download, Trash2, Pencil, Power, Search, Radio, Bell,
  FolderKanban, BarChart3, Plus, Globe2, Server, Sparkles, Network, Shield, Users, ShieldCheck
} from "lucide-react";
import "./style.css";
import "./dashboard-patches.css";
import DefenseCenterPage from "./DefenseCenterPage";
import AnalyticsPage from "./AnalyticsPage";
import DomainPopup from "./DomainPopup";
import TrustPositifPage from "./TrustPositifPage";

async function api(url, opt = {}) {
  const res = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opt });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) { const err = new Error(data.error || "Request failed"); err.status = res.status; throw err; }
  return data;
}

function emailInitials(email) {
  const user = (email || "").split("@")[0] || "?";
  const first = user[0] || "?";
  const second = (user.slice(1).match(/[._+\-]([a-z\d])/i) || [])[1] || user[1] || "";
  return (first + second).toUpperCase().slice(0, 2);
}
function emailHue(email) {
  let h = 0;
  for (let i = 0; i < (email || "").length; i++) h = (h * 31 + email.charCodeAt(i)) & 0xffff;
  return h % 360;
}
function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  try { return code.toUpperCase().split('').map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join(''); } catch(_) { return ''; }
}

function statusLabel(s) { if (s === "working") return "Normal"; if (s === "warning") return "Warning"; if (s === "blocked") return "Blocked"; if (s === "unknown") return "Unknown"; return s || "unknown"; }
function Badge({ status }) { return <span className={`badge ${status || "unknown"}`}>{statusLabel(status)}</span>; }
function formatPendingStatus(s) { if (!s) return "-"; const m = String(s).match(/^pending:([^:]+):(\d+)\/(\d+)$/); if (m) return <span className="muted" style={{fontSize:"11px"}}>⏳ Confirming ({m[2]}/{m[3]})</span>; return s; }
function relativeTime(ts) { if (!ts) return "Never"; const diff = Date.now() - new Date(ts).getTime(); if (diff < 0) return new Date(ts).toLocaleString(); const mins = Math.floor(diff / 60000); if (mins < 1) return "Just now"; if (mins < 60) return `${mins} min ago`; const hrs = Math.floor(mins / 60); if (hrs < 24) return `${hrs} hr ago`; return new Date(ts).toLocaleString(); }
function HealthBadge({ status }) { return <span className={`healthBadge ${status || "unknown"}`}><i />{status || "unknown"}</span>; }
function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

function BatteryGauge({ percent }) {
  const pct = num(percent);
  const safePct = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  const state = pct === null ? "unknown" : safePct <= 20 ? "low" : safePct <= 50 ? "mid" : "good";
  return <div className={`batteryGauge ${state}`} style={{ "--battery-fill": `${safePct}%` }} title={pct === null ? "Battery n/a" : `Battery ${safePct}%`}><div className="batteryShell"><span /><em>{pct === null ? "" : safePct}</em></div><b>{pct === null ? "n/a" : `${safePct}%`}</b></div>;
}

function SignalGauge({ bars = 0, network = "n/a", quality = "" }) {
  const level = Math.max(0, Math.min(5, Number(bars) || 0));
  const label = (network && network !== "n/a" && quality) ? `${network} · ${quality}` : quality || network || "n/a";
  return <div className="signalGauge" title={`Signal ${level}/5 · ${network || "n/a"}${quality ? " · " + quality : ""}`}><div className="signalBars">{[1,2,3,4,5].map((i)=><span key={i} className={i <= level ? "filled" : ""}/>)}</div><b>{label}</b></div>;
}

function formatHealthReason(raw) {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/^network check failed:\s*/i, "Network gagal · ");
  s = s.replace(/^network matched:\s*/i, "Network OK · ");
  s = s.replace(/^node error:\s*/i, "Node error · ");
  if (s.length > 80) s = s.slice(0, 77) + "…";
  return s;
}

function NodeCard({ node, onPing, onToggle }) {
  const rawType = node.raw_network_type || String(node.network_type || "").split("·")[0].trim() || "node";
  const signalBars = (() => {
    if (node.signal_level != null) return Math.round((node.signal_level / 4) * 5);
    if (node.signal_percent != null) return Math.round((node.signal_percent / 100) * 5);
    if (node.signal_dbm != null) { const c = Math.max(-120, Math.min(-40, node.signal_dbm)); return Math.round(((c + 120) / 80) * 5); }
    return 0;
  })();
  const rawSignalLabel = String(node.signal_label || "");
  const signalLabelIsType = rawSignalLabel && !/^\d|%|dBm|\//.test(rawSignalLabel);
  const networkLabel = node.network_label || node.radio_type || (signalLabelIsType ? rawSignalLabel : "") || "n/a";
  const signalQuality = node.signal_quality || (node.signal_dbm != null ? `${node.signal_dbm} dBm` : node.signal_percent != null ? `${node.signal_percent}%` : "");
  const nodeHealthReason = formatHealthReason(node.last_health_reason || node.network_reason || "");
  const rawReason = node.last_health_reason || node.network_reason || "";
  return <div className="nodeStatusCard">
    <div className="nodeCardTop">
      <div className="nodeTitleBlock"><b>{node.name}</b><small>{node.provider_name} · {rawType}</small></div>
      <div className="nodeTelemetryRow"><BatteryGauge percent={node.battery_percent}/><SignalGauge bars={signalBars} network={networkLabel} quality={signalQuality}/></div>
    </div>
    {nodeHealthReason?<div className="nodeMetaReason" title={rawReason}><span>{nodeHealthReason}</span></div>:null}
    <div className="nodeCardBottom">
      <HealthBadge status={node.last_health_status || "unknown"}/>
      <div className="nodeCardActions">
        <button className="smallBtn nodeCardPing" onClick={() => onPing(node)}><RefreshCw size={13}/> Ping</button>
        {onToggle&&<button className={`smallBtn ${node.is_active===false?'nodeEnableBtn':'nodeDisableBtn'}`} onClick={() => onToggle(node)}><Power size={13}/> {node.is_active===false?'Enable':'Disable'}</button>}
      </div>
    </div>
  </div>;
}

function AiEndpointCard() {
  const [aiStatus, setAiStatus] = useState({ ok: null, latencyMs: null, loading: true });
  const canvasRef = useRef(null);

  async function check() {
    try {
      const r = await fetch("/api/ai-endpoint-status");
      const data = await r.json();
      setAiStatus({ ...data, loading: false });
    } catch (e) {
      setAiStatus({ ok: false, latencyMs: null, loading: false });
    }
  }

  useEffect(() => { check(); const t = setInterval(check, 60000); return () => clearInterval(t); }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dots = Array.from({ length: 70 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.5 + Math.random() * 2,
      phase: Math.random() * Math.PI * 2,
      speed: 0.25 + Math.random() * 0.65,
      dx: (Math.random() - 0.5) * 0.0006,
      dy: (Math.random() - 0.5) * 0.0006,
    }));
    let raf;
    let t = 0;
    function draw() {
      const w = canvas.offsetWidth;
      const h = canvas.offsetHeight;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.clearRect(0, 0, w, h);
      t += 0.08;
      for (const d of dots) {
        d.x = ((d.x + d.dx) + 1) % 1;
        d.y = ((d.y + d.dy) + 1) % 1;
        const opacity = 0.1 + 0.45 * (0.5 + 0.5 * Math.sin(t * d.speed + d.phase));
        ctx.beginPath();
        ctx.arc(d.x * w, d.y * h, d.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(249,115,22,${opacity.toFixed(3)})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    }
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  const health = aiStatus.loading ? "waiting" : aiStatus.ok ? "online" : "offline";
  return <div className={`nodeStatusCard aiEndpointCard${aiStatus.ok ? " aiEndpointOnline" : ""}`}>
    <canvas ref={canvasRef} className="aiHalftoneCanvas" aria-hidden="true"/>
    <div className="nodeCardTop">
      <div className="nodeTitleBlock"><b>AI Checker</b><small>OpenAI API · Internet Positif</small></div>
      {aiStatus.loading && <div className="aiBounceDots"><span/><span/><span/></div>}
    </div>
    <div className="nodeCardBottom">
      <HealthBadge status={health}/>
      <div className="nodeCardActions">
        {aiStatus.latencyMs != null && <span className="aiLatency">{aiStatus.latencyMs} ms</span>}
        <button className="smallBtn nodeCardPing" onClick={check}><RefreshCw size={13}/> Ping</button>
      </div>
    </div>
  </div>;
}

function Login({ onLogin }) {
  const [email, setEmail] = useState(() => { try { return localStorage.getItem("domain_radar_admin_email") || ""; } catch(_) { return ""; } });
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const trimmedEmail = email.trim().toLowerCase();
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: trimmedEmail, password }) });
      try { if (trimmedEmail) localStorage.setItem("domain_radar_admin_email", trimmedEmail); } catch(_) {}
      await onLogin();
    } catch (_) { setError("Password salah atau session tidak valid."); } finally { setLoading(false); }
  }
  return <div className="loginPage"><div className="aiOrb one"/><div className="aiOrb two"/><section className="loginHero"><div className="loginBrand"><img src="/logo-icon.png" className="logoIconLg" alt=""/><img src="/logo-text.png" className="logoTextLg" alt="Domain Radar"/></div><h1>Search defense cockpit for domains, ranks, and provider signals.</h1><p>Monitor domain availability, Google rank shifts, suspicious SERP results, provider node health, battery status, and Telegram alerts from one compact command center.</p><div className="loginFeatures"><span><Network size={15}/> Provider Nodes</span><span><BarChart3 size={15}/> Rank Defense</span><span><Bell size={15}/> Smart Alerts</span></div></section><form className="loginCard" onSubmit={submit}><div className="loginIcon"><Lock size={24}/></div><h2>Secure Access</h2><p>Enter admin password to open the monitoring console.</p><input type="email" value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="Admin email" autoComplete="email"/><input type="password" value={password} onChange={(e)=>setPassword(e.target.value)} placeholder="Admin password" autoFocus />{error ? <div className="errorBox">{error}</div> : null}<button disabled={loading}>{loading ? "Authenticating..." : "Launch Dashboard"}</button><small>Encrypted session · AI-styled command layer</small></form></div>;
}

function Dashboard({ onLogout, isDemo = false }) {
  function hashToPage(hash) {
    if (hash === "#projects") return "projects";
    if (hash === "#rank") return "rank";
    if (hash === "#settings") return "settings";
    if (hash === "#defense") return "defense";
    if (hash === "#analytics") return "analytics";
    if (hash === "#trustpositif") return "trustpositif";
    return "dashboard";
  }
  const [page, setPage] = useState(() => hashToPage(window.location.hash));
  useEffect(() => {
    const onHash = () => setPage(hashToPage(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [tab, setTab] = useState("system");
  const [overview, setOverview] = useState({});
  const [domains, setDomains] = useState([]);
  const [results, setResults] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [projects, setProjects] = useState([]);
  const [rank, setRank] = useState([]);
  const [rankResults, setRankResults] = useState([]);
  const [proxies, setProxies] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [notice, setNotice] = useState("");
  const [auto, setAuto] = useState(true);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [historyFilter, setHistoryFilter] = useState("all");
  const [reasonFilter, setReasonFilter] = useState("all");
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [settings, setSettings] = useState({ check_interval_seconds: "60", retry_confirmations: "3", status_keywords: "internetpositif,trustpositif,nawala", telegram_bot_token: "", telegram_chat_id: "" });
  const [projectForm, setProjectForm] = useState({ name: "", notes: "", domain: "", bulk: "" });
  const [projectDomains, setProjectDomains] = useState({});
  const [rankForm, setRankForm] = useState({ project_name: "", domain: "", keyword: "", target_url: "" });
  const [proxy, setProxy] = useState({ name: "", provider_name: "", proxy_url: "", proxy_type: "http" });
  const [nodeForm, setNodeForm] = useState({ name: "", provider_name: "", network_type: "broadband", endpoint_url: "", secret_key: "" });
  const [projectTgMappings, setProjectTgMappings] = useState([]);
  const [projectTgEdits, setProjectTgEdits] = useState({});
  const [editingRank, setEditingRank] = useState(null);
  const [editRankForm, setEditRankForm] = useState({ project_name: "", keyword: "", domains: "", target_url: "" });
  const [cardPopup, setCardPopup] = useState(null);
  const [sideUsers, setSideUsers] = useState([]);
  const [sideEditEmail, setSideEditEmail] = useState(null);
  const [sideNickInput, setSideNickInput] = useState("");
  const [activitySessions, setActivitySessions] = useState([]);
  const [activityHourly, setActivityHourly] = useState([]);
  const [watchHoursDaily, setWatchHoursDaily] = useState([]);
  const [watchHoursWeekly, setWatchHoursWeekly] = useState([]);
  const [watchHoursMonthly, setWatchHoursMonthly] = useState([]);
  const [watchHoursToday, setWatchHoursToday] = useState([]);
  const [watchPeriod, setWatchPeriod] = useState('today');
  const [expandedUserCards, setExpandedUserCards] = useState({});
  const [userChartPeriod, setUserChartPeriod] = useState({});
  const [editingNickUser, setEditingNickUser] = useState(null);
  const [editNickValue, setEditNickValue] = useState("");
  const [selectedHRUser, setSelectedHRUser] = useState(null);
  const [scanCycleHealth, setScanCycleHealth] = useState(null);
  const sessionId = useMemo(() => { let sid=sessionStorage.getItem('_dr_sid'); if(!sid){sid=Math.random().toString(36).slice(2)+Date.now().toString(36);sessionStorage.setItem('_dr_sid',sid);} return sid; }, []);
  const adminEmail = useMemo(() => { try { return localStorage.getItem("domain_radar_admin_email") || ""; } catch(_) { return ""; } }, []);
  const demoGuard = () => { if (isDemo) { setNotice("Demo mode — read only. Please log in as admin to make changes."); return true; } return false; };

  async function load() { try { const [ov, dom, res, px, set, al, pr, rk, rr, nd, tg, sch] = await Promise.all([api("/api/overview"), api("/api/domains"), api("/api/results"), api("/api/proxies"), api("/api/settings"), api("/api/alerts"), api("/api/projects"), api("/api/rank/keywords"), api("/api/rank/results"), api("/api/nodes"), api("/api/project-telegram"), api("/api/scan-cycle-health").catch(() => null)]); setOverview(ov || {}); setDomains(Array.isArray(dom) ? dom : []); setResults(Array.isArray(res) ? res : []); setProxies(Array.isArray(px) ? px : []); setSettings(set || settings); setAlerts(Array.isArray(al) ? al : []); setProjects(Array.isArray(pr) ? pr : []); setRank(Array.isArray(rk) ? rk : []); setRankResults(Array.isArray(rr) ? rr : []); setNodes(Array.isArray(nd) ? nd : []); setProjectTgMappings(Array.isArray(tg) ? tg : []); setScanCycleHealth(sch || null); } catch (err) { if (err.status === 401) onLogout(); else setNotice(err.message || "Gagal load data."); } }
  async function loadSideUsers() { try { const u = await api("/api/auth/users"); setSideUsers(Array.isArray(u) ? u : []); } catch (_) {} }
  async function saveSideNick(email) { const nick = sideNickInput.trim(); try { await api("/api/auth/users/nickname", { method: "PATCH", body: JSON.stringify({ email, nickname: nick }) }); setSideUsers(prev => prev.map(u => u.email === email ? { ...u, nickname: nick } : u)); } catch (_) {} setSideEditEmail(null); }
  async function saveActivityNick(email) { const nick = editNickValue.trim(); try { await api("/api/auth/users/nickname", { method: "PATCH", body: JSON.stringify({ email, nickname: nick }) }); setSideUsers(prev => prev.map(u => u.email === email ? { ...u, nickname: nick } : u)); setEditingNickUser(null); } catch (_) {} }
  useEffect(() => { load(); loadSideUsers(); }, []);
  useEffect(() => { if (!auto) return undefined; const timer = setInterval(load, 15000); return () => clearInterval(timer); }, [auto]);
  async function loadActivityData() { try { const [sess,hrly,whd,whw,whm,wht]=await Promise.all([api('/api/activity/sessions'),api('/api/activity/hourly'),api('/api/activity/watch-hours?period=daily'),api('/api/activity/watch-hours?period=weekly'),api('/api/activity/watch-hours?period=monthly'),api('/api/activity/watch-hours?period=today')]); setActivitySessions(Array.isArray(sess)?sess:[]); setActivityHourly(Array.isArray(hrly)?hrly:[]); setWatchHoursDaily(Array.isArray(whd)?whd:[]); setWatchHoursWeekly(Array.isArray(whw)?whw:[]); setWatchHoursMonthly(Array.isArray(whm)?whm:[]); setWatchHoursToday(Array.isArray(wht)?wht:[]); } catch(_){} }
  useEffect(() => { if(page!=='users')return undefined; loadActivityData(); const iv=setInterval(loadActivityData,10000); return()=>clearInterval(iv); }, [page]);
  useEffect(() => { const beat=()=>api('/api/activity/heartbeat',{method:'POST',body:JSON.stringify({session_id:sessionId,page,email:adminEmail})}); beat(); const iv=setInterval(beat,30000); return()=>clearInterval(iv); }, [page, sessionId, adminEmail]);
  const projectOptions = useMemo(() => Array.from(new Set([...domains.map((d) => d.project_name || "No Project"), ...projects.map((p) => p.project_name || p.name).filter(Boolean)])).sort(), [domains, projects]);
  const grouped = useMemo(() => projectOptions.map((name) => ({ name, domains: domains.filter((d) => (d.project_name || "No Project") === name) })), [projectOptions, domains]);
  useEffect(() => { if (window.innerWidth <= 640 && grouped.length > 0) { setCollapsedProjects((prev) => { if (Object.keys(prev).length === 0) { const init = {}; grouped.forEach((g) => { init[g.name] = true; }); return init; } return prev; }); } }, [grouped.length]);
  const filtered = useMemo(() => { const q = search.toLowerCase().trim(); return domains.filter((d) => { const project = d.project_name || "No Project"; return (!q || d.domain.toLowerCase().includes(q) || project.toLowerCase().includes(q)) && (status === "all" || d.global_status === status) && (projectFilter === "all" || project === projectFilter); }); }, [domains, search, status, projectFilter]);
  const historyRows = useMemo(() => results.filter((r) => (historyFilter === "all" || String(r.checker_type || "").includes(historyFilter) || String(r.provider_name || "").toLowerCase().includes(historyFilter)) && (reasonFilter === "all" || String(r.reason_type || "UNKNOWN") === reasonFilter)), [results, historyFilter, reasonFilter]);
  const reasonAnalytics = useMemo(() => results.reduce((acc, r) => { const key = r.reason_type || "UNKNOWN"; acc[key] = (acc[key] || 0) + 1; return acc; }, {}), [results]);
  const latestResultByDomain = useMemo(() => { const map = {}; results.forEach(r => { if (!map[r.domain] || new Date(r.checked_at) > new Date(map[r.domain].checked_at)) map[r.domain] = r; }); return map; }, [results]);
  const domainProjectMap = useMemo(() => { const map = {}; domains.forEach(d => { map[d.domain] = d.project_name || ""; }); return map; }, [domains]);
  function openStatusPopup(s) { const list = s === "all" ? domains : domains.filter(d => d.global_status === s); const INFO = { all: ["🌐","Semua Domain",null], working: ["✅","Domain Normal",null], warning: ["⚠️","Domain Warning","Domain-domain ini mengalami masalah intermittent. Monitor secara berkala dan cek penyebab masing-masing."], blocked: ["🚫","Domain Blocked","Domain-domain ini terdeteksi bermasalah. Tindakan bergantung pada penyebab — lihat saran di tiap domain."] }; const [icon, title, globalTip] = INFO[s] || ["📋", s, null]; const items = list.map(d => { const lr = latestResultByDomain[d.domain]; let detail = null; if ((s === "warning" || s === "blocked") && lr) detail = lr.final_url ? `↪️ Redirect ke: ${lr.final_url}` : (lr.reason || null); return { domain: d.domain, project_name: d.project_name || "", status: d.global_status, detail, latestResult: lr }; }); setCardPopup({ type: s, title, icon, items, globalTip }); }
  function openReasonPopup(rt) { const filtered = results.filter(r => (r.reason_type || "UNKNOWN") === rt); const byDomain = {}; filtered.forEach(r => { if (!byDomain[r.domain] || new Date(r.checked_at) > new Date(byDomain[r.domain].checked_at)) byDomain[r.domain] = r; }); const items = Object.values(byDomain).map(r => { let detail = r.reason || ""; if ((rt === "REDIRECT" || rt === "REDIRECT_ISSUE") && r.final_url) detail = `↪️ Redirect ke: ${r.final_url}`; else if (String(r.checker_type || "").startsWith("node:")) detail = `Node: ${r.provider_name} (${r.checker_type}) — ${r.reason || ""}`.trim(); return { domain: r.domain, project_name: domainProjectMap[r.domain] || "", detail, checker: String(r.checker_type || "").startsWith("node:") ? r.provider_name : null, latestResult: r }; }); setCardPopup({ type: "reason", reasonType: rt, title: reasonLabel(rt), icon: "🔍", items }); }
  function getProjectInput(name) { return projectDomains[name] || { domain: "", bulk: "" }; }
  function setProjectInput(name, patch) { setProjectDomains((prev) => ({ ...prev, [name]: { ...(prev[name] || { domain: "", bulk: "" }), ...patch } })); }
  function toggleProjectCollapse(name) { setCollapsedProjects((prev) => ({ ...prev, [name]: !prev[name] })); }
  async function saveSettings(e) { e?.preventDefault(); if (demoGuard()) return; const saved = await api("/api/settings", { method: "POST", body: JSON.stringify(settings) }); setSettings(saved); setNotice("Settings saved."); }
  async function addProject(e) { e.preventDefault(); if (demoGuard()) return; const name = projectForm.name.trim(); if (!name) return; try { await api("/api/projects", { method: "POST", body: JSON.stringify({ name, notes: projectForm.notes }) }); } catch (err) { setNotice(err.message || "Failed to create project."); return; } if (projectForm.domain.trim()) await api("/api/domains", { method: "POST", body: JSON.stringify({ domain: projectForm.domain, project_name: name }) }); if (projectForm.bulk.trim()) { const text = projectForm.bulk.split(/\r?\n/).map((line) => { const trimmed = line.trim(); if (!trimmed) return ""; return trimmed.includes(",") ? trimmed : `${trimmed}, ${name}`; }).join("\n"); await api("/api/domains/bulk", { method: "POST", body: JSON.stringify({ text }) }); } setProjectForm({ name: "", notes: "", domain: "", bulk: "" }); setNotice("Project added."); load(); }
  async function addDomainToProject(projectName) { if (demoGuard()) return; const input = getProjectInput(projectName); if (!input.domain.trim()) return; await api("/api/domains", { method: "POST", body: JSON.stringify({ domain: input.domain, project_name: projectName === "No Project" ? "" : projectName }) }); setProjectInput(projectName, { domain: "" }); load(); }
  async function bulkImportToProject(projectName) { if (demoGuard()) return; const input = getProjectInput(projectName); if (!input.bulk.trim()) return; const text = input.bulk.split(/\r?\n/).map((line) => { const trimmed = line.trim(); if (!trimmed) return ""; if (projectName === "No Project") return trimmed.split(/[,;\t]/)[0].trim(); return trimmed.includes(",") ? trimmed : `${trimmed}, ${projectName}`; }).join("\n"); await api("/api/domains/bulk", { method: "POST", body: JSON.stringify({ text }) }); setProjectInput(projectName, { bulk: "" }); load(); }
  async function delProject(name) { if (demoGuard()) return; if (confirm(`Delete project card ${name}? Domain tidak ikut terhapus.`)) { await api(`/api/projects/${encodeURIComponent(name)}`, { method: "DELETE" }); load(); } }
  async function renameProject(name) { if (demoGuard()) return; const newName = prompt("Rename project", name); if (!newName || newName.trim() === name) return; const trimmed = newName.trim(); try { await api(`/api/projects/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ name: trimmed }) }); setNotice(`Project renamed to "${trimmed}". All history and data updated.`); load(); } catch (err) { setNotice(err.message || "Rename failed."); } }
  async function tgTest() { if (demoGuard()) return; setNotice("Sending Telegram test..."); const r = await api("/api/telegram/test", { method: "POST" }); setNotice(r.ok ? "Telegram test sent." : "Telegram test failed."); }
  async function editD(d) { if (demoGuard()) return; const nextDomain = prompt("Edit domain", d.domain); if (!nextDomain) return; const nextProject = prompt("Project name", d.project_name || "") ?? d.project_name; await api(`/api/domains/${d.id}`, { method: "PATCH", body: JSON.stringify({ domain: nextDomain, project_name: nextProject }) }); load(); }
  async function toggleD(d) { if (demoGuard()) return; if(!confirm(`${d.is_active?'Disable':'Enable'} ${d.domain}?`)) return; await api(`/api/domains/${d.id}`, { method: "PATCH", body: JSON.stringify({ is_active: !d.is_active }) }); load(); }
  async function checkD(d) { if (demoGuard()) return; setNotice(`Checking ${d.domain}...`); await api(`/api/check/domain/${d.id}`, { method: "POST" }); setNotice(`Checked ${d.domain}`); load(); }
  async function delD(d) { if (demoGuard()) return; if (confirm(`Delete ${d.domain}?`)) { await api(`/api/domains/${d.id}`, { method: "DELETE" }); load(); } }
  async function toggleLandingD(d) { await api(`/api/domains/${d.id}`, { method: "PATCH", body: JSON.stringify({ label: d.label === "landing_page" ? "" : "landing_page" }) }); load(); }
  async function toggleMsD(d) { await api(`/api/domains/${d.id}`, { method: "PATCH", body: JSON.stringify({ label: d.label === "ms" ? "" : "ms" }) }); load(); }
  async function addProxy(e) { e.preventDefault(); if (demoGuard()) return; await api("/api/proxies", { method: "POST", body: JSON.stringify(proxy) }); setProxy({ name: "", provider_name: "", proxy_url: "", proxy_type: "http" }); load(); }
  async function delProxy(p) { if (demoGuard()) return; if (confirm(`Delete proxy ${p.name}?`)) { await api(`/api/proxies/${p.id}`, { method: "DELETE" }); load(); } }
  async function addNode(e) { e.preventDefault(); await api("/api/nodes", { method: "POST", body: JSON.stringify(nodeForm) }); setNodeForm({ name: "", provider_name: "", network_type: "broadband", endpoint_url: "", secret_key: "" }); setNotice("Node added. Klik ping untuk cek health."); load(); }
  async function pingNode(n) { setNotice(`Pinging ${n.name}...`); const r = await api(`/api/nodes/${n.id}/ping`, { method: "POST" }); setNotice(r.ok ? `${n.name} ${r.mode === "polling" ? "waiting for agent" : "online"}` : `${n.name} offline: ${r.error || "unknown"}`); load(); }
  async function toggleNode(n) { await api(`/api/nodes/${n.id}`, { method: "PATCH", body: JSON.stringify({ is_active: !n.is_active }) }); load(); }
  async function delNode(n) { if (confirm(`Delete node ${n.name}?`)) { await api(`/api/nodes/${n.id}`, { method: "DELETE" }); load(); } }
  async function manual() { setNotice("Manual check running..."); await api("/api/check/manual", { method: "POST" }); setNotice("Manual check selesai."); load(); }
  async function addRank(e) { e.preventDefault(); await api("/api/rank/keywords", { method: "POST", body: JSON.stringify(rankForm) }); setRankForm({ project_name: "", domain: "", keyword: "", target_url: "" }); load(); }
  async function checkRank(id) { setNotice("Checking Google rank..."); await api(`/api/rank/check/${id}`, { method: "POST" }); load(); }
  async function checkAllRank() { await api("/api/rank/check-all", { method: "POST" }); load(); }
  async function delRank(k) { if (confirm(`Delete keyword ${k.keyword}?`)) { await api(`/api/rank/keywords/${k.id}`, { method: "DELETE" }); load(); } }
  function startEditRank(k) { setEditingRank(k.id); setEditRankForm({ project_name: k.project_name || "", keyword: k.keyword || "", domains: k.domain || "", target_url: k.domains?.[0]?.target_url || "" }); }
  async function saveEditRank(k) { await api(`/api/rank/keywords/${k.id}`, { method: "PUT", body: JSON.stringify(editRankForm) }); setEditingRank(null); load(); }
  async function saveProjectTg(projectName) { const chatId = (projectTgEdits[projectName] || "").trim(); if (!chatId) return; await api("/api/project-telegram", { method: "POST", body: JSON.stringify({ project_name: projectName, telegram_chat_id: chatId }) }); const updated = await api("/api/project-telegram"); setProjectTgMappings(Array.isArray(updated) ? updated : []); setNotice("Project Telegram saved."); }
  async function deleteProjectTg(projectName) { await api(`/api/project-telegram/${encodeURIComponent(projectName)}`, { method: "DELETE" }); const updated = await api("/api/project-telegram"); setProjectTgMappings(Array.isArray(updated) ? updated : []); setProjectTgEdits((prev) => { const n = { ...prev }; delete n[projectName]; return n; }); setNotice("Project Telegram removed."); }
  async function logout() { await api("/api/auth/logout", { method: "POST" }); onLogout(); }
  function csv(path) { window.open(path, "_blank"); }
  function goTo(p) { setPage(p); }
  function nav(p) { goTo(p); setMenuOpen(false); }
  function renderNav() {
    return (
      <aside>
        <h1><img src="/logo-icon.png" className="logoIcon" alt=""/><img src="/logo-text.png" className="logoText" alt="Domain Radar"/></h1>
        <p>Command Center</p>
        <button className={page === "dashboard" ? "navActive" : ""} onClick={() => goTo("dashboard")}><Globe2 size={16}/> Dashboard</button>
        <button className={page === "projects" ? "navActive" : ""} onClick={() => goTo("projects")}><FolderKanban size={16}/> Projects</button>
        <button className={page === "rank" ? "navActive" : ""} onClick={() => goTo("rank")}><BarChart3 size={16}/> Google Rank</button>
        <button className={page === "analytics" ? "navActive" : ""} onClick={() => goTo("analytics")}><Sparkles size={16}/> AI Analytics</button>
        <button className={page === "defense" ? "navActive" : ""} onClick={() => goTo("defense")}><Shield size={16}/> Defense Center</button>
        <button className={page === "trustpositif" ? "navActive" : ""} onClick={() => goTo("trustpositif")}><ShieldCheck size={16}/> Trust Positif</button>
        <button className={page === "users" ? "navActive" : ""} onClick={() => goTo("users")}><Users size={16}/> User Activity</button>
        <button className={page === "settings" ? "navActive" : ""} onClick={() => goTo("settings")}><Settings size={16}/> Settings</button>
        <button onClick={manual}><RefreshCw size={16}/> Manual Check All</button>
        <button onClick={() => setAuto(!auto)}><Radio size={16}/> Auto: {auto ? "ON" : "OFF"}</button>
        <button className="ghostBtn" onClick={logout}><LogOut size={16}/> Logout</button>
        {notice ? <p className="sideNotice">{notice}</p> : null}
        {sideUsers.length > 0 && (
          <div className="sideUserSection">
            <div className="sideUserSectionLabel">Pengguna</div>
            {sideUsers.map(u => {
              const hue = emailHue(u.email);
              const isEditing = sideEditEmail === u.email;
              return (
                <div className="sideUserRow" key={u.email}>
                  <div className="sideAvatar" style={{ background: `hsl(${hue},60%,38%)` }}>{emailInitials(u.email)}</div>
                  <div className="sideUserInfo">
                    <span className="sideUserEmail">{u.email}</span>
                    {isEditing ? (
                      <input
                        className="sideNickInput"
                        value={sideNickInput}
                        autoFocus
                        onChange={e => setSideNickInput(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") saveSideNick(u.email); if (e.key === "Escape") setSideEditEmail(null); }}
                        onBlur={() => saveSideNick(u.email)}
                        placeholder="Nickname..."
                      />
                    ) : (
                      u.nickname ? <span className="sideUserNick">{u.nickname}</span> : null
                    )}
                  </div>
                  {!isEditing && (
                    <button className="sideNickBtn" title="Edit nickname" onClick={() => { setSideEditEmail(u.email); setSideNickInput(u.nickname || ""); }}>
                      <Pencil size={11}/>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </aside>
    );
  }
  function renderMobileHeader() { return <header className="mobileHeader"><div className="mobileHeaderLogo"><img src="/logo-icon.png" className="radarIconSm" alt=""/><img src="/logo-text.png" className="logoTextSm" alt="Domain Radar"/></div><button className="hamburgerBtn" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? "✕" : "☰"}</button></header>; }
  function renderMobileDropdown() { return <><div className={`mobileDropMenu${menuOpen ? " open" : ""}`}><button className={page === "dashboard" ? "navActive" : ""} onClick={() => nav("dashboard")}><Globe2 size={16}/> Dashboard</button><button className={page === "projects" ? "navActive" : ""} onClick={() => nav("projects")}><FolderKanban size={16}/> Projects</button><button className={page === "rank" ? "navActive" : ""} onClick={() => nav("rank")}><BarChart3 size={16}/> Google Rank</button><button className={page === "analytics" ? "navActive" : ""} onClick={() => nav("analytics")}><Sparkles size={16}/> AI Analytics</button><button className={page === "defense" ? "navActive" : ""} onClick={() => nav("defense")}><Shield size={16}/> Defense Center</button><button className={page === "trustpositif" ? "navActive" : ""} onClick={() => nav("trustpositif")}><ShieldCheck size={16}/> Trust Positif</button><button className={page === "users" ? "navActive" : ""} onClick={() => nav("users")}><Users size={16}/> User Activity</button><button className={page === "settings" ? "navActive" : ""} onClick={() => nav("settings")}><Settings size={16}/> Settings</button><button onClick={() => { manual(); setMenuOpen(false); }}><RefreshCw size={16}/> Manual Check</button><button onClick={() => { setAuto(!auto); setMenuOpen(false); }}><Radio size={16}/> Auto: {auto ? "ON" : "OFF"}</button><button className="ghostBtn" onClick={logout}><LogOut size={16}/> Logout</button></div>{menuOpen && <div className="drawerBackdrop" onClick={() => setMenuOpen(false)}/>}</>; }
  function renderCards() { return <section className="cards"><div className={`card clickable${status === "all" ? " cardActive" : ""}`} onClick={() => { setStatus("all"); openStatusPopup("all"); }}><ShieldAlert/><b>{overview.total || 0}</b><span>Total</span></div><div className={`card clickable${status === "working" ? " cardActive" : ""}`} onClick={() => { setStatus(status === "working" ? "all" : "working"); openStatusPopup("working"); }}><CheckCircle/><b>{overview.working || 0}</b><span>Normal</span></div><div className={`card clickable${status === "warning" ? " cardActive" : ""}`} onClick={() => { setStatus(status === "warning" ? "all" : "warning"); openStatusPopup("warning"); }}><AlertTriangle/><b>{overview.warning || 0}</b><span>Warning</span></div><div className={`card clickable${status === "blocked" ? " cardActive" : ""}`} onClick={() => { setStatus(status === "blocked" ? "all" : "blocked"); openStatusPopup("blocked"); }}><Ban/><b>{overview.blocked || 0}</b><span>Blocked</span></div></section>; }
  function renderAlerts() { return <section className="panel alertPanel"><div className="panelHead"><h2><Bell size={20}/> Alert Center</h2><span className="muted">Latest 100 alerts</span></div><div className="alertList">{alerts.length ? alerts.slice(0, 6).map((a) => <div className="alertItem" key={a.id}><Badge status={a.new_status}/><div><b>{a.domain || "Deleted domain"}</b><small>{statusLabel(a.old_status)} → {statusLabel(a.new_status)} · {new Date(a.created_at).toLocaleString()}</small></div></div>) : <p className="muted">Belum ada alert.</p>}</div></section>; }
  function emptyDomainMessage() { if (status === "blocked") return { title: "No Blocked domain", body: "Semua domain belum ada yang berstatus blocked untuk filter ini." }; if (status === "warning") return { title: "No Warning domain", body: "Tidak ada domain warning untuk filter ini." }; if (status === "working") return { title: "No Normal domain", body: "Tidak ada domain normal untuk filter ini." }; return { title: "No domain found", body: "Coba ubah search, status filter, atau project filter." }; }
  function renderDomainTable(rawList = filtered) { const labelRank=l=>l==='ms'?2:l==='landing_page'?1:0; const list=[...rawList].sort((a,b)=>labelRank(b.label)-labelRank(a.label)); if (!list.length) { const msg = emptyDomainMessage(); return <div className="emptyState"><b>{msg.title}</b><span>{msg.body}</span></div>; } return <div className="domainListWrap"><table><thead><tr><th>Domain</th><th>Project</th><th>Status</th><th>Prev Status</th><th>Last Checked</th><th className="colEnab">Enab</th><th className="colMs">MS</th><th className="colLp">LP</th><th>Actions</th></tr></thead><tbody>{list.map((d) => <tr key={d.id}><td><a className="domainCell" href={`https://${d.domain}`} target="_blank" rel="noopener noreferrer">{d.domain}</a>{d.label==='ms'&&<span className="msChip"><i className="msDot"/>MS</span>}{d.label==='landing_page'&&<span className="landingChip"><i className="lpDot"/>LP</span>}</td><td>{d.project_name || "-"}</td><td><Badge status={d.global_status}/></td><td>{formatPendingStatus(d.last_status)}</td><td>{relativeTime(d.last_checked_at)}</td><td className="colEnab">{d.is_active ? "✓" : "✗"}</td><td className="colMs"><button className={`iconBtn msBtn${d.label==='ms'?' msActive':''}`} title={d.label==='ms'?"Unset MS":"Set as MS"} onClick={()=>toggleMsD(d)}>MS</button></td><td className="colLp"><button className={`iconBtn lpBtn${d.label==='landing_page'?' lpActive':''}`} title={d.label==='landing_page'?"Unset Landing Page":"Set as Landing Page"} onClick={()=>toggleLandingD(d)}>LP</button></td><td><div className="actions"><button className="iconBtn" onClick={() => checkD(d)}><RefreshCw size={14}/></button><button className="iconBtn" onClick={() => editD(d)}><Pencil size={14}/></button><button className="iconBtn" onClick={() => toggleD(d)}><Power size={14}/></button><button className="iconBtn danger" onClick={() => delD(d)}><Trash2 size={14}/></button></div></td></tr>)}</tbody></table><div className="domainCards">{list.map((d) => <div key={d.id} className="domainCardRow"><div className="domainCardMain"><a className="domainCell" href={`https://${d.domain}`} target="_blank" rel="noopener noreferrer">{d.domain}</a>{!d.is_active && <span className="muted" style={{fontSize:"10px"}}>(off)</span>}{d.label==='ms'&&<span className="msChip"><i className="msDot"/>MS</span>}{d.label==='landing_page'&&<span className="landingChip"><i className="lpDot"/>LP</span>}<Badge status={d.global_status}/></div><div className="domainCardBottom"><div className="domainCardMeta"><span>{d.project_name || "No Project"}</span><span>{relativeTime(d.last_checked_at)}</span>{d.last_status ? <span>{formatPendingStatus(d.last_status)}</span> : null}</div><div className="actions"><button className="iconBtn" onClick={() => checkD(d)}><RefreshCw size={14}/></button><button className="iconBtn" onClick={() => editD(d)}><Pencil size={14}/></button><button className="iconBtn" onClick={() => toggleD(d)}><Power size={14}/></button><button className={`iconBtn msBtn${d.label==='ms'?' msActive':''}`} title={d.label==='ms'?"Unset MS":"Set as MS"} onClick={()=>toggleMsD(d)}>MS</button><button className={`iconBtn lpBtn${d.label==='landing_page'?' lpActive':''}`} title={d.label==='landing_page'?"Unset Landing Page":"Set as Landing Page"} onClick={()=>toggleLandingD(d)}>LP</button><button className="iconBtn danger" onClick={() => delD(d)}><Trash2 size={14}/></button></div></div></div>)}</div></div>; }
  function renderNodeStatus() { const activeNodes=nodes.filter(n=>n.is_active!==false); const disabledCount=nodes.length-activeNodes.length; return <section className="panel"><div className="panelHead"><h2><Server size={20}/> Provider Node Health</h2><div style={{display:'flex',gap:8,alignItems:'center'}}>{disabledCount>0&&<span className="muted" style={{fontSize:12}}>{disabledCount} disabled</span>}<button className="smallBtn" onClick={() => { setPage("settings"); setTab("nodes"); }}>Manage Nodes</button></div></div><div className="nodeStatusGrid"><AiEndpointCard/>{activeNodes.map((n) => <NodeCard key={n.id} node={n} onPing={pingNode}/>)}</div></section>; }
  function reasonLabel(type) {
    const map = {
      NORMAL: "✅ Normal",
      BLOCKED_BY_PROVIDER: "🛡 Provider Block",
      DNS_ISSUE: "🌐 DNS Issue",
      SSL_ISSUE: "🔒 SSL Issue",
      REDIRECT_ISSUE: "🔁 Redirect Issue",
      TIMEOUT: "⏱ Timeout",
      HTTP_BLOCK: "🚫 HTTP Block",
      HOSTING_ISSUE: "🧩 Hosting Issue",
      NODE_ISSUE: "📡 Node Issue",
      TECHNICAL_WARNING: "⚠️ Technical Warning",
      UNKNOWN: "❔ Unknown"
    };
    return map[type] || type || "Unknown";
  }
  function renderReasonAnalytics() {
    const items = Object.entries(reasonAnalytics).sort((a,b)=>b[1]-a[1]);
    const filteredCount = reasonFilter !== "all" ? historyRows.length : null;
    return <section className="panel reasonPanel"><div className="panelHead"><h2>Reason Analytics</h2><span className="muted">Klik kartu untuk melihat detail domain</span></div><div className="reasonGrid">{items.map(([type,count]) => <button key={type} className={reasonFilter === type ? "reasonCard activeReason" : "reasonCard"} onClick={() => { setReasonFilter(reasonFilter === type ? "all" : type); openReasonPopup(type); }}><b>{count}</b><span>{reasonLabel(type)}</span></button>)}</div>{reasonFilter !== "all" && <div className="reasonFilterBanner"><span>🔍 Filter aktif: <b>{reasonLabel(reasonFilter)}</b> — <b>{filteredCount}</b> hasil ditemukan di Check History</span><button className="reasonClearBtn" onClick={() => setReasonFilter("all")}>✕ Clear</button></div>}</section>;
  }
  function renderHistory() { return <section className="panel historyPanel"><div className="panelHead"><h2>Latest Check History</h2></div><div className="historyControlsRow"><div className="historySegmented"><button className={historyFilter === "all" ? "active" : ""} onClick={() => setHistoryFilter("all")}>All</button><button className={historyFilter === "node" ? "active" : ""} onClick={() => setHistoryFilter("node")}>Nodes</button><button className={historyFilter === "proxy" ? "active" : ""} onClick={() => setHistoryFilter("proxy")}>Proxy</button><button className={historyFilter === "direct" ? "active" : ""} onClick={() => setHistoryFilter("direct")}>Direct</button></div><select className="historyReasonSelect" value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value)}><option value="all">All reasons</option>{Object.keys(reasonAnalytics).sort().map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}</select><button className="smallBtn historyCsvBtn" onClick={() => csv("/api/export/results.csv")}><Download size={15}/> CSV</button></div><table><thead><tr><th>Time</th><th>Domain</th><th>Provider</th><th>Type</th><th>Status</th><th>HTTP</th><th>Latency</th><th>Reason</th></tr></thead><tbody>{historyRows.slice(0, 60).map((r) => <tr key={r.id}><td>{r.checked_at ? new Date(r.checked_at).toLocaleString() : "-"}</td><td className="domainCell">{r.domain || "-"}</td><td>{r.provider_name || "-"}</td><td>{r.checker_type || "-"}</td><td><Badge status={r.status}/></td><td>{r.http_status || "-"}</td><td>{r.latency_ms ? `${r.latency_ms}ms` : "-"}</td><td>{r.reason || "-"}</td></tr>)}</tbody></table>{!historyRows.length ? <p className="muted">Belum ada history. Klik refresh pada domain atau Manual Check All.</p> : null}</section>; }
  function parseBr(ua){if(!ua)return'Unknown';if(/iPhone|iPad/.test(ua))return'Safari iOS';if(/Android/.test(ua)&&/Chrome/.test(ua))return'Chrome Android';if(/Android/.test(ua))return'Android';if(/Firefox\//.test(ua))return'Firefox';if(/Edg\//.test(ua))return'Edge';if(/Chrome\//.test(ua))return'Chrome';if(/Safari\//.test(ua))return'Safari';return'Browser';}
  function fmtDur(s){s=parseFloat(s||0);if(s<60)return`${Math.round(s)}s`;if(s<3600)return`${Math.floor(s/60)}m ${Math.floor(s%60)}s`;return`${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;}
  function renderUserActivityPage() {
    const now = new Date();
    const active = activitySessions.filter(s => s.is_active);
    const todaySess = activitySessions.filter(s => new Date(s.first_seen_at).toDateString() === now.toDateString());
    const isToday = watchPeriod === 'today';
    const whData = isToday ? watchHoursToday : watchPeriod==='weekly' ? watchHoursWeekly : watchPeriod==='monthly' ? watchHoursMonthly : watchHoursDaily;
    function fmtMin(m){m=Math.round(m);if(m<60)return`${m}m`;const h=Math.floor(m/60);const r=m%60;return r?`${h}h${r}m`:`${h}h`;}
    function fmtSec(s){return fmtMin(Math.round(s/60));}
    function niceYTicks(maxMin){const rough=maxMin/4;if(!rough||!isFinite(rough))return[5,10,15,20];const mag=Math.pow(10,Math.floor(Math.log10(Math.max(rough,1))));const norm=rough/mag;const step=norm<1.5?1:norm<3?2:norm<7?5:10;const s=Math.max(1,step*mag);return[s,s*2,s*3,s*4];}

    // Per-user watch seconds for current period
    const periodWatchMap={};
    whData.forEach(r=>{if(!periodWatchMap[r.email])periodWatchMap[r.email]=0;periodWatchMap[r.email]+=parseInt(r.watch_seconds||0);});

    // Per-user today check-in hours: hours where ≥60s of activity (for 24-seg bar)
    const todayHourActivity={};
    watchHoursToday.forEach(r=>{
      if(parseInt(r.watch_seconds||0)>=60){
        const h=new Date(r.bucket).getHours();
        if(!todayHourActivity[r.email])todayHourActivity[r.email]=new Set();
        todayHourActivity[r.email].add(h);
      }
    });

    // Build user groups
    const sessionsByEmail={};
    activitySessions.forEach(s=>{const k=s.email||'anon';if(!sessionsByEmail[k])sessionsByEmail[k]=[];sessionsByEmail[k].push(s);});
    const seenEmails=new Set(Object.keys(sessionsByEmail));

    const sessionUserGroups=Object.entries(sessionsByEmail).map(([email,sessions])=>{
      const latest=[...sessions].sort((a,b)=>new Date(b.last_seen_at)-new Date(a.last_seen_at))[0];
      const diffMin=(Date.now()-new Date(latest.last_seen_at).getTime())/60000;
      const liveStatus=diffMin<3?'active':diffMin<30?'idle':'off';
      const nickname=sideUsers.find(u=>u.email===email)?.nickname||latest.nickname||'';
      const firstSeen=sessions.reduce((mn,s)=>(!mn||new Date(s.first_seen_at)<new Date(mn))?s.first_seen_at:mn,null);
      const totalDailySec=watchHoursDaily.filter(r=>r.email===email).reduce((s,r)=>s+parseInt(r.watch_seconds||0),0);
      const periodSec=periodWatchMap[email]||0;
      const totalSessionDurSec=sessions.reduce((s,sess)=>s+Math.max(0,(new Date(sess.last_seen_at)-new Date(sess.first_seen_at))/1000),0);
      const avgSessionLengthSec=sessions.length?Math.round(totalSessionDurSec/sessions.length):0;
      return{email,sessions,latest,liveStatus,nickname,firstSeen,totalDailySec,avgSessionLengthSec,periodSec};
    }).sort((a,b)=>b.periodSec-a.periodSec||(b.sessions.length-a.sessions.length));

    const neverSeenUsers=sideUsers
      .filter(u=>u.email&&!seenEmails.has(u.email))
      .map(u=>({email:u.email,sessions:[],latest:null,liveStatus:'never',nickname:u.nickname||'',firstSeen:null,totalDailySec:0,avgSessionLengthSec:0,periodSec:0}));

    const userGroups=[...sessionUserGroups,...neverSeenUsers];
    const maxPeriodSec=Math.max(...userGroups.map(u=>u.periodSec),1);
    const totalPeriodSec=userGroups.reduce((s,u)=>s+u.periodSec,0);
    const topUser=userGroups.find(u=>u.periodSec>0);

    const liveColor={active:'#f97316',idle:'#ffb020',off:'#64748b',never:'#374151'};
    const liveLabel={active:'● Online',idle:'◐ Idle',off:'○ Offline',never:'— Never'};

    const periodLabel=isToday?'Today':watchPeriod==='weekly'?'This Week':watchPeriod==='monthly'?'This Month':'Daily';

    function hrRating(periodSec,isNever){
      if(isNever)return{label:'Never',color:'#4b5a6a',bg:'rgba(75,90,106,.1)'};
      const threshActive=isToday?1800:watchPeriod==='weekly'?10800:watchPeriod==='monthly'?21600:3600;
      const threshMod=isToday?300:watchPeriod==='weekly'?1800:watchPeriod==='monthly'?3600:600;
      if(periodSec>=threshActive)return{label:'Active',color:'#f97316',bg:'rgba(249,115,22,.1)'};
      if(periodSec>=threshMod)return{label:'Moderate',color:'#ffb020',bg:'rgba(255,176,32,.1)'};
      return{label:'Inactive',color:'#ff4d4f',bg:'rgba(255,77,79,.1)'};
    }

    // Selected user data
    const sel=selectedHRUser?userGroups.find(u=>u.email===selectedHRUser):null;
    const selSessions=sel?[...sel.sessions].sort((a,b)=>new Date(b.last_seen_at)-new Date(a.last_seen_at)).slice(0,50):[];
    const selWhData=sel?whData.filter(r=>r.email===sel.email):[];
    const selTodayData=sel?Array.from({length:24},(_,h)=>{
      const rows=watchHoursToday.filter(r=>r.email===sel.email&&new Date(r.bucket).getHours()===h);
      return rows.reduce((s,r)=>s+parseInt(r.watch_seconds||0),0);
    }):[];
    const selTodayMax=Math.max(...selTodayData,1);
    const selBuckets=[...new Set(selWhData.map(r=>r.bucket))].sort();
    const selBucketVals=selWhData.reduce((m,r)=>{m[r.bucket]=parseInt(r.watch_seconds||0);return m;},{});
    const selBarVals=selBuckets.map(b=>selBucketVals[b]||0);
    const selBarMax=Math.max(...selBarVals,1);
    function bucketLabel(b){const d=new Date(b);if(watchPeriod==='monthly')return d.toLocaleDateString('en-GB',{month:'short',year:'2-digit'});return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'});}
    const selTodayTicks=niceYTicks(Math.ceil(selTodayMax/60)||1);
    const selTodayTickMax=selTodayTicks[3];

    const todayDate=now.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});

    return (
      <section className="panel hrAuditPanel">
        {/* Header */}
        <div className="hrAuditHeader">
          <div className="hrAuditTitle">
            <Users size={20}/>
            <div>
              <h2 style={{margin:0,fontSize:'16px'}}>Staff Activity Audit</h2>
              <span className="hrAuditSub">{todayDate} · auto-refresh 10s</span>
            </div>
          </div>
          <div className="hrPeriodTabs">
            {['today','daily','weekly','monthly'].map(p=>(
              <button key={p} className={`watchTabBtn${watchPeriod===p?' watchTabActive':''}`} onClick={()=>setWatchPeriod(p)}>
                {p==='today'?'Today':p==='daily'?'Daily':p==='weekly'?'Weekly':'Monthly'}
              </button>
            ))}
          </div>
        </div>

        {/* Hero stats */}
        <div className="hrHeroRow">
          <div className="hrHeroCard hrHeroActive">
            <div className="hrHeroPulse"/>
            <b>{active.length}</b>
            <span>Online Now</span>
          </div>
          <div className="hrHeroCard">
            <b>{todaySess.length}</b>
            <span>Sessions Today</span>
          </div>
          <div className="hrHeroCard">
            <b>{totalPeriodSec>0?fmtSec(totalPeriodSec):'0m'}</b>
            <span>Total · {periodLabel}</span>
          </div>
          <div className="hrHeroCard">
            <b style={{fontSize:'15px',letterSpacing:0,lineHeight:1.2}}>{topUser?topUser.email.split('@')[0]:'—'}</b>
            <span>Top Staff · {topUser?fmtSec(topUser.periodSec):'0m'}</span>
          </div>
        </div>

        {/* Body: leaderboard + detail */}
        <div className="hrBody">

          {/* Left: Leaderboard */}
          <div className="hrLeaderboard">
            <div className="hrLeaderboardHead">
              <span className="hrLBHdStaff">Staff Member</span>
              <span className="hrLBHdBar">Today · 24h Check-in</span>
              <span className="hrLBHdWatch">{periodLabel}</span>
            </div>
            {userGroups.length===0?(
              <div className="watchEmpty" style={{padding:'24px 16px'}}>No sessions yet.</div>
            ):userGroups.map(ug=>{
              const hue=emailHue(ug.email);
              const isNever=ug.liveStatus==='never';
              const rating=hrRating(ug.periodSec,isNever);
              const isSelected=selectedHRUser===ug.email;
              const activeHours=todayHourActivity[ug.email]||new Set();
              const liveSymbol=ug.liveStatus==='active'?'●':ug.liveStatus==='idle'?'◑':isNever?'✕':'○';
              return (
                <div key={ug.email}
                  className={`hrLeaderRow${isSelected?' hrLeaderRowSelected':''}${isNever?' hrLeaderRowNever':''}`}
                  onClick={()=>setSelectedHRUser(isSelected?null:ug.email)}>
                  <div className="hrLeaderAvatar" style={{background:isNever?'#141c24':`hsl(${hue},60%,38%)`,border:isNever?'2px solid #2a3a4a':`2px solid hsl(${hue},70%,55%)`,opacity:isNever?0.4:1}}>
                    {emailInitials(ug.email)}
                    {ug.liveStatus==='active'&&<span className="hrLiveRing hrLiveGreen"/>}
                    {ug.liveStatus==='idle'&&<span className="hrLiveRing hrLiveAmber"/>}
                  </div>
                  <div className="hrLeaderInfo">
                    <div className="hrLeaderEmail">{ug.email}</div>
                    {ug.nickname&&<div className="hrLeaderNick">{ug.nickname}</div>}
                  </div>
                  <div className="hr24Bar">
                    {Array.from({length:24},(_,h)=>{
                      const on=activeHours.has(h);
                      const isNowH=!isNever&&h===now.getHours();
                      return <div key={h} className={`hr24Seg${on?' hr24SegOn':isNowH?' hr24SegNow':''}`}/>;
                    })}
                  </div>
                  <div className="hrLeaderRight">
                    <div className="hrLeaderTime">{isNever?'—':fmtSec(ug.periodSec)||'0m'}</div>
                    <div className="hrLeaderRating" style={{color:rating.color,background:rating.bg}}>{liveSymbol} {rating.label}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right: Detail panel */}
          {sel?(
            <div className="hrDetail">
              {/* Profile header */}
              <div className="hrDetailProfile">
                <div className="hrDetailAvatar" style={{background:`hsl(${emailHue(sel.email)},60%,38%)`,border:`3px solid hsl(${emailHue(sel.email)},70%,55%)`}}>
                  {emailInitials(sel.email)}
                  {sel.liveStatus==='active'&&<span className="hrLiveRing hrLiveGreen" style={{bottom:2,right:2}}/>}
                </div>
                <div className="hrDetailProfileInfo">
                  <div className="hrDetailEmail">{sel.email}</div>
                  <div className="hrDetailNickRow">
                    {editingNickUser===sel.email?(
                      <>
                        <input className="userCardNickInput" autoFocus value={editNickValue} onChange={e=>setEditNickValue(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')saveActivityNick(sel.email);if(e.key==='Escape')setEditingNickUser(null);}} placeholder="Nickname..."/>
                        <button className="userCardNickSave" onClick={()=>saveActivityNick(sel.email)}>Save</button>
                        <button className="userCardNickCancel" onClick={()=>setEditingNickUser(null)}>✕</button>
                      </>
                    ):(
                      <>
                        {sel.nickname&&<span className="userCardNick">{sel.nickname}</span>}
                        <button className="userCardNickEditBtn" title="Edit nickname" onClick={()=>{setEditingNickUser(sel.email);setEditNickValue(sel.nickname||'');}}><Pencil size={11}/></button>
                      </>
                    )}
                  </div>
                  <div className="hrDetailMeta">
                    {sel.latest&&<>{countryFlag(sel.latest.country||'')} <span className="userCardIp">{(sel.latest.ip||'').replace(/^::ffff:/,'').split(',')[0].trim()}</span></>}
                    <span className="hrDetailLiveStatus" style={{color:liveColor[sel.liveStatus]}}>{liveLabel[sel.liveStatus]}</span>
                    {(()=>{const r=hrRating(sel.periodSec,sel.liveStatus==='never');return <span className="hrLeaderRating" style={{color:r.color,background:r.bg,fontSize:'9.5px'}}>{r.label}</span>;})()}
                  </div>
                </div>
                <button className="hrDetailClose" onClick={()=>setSelectedHRUser(null)}>✕</button>
              </div>

              {/* 4 stat chips */}
              <div className="hrDetailStats">
                <div className="hrDetailStat">
                  <b>{sel.sessions.length}</b>
                  <span>Sessions</span>
                </div>
                <div className="hrDetailStat">
                  <b>{sel.periodSec>0?fmtSec(sel.periodSec):'—'}</b>
                  <span>Watch · {periodLabel}</span>
                </div>
                <div className="hrDetailStat">
                  <b>{sel.firstSeen?new Date(sel.firstSeen).toLocaleDateString('en-GB',{day:'2-digit',month:'short'}):'—'}</b>
                  <span>First Seen</span>
                </div>
                <div className="hrDetailStat">
                  <b>{sel.avgSessionLengthSec>0?fmtSec(sel.avgSessionLengthSec):'—'}</b>
                  <span>Avg Session</span>
                </div>
              </div>

              {/* Activity Timeline */}
              <div className="hrDetailSection">
                <div className="hrDetailSectionLabel">Activity Timeline · {watchPeriod.toUpperCase()}</div>
                {isToday?(
                  <div className="hrDetailChartScroll">
                    <svg width={24*18+32} height="90" viewBox={`0 0 ${24*18+32} 90`}>
                      {selTodayTicks.map(t=>{
                        const y=8+44-(t/selTodayTickMax)*44;
                        return <g key={t}>
                          <line x1={30} y1={y} x2={24*18+32} y2={y} stroke="rgba(255,255,255,.08)" strokeWidth="0.5"/>
                          <text x={28} y={y+3} textAnchor="end" fontSize="8" fill="rgba(255,255,255,.82)">{fmtMin(t)}</text>
                        </g>;
                      })}
                      {selTodayData.map((sec,h)=>{
                        const bH=sec?Math.max(2,(sec/selTodayMax)*44):1.5;
                        const hue=emailHue(sel.email);
                        const isNow=h===now.getHours();
                        return <g key={h}>
                          {sec>0&&<rect x={30+h*18} y={8+44-bH} width={16} height={bH} rx="1.5"
                            fill={`hsl(${hue},70%,${isNow?65:55}%)`} opacity={0.88}/>}
                          <rect x={30+h*18} y={8+44-1.5} width={16} height={1.5} rx="0.75" fill="rgba(255,255,255,.04)"/>
                          <text x={30+h*18+8} y={80} textAnchor="middle" fontSize="8" fill={isNow?'rgba(249,115,22,.95)':'rgba(255,255,255,.82)'}>{String(h).padStart(2,'0')}</text>
                        </g>;
                      })}
                    </svg>
                  </div>
                ):selBuckets.length===0?(
                  <div className="watchEmpty">No data for this period.</div>
                ):(
                  <div className="hrDetailChartScroll">
                    {(()=>{const w=Math.max(selBuckets.length*22+16,280);return(
                    <svg width={w} height="90" viewBox={`0 0 ${w} 90`}>
                      {selBarVals.map((val,i)=>{
                        const bH=val?Math.max(2,(val/selBarMax)*44):0;
                        const hue=emailHue(sel.email);
                        const mins=Math.round(val/60);
                        return <g key={selBuckets[i]}>
                          <rect x={8+i*22+1} y={8+44-(bH||1.5)} width={20} height={bH||1.5} rx="2" fill={`hsl(${hue},70%,55%)`} opacity={bH?0.85:0.12}/>
                          {val>0&&mins>0&&<text x={8+i*22+10} y={8+44-bH-3} textAnchor="middle" fontSize="7" fill={`hsl(${hue},60%,80%)`}>{mins}m</text>}
                          <text x={8+i*22+10} y={80} textAnchor="middle" fontSize="8" fill="rgba(255,255,255,.82)">{bucketLabel(selBuckets[i])}</text>
                        </g>;
                      })}
                    </svg>
                    );})()}
                  </div>
                )}
              </div>

              {/* Session History */}
              <div className="hrDetailSection">
                <div className="hrDetailSectionLabel">Session History ({selSessions.length})</div>
                {selSessions.length===0?(
                  <div className="watchEmpty">No sessions recorded.</div>
                ):(
                  <div className="hrSessionTable">
                    {selSessions.map((s,i)=>{
                      const dur=Math.max(0,Math.round((new Date(s.last_seen_at)-new Date(s.first_seen_at))/1000));
                      const ip=(s.ip||'').replace(/^::ffff:/,'').split(',')[0].trim();
                      const flag=countryFlag(s.country||'');
                      return (
                        <div key={i} className="hrSessionRow">
                          <span className="hrSessionDate">{new Date(s.last_seen_at).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</span>
                          <span className="hrSessionDur">{dur>0?fmtSec(dur):'<1m'}</span>
                          <span className="hrSessionPage">{s.page||'/'}</span>
                          <span className="hrSessionIp">{flag} {ip||'—'}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ):(
            <div className="hrDetailEmpty">
              <div style={{opacity:.35,marginBottom:10}}><Users size={36}/></div>
              <b>Select a staff member</b>
              <p>Click any row in the leaderboard to view their activity timeline and session history.</p>
            </div>
          )}
        </div>
      </section>
    );
  }
  function renderProjectDomainBox(name) { const input = getProjectInput(name); return <div className="projectAddBox"><div className="projectAddRow"><input value={input.domain} onChange={(e) => setProjectInput(name, { domain: e.target.value })} placeholder={`Add domain to ${name}`} /><button type="button" onClick={() => addDomainToProject(name)}>Add</button></div><textarea value={input.bulk} onChange={(e) => setProjectInput(name, { bulk: e.target.value })} placeholder={`Bulk import to ${name}\nexample.com\nexample.net`} /><button type="button" onClick={() => bulkImportToProject(name)}>Bulk Import to {name}</button></div>; }
  function renderScanCycleHealth() { if (!scanCycleHealth) return null; const { lastCompletedAt, domainCount, errorCount, durationMs, running: isRunning } = scanCycleHealth; if (isRunning) return <div className="scanCycleHealth scanning"><span className="scanDot scanning"/>Scan in progress…</div>; if (!lastCompletedAt) return <div className="scanCycleHealth"><span className="scanDot idle"/>No scan completed yet</div>; const agoSec = Math.floor((Date.now() - lastCompletedAt) / 1000); const agoStr = agoSec < 60 ? `${agoSec}s ago` : agoSec < 3600 ? `${Math.floor(agoSec/60)}m ${agoSec%60}s ago` : `${Math.floor(agoSec/3600)}h ${Math.floor((agoSec%3600)/60)}m ago`; const durStr = durationMs < 1000 ? `${durationMs}ms` : durationMs < 60000 ? `${(durationMs/1000).toFixed(1)}s` : `${Math.floor(durationMs/60000)}m ${Math.round((durationMs%60000)/1000)}s`; return <div className={`scanCycleHealth${errorCount > 0 ? " hasErrors" : ""}`}><span className={`scanDot${errorCount > 0 ? " error" : " ok"}`}/><span>Last cycle: <b>{agoStr}</b> · {domainCount} domain{domainCount !== 1 ? "s" : ""} · {durStr}{errorCount > 0 ? <span className="scanErrors"> · {errorCount} error{errorCount !== 1 ? "s" : ""}</span> : null}</span></div>; }
  function renderDashboardPage() { return <>{renderNodeStatus()}{renderCards()}{renderReasonAnalytics()}{renderAlerts()}<section className="panel"><div className="panelHead"><h2>Domains</h2><button className="smallBtn" onClick={() => csv("/api/export/domains.csv")}><Download size={15}/> CSV</button></div>{renderScanCycleHealth()}<div className="filters"><div className="searchBox"><Search size={16}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search domain or project..."/></div><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">All status</option><option value="working">Normal</option><option value="warning">Warning</option><option value="blocked">Blocked</option><option value="unknown">Unknown</option></select><select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}><option value="all">All projects</option>{projectOptions.map((p) => <option key={p}>{p}</option>)}</select></div>{renderDomainTable()}</section>{renderHistory()}</>; }
  function renderProjectsPage() { return <><section className="panel createProjectPanel"><div className="panelHead"><h2><FolderKanban size={20}/> Create New Project</h2><button className="smallBtn" onClick={load}><RefreshCw size={15}/> Refresh</button></div><form onSubmit={addProject} className="createProjectForm"><input value={projectForm.name} onChange={(e) => setProjectForm({ ...projectForm, name: e.target.value })} placeholder="Project name, contoh: Empire88" /><input value={projectForm.notes} onChange={(e) => setProjectForm({ ...projectForm, notes: e.target.value })} placeholder="Notes optional" /><input value={projectForm.domain} onChange={(e) => setProjectForm({ ...projectForm, domain: e.target.value })} placeholder="Initial domain optional" /><button><Plus size={16}/> Create Project</button><textarea className="wide" value={projectForm.bulk} onChange={(e) => setProjectForm({ ...projectForm, bulk: e.target.value })} placeholder="Bulk domain optional, one domain per line" /></form></section><div className="projectStack">{grouped.map((g) => { const collapsed = Boolean(collapsedProjects[g.name]); return <section className="projectDetail" key={g.name}><div className="projectHeaderGrid" onClick={() => toggleProjectCollapse(g.name)} style={{cursor:"pointer"}}><div><h2>{g.name}</h2><p className="muted">{g.domains.length} domain{collapsed ? " · tap to expand" : ""}</p></div><div className="projectMetric"><b>{g.domains.length}</b><span>Total</span></div><div className="projectMetric"><b>{g.domains.filter((d) => d.global_status === "working").length}</b><span>Normal</span></div><div className="projectMetric"><b>{g.domains.filter((d) => d.global_status === "warning").length}</b><span>Warning</span></div><div className="projectMetric"><b>{g.domains.filter((d) => d.global_status === "blocked").length}</b><span>Blocked</span></div><div className="projectHeaderActions"><button className="smallBtn collapseBtn" onClick={(e) => { e.stopPropagation(); toggleProjectCollapse(g.name); }}>{collapsed ? "Expand" : "Collapse"}</button>{g.name !== "No Project" ? <button className="smallBtn" onClick={(e) => { e.stopPropagation(); renameProject(g.name); }}>Rename</button> : null}{g.name !== "No Project" ? <button className="smallBtn danger" onClick={(e) => { e.stopPropagation(); delProject(g.name); }}>Delete</button> : null}</div></div>{collapsed ? <div className="projectCollapsedHint">Project card collapsed. Klik Expand untuk input domain dan melihat list domain.</div> : <div className="projectBody">{renderProjectDomainBox(g.name)}{renderDomainTable(g.domains)}</div>}</section>; })}</div></>; }
  function renderRankPage() { return <section className="panel"><div className="panelHead"><h2><BarChart3 size={20}/> Google Rank Checker</h2><div className="tabs"><button className="smallBtn" onClick={() => setPage("defense")}>Rank Defense Center</button><button className="smallBtn" onClick={checkAllRank}><RefreshCw size={15}/> Check All</button></div></div><form onSubmit={addRank} className="rankForm"><input value={rankForm.project_name} onChange={(e) => setRankForm({ ...rankForm, project_name: e.target.value })} placeholder="Project name"/><input value={rankForm.domain} onChange={(e) => setRankForm({ ...rankForm, domain: e.target.value })} placeholder="domain1.com, domain2.com"/><input value={rankForm.keyword} onChange={(e) => setRankForm({ ...rankForm, keyword: e.target.value })} placeholder="keyword"/><input value={rankForm.target_url} onChange={(e) => setRankForm({ ...rankForm, target_url: e.target.value })} placeholder="Target URL optional"/><button>Add / Merge</button></form><p className="hint">Keyword duplicate sekarang otomatis merge jadi 1 group. Scan depth: Google Top 100 results.</p><table><thead><tr><th>Project</th><th>Domain</th><th>Rank</th><th>Page</th><th>Keyword</th><th>Suspicious</th><th>Actions</th></tr></thead><tbody>{rank.map((k) => editingRank === k.id ? (<React.Fragment key={k.id}><tr className="rankEditRow"><td><input className="rankEditInput" value={editRankForm.project_name} onChange={(e) => setEditRankForm({ ...editRankForm, project_name: e.target.value })} placeholder="Project"/></td><td><textarea className="rankEditInput" rows={2} value={editRankForm.domains} onChange={(e) => setEditRankForm({ ...editRankForm, domains: e.target.value })} placeholder="domain1.com, domain2.com" style={{resize:"vertical",minHeight:"40px"}}/></td><td><input className="rankEditInput" value={editRankForm.keyword} onChange={(e) => setEditRankForm({ ...editRankForm, keyword: e.target.value })} placeholder="Keyword"/></td><td><input className="rankEditInput" value={editRankForm.target_url} onChange={(e) => setEditRankForm({ ...editRankForm, target_url: e.target.value })} placeholder="Target URL (e.g. https://example.com/page)"/></td><td colSpan={2}><div className="muted" style={{fontSize:"11px"}}>Comma-sep domains · Target URL applies to all domains in group</div></td><td><div className="actions"><button className="smallBtn" onClick={() => saveEditRank(k)}>Save</button><button className="iconBtn" onClick={() => setEditingRank(null)}>✕</button></div></td></tr></React.Fragment>) : (() => { const doms = Array.isArray(k.domains) && k.domains.filter(d => d.is_whitelisted).length > 0 ? k.domains.filter(d => d.is_whitelisted) : [{ domain: k.domain || "—", last_position: k.last_position, last_page: k.last_page }]; const rowCount = doms.length || 1; return (<React.Fragment key={"disp-" + k.id}>{doms.map((d, i) => (<tr key={d.domain || i}>{i === 0 && <td rowSpan={rowCount} style={{verticalAlign:"top",paddingTop:"10px"}}>{k.project_name || "-"}</td>}<td className="rankDomainCell">{d.domain || "—"}</td><td className="rankRankCell">{d.last_position || "-"}</td><td className="rankPageCell">{d.last_page || "-"}</td>{i === 0 && <td rowSpan={rowCount} style={{verticalAlign:"top",paddingTop:"10px"}}>{k.keyword}</td>}{i === 0 && <td rowSpan={rowCount} style={{verticalAlign:"top",paddingTop:"10px"}}><Badge status={k.suspicious_count ? "blocked" : "working"}/>{k.suspicious_count || 0}</td>}{i === 0 && <td rowSpan={rowCount} style={{verticalAlign:"top",paddingTop:"6px"}}><div className="actions"><button className="iconBtn" onClick={() => checkRank(k.id)}><RefreshCw size={14}/></button><button className="iconBtn" onClick={() => startEditRank(k)}><Pencil size={14}/></button><button className="iconBtn danger" onClick={() => delRank(k)}><Trash2 size={14}/></button></div></td>}</tr>))}</React.Fragment>); })())}</tbody></table></section>; }
  function renderSettingsPage() { return <section className="panel"><div className="panelHead"><h2><Settings size={20}/> Settings</h2><div className="tabs"><button className={tab === "system" ? "navActive" : ""} onClick={() => setTab("system")}>System</button><button className={tab === "telegram" ? "navActive" : ""} onClick={() => setTab("telegram")}>Telegram</button><button className={tab === "proxy" ? "navActive" : ""} onClick={() => setTab("proxy")}>Proxy Center</button><button className={tab === "nodes" ? "navActive" : ""} onClick={() => setTab("nodes")}>Provider Nodes</button><button className={tab === "project-tg" ? "navActive" : ""} onClick={() => setTab("project-tg")}>Project Groups</button></div></div>{tab === "system" &&  <form onSubmit={saveSettings} className="settingsGrid"><label><span>Check interval seconds</span><input value={settings.check_interval_seconds} onChange={(e) => setSettings({ ...settings, check_interval_seconds: e.target.value })}/></label><label><span>Retry confirmations</span><input value={settings.retry_confirmations} onChange={(e) => setSettings({ ...settings, retry_confirmations: e.target.value })}/></label><label className="wide"><span>Status keywords</span><input value={settings.status_keywords} onChange={(e) => setSettings({ ...settings, status_keywords: e.target.value })}/></label><button>Save System</button></form>}{tab === "telegram" && <form onSubmit={saveSettings} className="settingsGrid"><label className="wide"><span>Telegram Bot Token</span><input value={settings.telegram_bot_token || ""} onChange={(e) => setSettings({ ...settings, telegram_bot_token: e.target.value })} placeholder="123456:ABC..."/></label><label><span>Telegram Chat ID</span><input value={settings.telegram_chat_id || ""} onChange={(e) => setSettings({ ...settings, telegram_chat_id: e.target.value })} placeholder="-100xxxx or user id"/></label><button>Save Telegram</button><button type="button" onClick={tgTest}><Send size={16}/> Test</button></form>}{tab === "proxy" && <div><form onSubmit={addProxy} className="grid"><input placeholder="Name" value={proxy.name} onChange={(e) => setProxy({ ...proxy, name: e.target.value })}/><input placeholder="Provider" value={proxy.provider_name} onChange={(e) => setProxy({ ...proxy, provider_name: e.target.value })}/><input placeholder="Proxy URL" value={proxy.proxy_url} onChange={(e) => setProxy({ ...proxy, proxy_url: e.target.value })}/><select value={proxy.proxy_type} onChange={(e) => setProxy({ ...proxy, proxy_type: e.target.value })}><option value="http">HTTP/HTTPS</option><option value="socks">SOCKS</option></select><button>Add Proxy</button></form><div className="chips">{proxies.map((p) => <span key={p.id}>{p.provider_name}: {p.name} · {p.last_health_status || "unknown"}<button className="chipDelete" onClick={() => delProxy(p)}>×</button></span>)}</div></div>}{tab === "nodes" && <div><p className="hint">Provider Node = real checker di jaringan Telkomsel/XL/Indosat/IndiHome/Biznet lewat mini PC, VPS, Android Termux, atau Raspberry Pi.</p><form onSubmit={addNode} className="nodeForm"><input placeholder="Node name TELKOMSEL-JKT-01" value={nodeForm.name} onChange={(e) => setNodeForm({ ...nodeForm, name: e.target.value })}/><input placeholder="Provider Telkomsel" value={nodeForm.provider_name} onChange={(e) => setNodeForm({ ...nodeForm, provider_name: e.target.value })}/><select value={nodeForm.network_type} onChange={(e) => setNodeForm({ ...nodeForm, network_type: e.target.value })}><option value="mobile">Mobile</option><option value="broadband">Broadband</option><option value="proxy">Proxy</option><option value="vps">VPS</option></select><input placeholder="Endpoint https://node-url" value={nodeForm.endpoint_url} onChange={(e) => setNodeForm({ ...nodeForm, endpoint_url: e.target.value })}/><input placeholder="Secret key" value={nodeForm.secret_key} onChange={(e) => setNodeForm({ ...nodeForm, secret_key: e.target.value })}/><button><Server size={16}/> Add Node</button></form><div className="tableScroll"><table className="settingsNodeTable"><thead><tr><th>Name</th><th>Provider</th><th>Type</th><th>Health</th><th>Battery</th><th>Signal</th><th style={{width:80}}>On/Off</th><th style={{width:80}}>Actions</th></tr></thead><tbody>{nodes.map((n) => <tr key={n.id} className={n.is_active===false?'nodeRowDisabled':''}><td className="domainCell">{n.name}{n.is_active===false&&<span className="nodeOffBadge">OFF</span>}</td><td>{n.provider_name}</td><td>{n.raw_network_type || n.network_type}</td><td><HealthBadge status={n.last_health_status || "unknown"}/></td><td>{n.battery_percent === null || n.battery_percent === undefined ? "n/a" : `${n.battery_percent}%`}</td><td>{n.network_label || n.radio_type || n.signal_label || "n/a"}</td><td><button className={`smallBtn nodeToggleSettingsBtn ${n.is_active===false?'nodeEnableBtn':'nodeDisableBtn'}`} onClick={() => toggleNode(n)}><Power size={13}/> {n.is_active===false?'ON':'OFF'}</button></td><td><div className="actions"><button className="iconBtn" title="Ping node" onClick={() => pingNode(n)}><RefreshCw size={14}/></button><button className="iconBtn danger" onClick={() => delNode(n)}><Trash2 size={14}/></button></div></td></tr>)}</tbody></table></div></div>}{tab === "project-tg" && <div><p className="hint">Assign a dedicated Telegram Chat ID per project. Rank change alerts will be sent to the project group instead of the global chat.</p><table><thead><tr><th>Project</th><th>Current Chat ID</th><th>New Chat ID</th><th>Actions</th></tr></thead><tbody>{projectOptions.filter((p) => p !== "No Project").map((pName) => { const mapping = projectTgMappings.find((m) => m.project_name === pName); return <tr key={pName}><td>{pName}</td><td className="muted">{mapping ? mapping.telegram_chat_id : "-"}</td><td><input style={{width:"160px"}} placeholder="-100xxxx or user id" value={projectTgEdits[pName] || ""} onChange={(e) => setProjectTgEdits((prev) => ({ ...prev, [pName]: e.target.value }))}/></td><td><div className="actions"><button className="smallBtn" onClick={() => saveProjectTg(pName)}>Save</button>{mapping && <button className="smallBtn danger" onClick={() => deleteProjectTg(pName)}>Remove</button>}</div></td></tr>; })}</tbody></table>{projectOptions.filter((p) => p !== "No Project").length === 0 && <p className="muted">No projects found. Create projects first in the Projects page.</p>}</div>}</section>; }
  return <div className="app">{renderMobileHeader()}{renderMobileDropdown()}{renderNav()}{isDemo && <div className="demoBanner"><span>🔒 Demo Mode — read only.</span><button className="demoBannerBtn" onClick={onLogout}>Login as admin</button></div>}<main>{page === "dashboard" && renderDashboardPage()}{page === "projects" && renderProjectsPage()}{page === "rank" && renderRankPage()}{page === "settings" && renderSettingsPage()}{page === "defense" && <DefenseCenterPage isDemo={isDemo}/>}{page === "analytics" && <AnalyticsPage/>}{page === "trustpositif" && <TrustPositifPage/>}{page === "users" && renderUserActivityPage()}</main>{cardPopup && <DomainPopup popup={cardPopup} onClose={() => setCardPopup(null)}/>}</div>;
}

function App() { const [checked, setChecked] = useState(false); const [auth, setAuth] = useState(false); const [isDemo, setIsDemo] = useState(false); const [error, setError] = useState(""); async function checkAuth() { try { const me = await api("/api/auth/me"); setAuth(Boolean(me.authenticated)); setIsDemo(Boolean(me.isDemo)); } catch (err) { setError(err.message || "Auth check failed"); setAuth(false); } finally { setChecked(true); } } useEffect(() => { checkAuth(); }, []); if (!checked) return <div className="loading">Loading Domain Radar...</div>; if (!auth) return <><Login onLogin={async () => { await checkAuth(); }}/>{error ? <div className="bootError">{error}</div> : null}</>; return <Dashboard onLogout={() => { setAuth(false); setIsDemo(false); }} isDemo={isDemo}/>; }
const rootEl = document.getElementById("root"); if (rootEl) createRoot(rootEl).render(<App/>);
