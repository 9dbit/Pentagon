import React, { useMemo, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, CircleAlert, Plus, RefreshCw, Search, Pencil, Trash2, X } from "lucide-react";
import WhitelistRankResults from "./WhitelistRankResults";

// Presentation-only report. Reads and mutations remain in existing Dashboard handlers.
const positive = x => Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : null;
const scanDate = date => !date || !Number.isFinite(new Date(date).getTime())
  ? "Not checked yet"
  : new Date(date).toLocaleString(undefined, { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });

export function rankDomains(group) {
  const domains = Array.isArray(group?.domains) ? group.domains.filter(d => d && d.is_whitelisted) : [];
  return domains;
}

function Metric({ label, value, emphasis }) {
  return <div className={"rankReportMetric" + (emphasis ? " attention" : "")}><span>{label}</span><strong>{value}</strong></div>;
}

export default function GoogleRankReport({
  rank = [], rankForm, onRankFormChange, onAdd, onCheckAll, onCheck,
  onOpenDefense, editingRank, editRankForm, onEditChange,
  onStartEdit, onSaveEdit, onCancelEdit, onDelete, isDemo = false
}) {
  const [query,setQuery] = useState("");
  const [attentionOnly,setAttentionOnly] = useState(false);
  const [showComposer,setShowComposer] = useState(false);
  const groups = Array.isArray(rank) ? rank : [];
  const summary = useMemo(() => {
    const tracked = new Set(), ranked = new Set();
    let flagged = 0;
    for (const group of groups) {
      flagged += Math.max(0, Number(group.suspicious_count) || 0);
      for (const d of rankDomains(group)) {
        if (!d.domain || d.domain === "Not specified") continue;
        const key = String(d.domain).toLowerCase();
        tracked.add(key);
        if (positive(d.last_position)) ranked.add(key);
      }
    }
    return { groups:groups.length, domains:tracked.size, ranked:ranked.size, flagged };
  }, [rank]);
  const visible = useMemo(() => {
    const q = query.toLowerCase().trim();
    return groups.filter(group => {
      if (attentionOnly && !(Number(group.suspicious_count) > 0)) return false;
      if (!q) return true;
      return [group.keyword, group.project_name, ...rankDomains(group).map(d => d.domain)]
        .some(value => String(value || "").toLowerCase().includes(q));
    });
  }, [rank, query, attentionOnly]);

  return <div className="rankReport reportSurface">
    <header className="reportHeader">
      <div className="reportHeaderCopy">
        <div className="reportEyebrow">SEARCH VISIBILITY / REPORT</div>
        <h1>Google Rank</h1>
        <p>Review saved ranking snapshots by keyword and domain. Spot results that need attention and run a new scan when needed.</p>
      </div>
      <div className="reportHeaderActions">
        <button className="reportBtn reportBtnQuiet" type="button" onClick={onOpenDefense}>Defence Center <ArrowUpRight size={15} aria-hidden="true" /></button>
        <button className="reportBtn reportBtnPrimary" type="button" onClick={onCheckAll} disabled={isDemo || !groups.length}><RefreshCw size={15} aria-hidden="true" /> Check all ranks</button>
      </div>
    </header>
    <section className="rankReportMetrics" aria-label="Google Rank summary">
      <Metric label="Keyword groups" value={summary.groups} />
      <Metric label="Tracked domains" value={summary.domains} />
      <Metric label="Domains ranked" value={summary.ranked} />
      <Metric label="Flagged results" value={summary.flagged} emphasis={summary.flagged > 0} />
    </section>
    <div className={"reportInsight" + (summary.flagged ? " hasAttention" : "")} role="status">
      {summary.flagged ? <CircleAlert size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
      <span>{summary.flagged
        ? summary.flagged + " flagged result(s) in saved scans. Review classifications in Defence Center before acting."
        : groups.length ? "No flagged results recorded. Run a scan to refresh these snapshots."
        : "No keyword groups yet. Add a keyword and domain to begin tracking."}</span>
    </div>
    <div className="reportListHeader">
      <div><h2>Keyword reports</h2><p>Rank and page values come from stored scans, not live Google results.</p></div>
      <button type="button" className="reportBtn reportBtnQuiet" aria-expanded={showComposer} aria-controls="rank-new-keyword-form" onClick={() => setShowComposer(x => !x)}>
        {showComposer ? <X size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}{showComposer ? "Close form" : "Add keyword"}
      </button>
    </div>
    {showComposer && <section className="rankReportComposer" id="rank-new-keyword-form" aria-label="Add keyword group">
      <form className="rankReportForm" onSubmit={onAdd}>
        <label>Project name<input value={rankForm.project_name} onChange={e => onRankFormChange({ ...rankForm, project_name:e.target.value })} placeholder="Project name" required disabled={isDemo} /></label>
        <label>Keyword<input value={rankForm.keyword} onChange={e => onRankFormChange({ ...rankForm, keyword:e.target.value })} placeholder="Search keyword" required disabled={isDemo} /></label>
        <label className="rankReportWide">Domains<textarea rows={2} value={rankForm.domain} onChange={e => onRankFormChange({ ...rankForm, domain:e.target.value })} placeholder="domain-one.com, domain-two.com" required disabled={isDemo} /></label>
        <label className="rankReportWide">Target URL <small>(optional)</small><input value={rankForm.target_url} onChange={e => onRankFormChange({ ...rankForm, target_url:e.target.value })} placeholder="https://example.com/page" disabled={isDemo} /></label>
        <div className="rankReportFormFooter"><span>Existing keywords are merged into their group.</span><button className="reportBtn reportBtnPrimary" type="submit" disabled={isDemo}><Plus size={15} aria-hidden="true" /> Add / merge</button></div>
      </form>
    </section>}
    <div className="rankReportFilters">
      <label className="rankReportSearch"><Search size={17} aria-hidden="true" /><span className="reportSrOnly">Search keyword groups, projects or domains</span>
        <input type="search" placeholder="Search keyword, project, or domain" value={query} onChange={e => setQuery(e.target.value)} />
      </label>
      <button type="button" className={"reportBtn reportFilterBtn" + (attentionOnly ? " isSelected" : "")} aria-pressed={attentionOnly} onClick={() => setAttentionOnly(x => !x)}>
        <CircleAlert size={15} aria-hidden="true" /> Flagged only
      </button>
      <span className="rankReportResultCount">{visible.length} of {groups.length} groups</span>
    </div>
    <div className="rankReportGroups">
      {!visible.length && <div className="reportEmpty"><h3>{groups.length ? "No matching keyword groups" : "Nothing to report yet"}</h3>
        <p>{groups.length ? "Try another search or clear the flagged-only filter." : "Use Add keyword above to create a group."}</p></div>}
      {visible.map(group => {
        const domains = rankDomains(group);
        const flagged = Math.max(0, Number(group.suspicious_count) || 0);
        const isEditing = editingRank === group.id;
        return <article className="rankReportGroup" key={group.id}>
          <div className="rankReportGroupHead">
            <div className="rankReportTitleBlock">
              <div className="rankReportMeta">{group.project_name || "Unassigned project"} <span aria-hidden="true">·</span> {scanDate(group.last_checked_at)}</div>
              <h3>{group.keyword || "Untitled keyword"}</h3>
              <p>{domains.length} tracked domain(s) <span aria-hidden="true">·</span> {flagged ? flagged + " flagged result(s)" : "No flagged results recorded"}</p>
            </div>
            <div className="rankReportGroupActions">
              {flagged > 0 && <span className="rankReportFlag">{flagged} flagged</span>}
              <button type="button" className="reportBtn reportBtnQuiet" onClick={() => onCheck(group.id)} disabled={isDemo} title={"Check " + group.keyword}><RefreshCw size={14} aria-hidden="true" /> Scan</button>
              <button type="button" className="reportBtn reportBtnQuiet" onClick={() => onStartEdit(group)} disabled={isDemo} title={"Edit " + group.keyword}><Pencil size={14} aria-hidden="true" /> Edit</button>
              <button type="button" className="reportBtn reportBtnDanger" onClick={() => onDelete(group)} disabled={isDemo} title={"Delete " + group.keyword}><Trash2 size={14} aria-hidden="true" /> Delete</button>
            </div>
          </div>
          {isEditing ? <form className="rankReportEditForm" onSubmit={e => { e.preventDefault(); onSaveEdit(group); }}>
            <label>Project name<input value={editRankForm.project_name} onChange={e => onEditChange({ ...editRankForm, project_name:e.target.value })} disabled={isDemo} /></label>
            <label>Keyword<input value={editRankForm.keyword} onChange={e => onEditChange({ ...editRankForm, keyword:e.target.value })} disabled={isDemo} /></label>
            <label className="rankReportWide">Domains<textarea rows={2} value={editRankForm.domains} onChange={e => onEditChange({ ...editRankForm, domains:e.target.value })} disabled={isDemo} /></label>
            <label className="rankReportWide">Target URL <small>(optional)</small><input value={editRankForm.target_url} onChange={e => onEditChange({ ...editRankForm, target_url:e.target.value })} disabled={isDemo} /></label>
            <div className="rankReportFormFooter"><span>Changes apply to this keyword group only.</span><button type="button" className="reportBtn reportBtnQuiet" onClick={onCancelEdit}>Cancel</button><button type="submit" className="reportBtn reportBtnPrimary" disabled={isDemo}>Save changes</button></div>
          </form> : <WhitelistRankResults domains={domains} keyword={group.keyword}/>}
        </article>;
      })}
    </div>
    <div className="reportFootnote"><ChevronDown size={15} aria-hidden="true" /> Results are snapshots. Use Defence Center to review unfamiliar domains and suspicious classifications.</div>
  </div>;
}
