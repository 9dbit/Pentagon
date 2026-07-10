import React, { useState, useEffect, useCallback } from "react";
import "./DefenseCenterPage.css";

async function api(url, opt = {}) {
  const res = await fetch(url, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opt });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) { const err = new Error(data.error || "Request failed"); err.status = res.status; throw err; }
  return data;
}

function timeAgo(d) {
  if (!d) return "never";
  const s = Math.round((Date.now() - new Date(d)) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

function Pill({ type, text }) {
  const cls = type === "whitelisted" || type === "found" ? "ok"
    : type === "entity_website" || type === "backlink" || type === "external_safe" ? "ext"
    : type === "suspicious" ? "bad"
    : "warn";
  return <span className={`pill ${cls}`}>{text || type}</span>;
}

function RankMetric({ value, label, isPageOne }) {
  if (!value && value !== 0) return <span className="rankMetric empty">-</span>;
  return (
    <span className={`rankMetric${isPageOne ? " trophy" : ""}`}>
      {isPageOne && <span className="trophyIcon">🏆</span>}
      <small>{label}</small>
      <b>{value}</b>
    </span>
  );
}

function MoveDropdown({ currentGroup, onMove, disabled }) {
  const all = [
    { value: "whitelisted", label: "→ Whitelisted" },
    { value: "entity_website", label: "→ Entity Website" },
    { value: "backlink", label: "→ Backlink" },
    { value: "non-whitelisted", label: "→ Non-Whitelisted" },
  ];
  const options = all.filter((o) => o.value !== currentGroup);

  function handleChange(e) {
    const val = e.target.value;
    if (!val) return;
    onMove(val);
    e.target.value = "";
  }

  return (
    <select className="moveDropdown" onChange={handleChange} value="" disabled={disabled} title="Move to group">
      <option value="">Move to…</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function NodeRankGrid({ group, nodes, nodePositions }) {
  const activeNodes = nodes.filter(n => n.is_active !== false);
  const posMap = {};
  for (const np of nodePositions.filter(np => Number(np.group_id) === Number(group.id))) {
    if (!posMap[np.domain]) posMap[np.domain] = {};
    posMap[np.domain][np.node_id == null ? "vps" : String(np.node_id)] = np;
  }
  const whitelisted = (group.domains || []).filter(d => d.is_whitelisted);
  if (!whitelisted.length && !activeNodes.length) return null;
  const checkers = [
    { key: "vps", label: "VPS" },
    ...activeNodes.map(n => ({ key: String(n.id), label: (n.name || n.provider_name || `N${n.id}`).replace(/\s+/g, "").slice(0, 8) }))
  ];
  return (
    <div className="subGroup nodeRankGrid">
      <div className="subGroupLabel">Rank per Checker</div>
      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: "40%" }}>Domain</th>
              {checkers.map(c => <th key={c.key} style={{ minWidth: 52 }}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {whitelisted.map(d => (
              <tr key={d.domain}>
                <td className="domain">{d.domain}</td>
                {checkers.map(c => {
                  const np = posMap[d.domain]?.[c.key];
                  return (
                    <td key={c.key}>
                      {np
                        ? <RankMetric value={`#${np.position}`} label="" isPageOne={Number(np.page) === 1} />
                        : <span className="rankMetric empty">-</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function DefenseCenterPage({ isDemo = false }) {
  const [groups, setGroups] = useState([]);
  const [results, setResults] = useState([]);
  const [projects, setProjects] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [nodePositions, setNodePositions] = useState([]);
  const [notice, setNotice] = useState("");
  const [intel, setIntel] = useState(null);
  const demoGuard = () => { if (isDemo) { setNotice("Demo mode — read only. Log in as admin to make changes."); return true; } return false; };
  const [movingId, setMovingId] = useState(null);
  const [projectMode, setProjectMode] = useState("existing");
  const [form, setForm] = useState({
    projectSelect: "", projectNew: "", keyword: "",
    targetUrl: "", singleDomain: "", domains: "",
  });

  const pf = (patch) => setForm((f) => ({ ...f, ...patch }));

  const groupResults = useCallback(
    (g) => results.filter((r) => Number(r.group_id) === Number(g.id)),
    [results]
  );

  const projectNames = [...new Set([
    ...projects.map((p) => p.project_name || p.name).filter(Boolean),
    ...groups.map((g) => g.project_name).filter(Boolean),
  ])].sort();

  const loadAll = useCallback(async () => {
    try {
      const [g, r, np] = await Promise.all([
        api("/api/rank/keywords"),
        api("/api/rank/results"),
        api("/api/rank/node-positions").catch(() => []),
      ]);
      let p = [], nd = [];
      try { p = await api("/api/projects"); } catch (_) {}
      try { nd = await api("/api/nodes"); } catch (_) {}
      setGroups(Array.isArray(g) ? g : []);
      setResults(Array.isArray(r) ? r : []);
      setNodePositions(Array.isArray(np) ? np : []);
      setProjects(Array.isArray(p) ? p : []);
      setNodes(Array.isArray(nd) ? nd : []);
    } catch (err) {
      setNotice(err.message || "Failed to load data.");
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const selectedProject = () =>
    projectMode === "new" ? form.projectNew.trim() : form.projectSelect.trim();

  const domainPayload = () =>
    [form.singleDomain, form.domains].filter(Boolean).join("\n");

  async function addKeyword(e) {
    e.preventDefault();
    if (demoGuard()) return;
    const keyword = form.keyword.trim();
    const domains = domainPayload().trim();
    const project = selectedProject();
    if (!project) return setNotice("Please select or enter a project name.");
    if (!keyword) return setNotice("Please enter a keyword.");
    if (!domains) return setNotice("Please enter at least one whitelisted domain.");
    setNotice("Saving keyword group...");
    try {
      await api("/api/rank/keywords", {
        method: "POST",
        body: JSON.stringify({ project_name: project, keyword, domain: domains, target_url: form.targetUrl.trim() }),
      });
      pf({ singleDomain: "", domains: "", targetUrl: "" });
      setNotice("Saved and merged.");
      await loadAll();
    } catch (err) {
      setNotice("Error: " + err.message);
    }
  }

  async function checkGroup(id) {
    if (demoGuard()) return;
    setNotice("Scanning Google Top 100 results...");
    try {
      await api(`/api/rank/check/${id}`, { method: "POST" });
      setNotice("Scan completed.");
      await loadAll();
    } catch (err) {
      setNotice("Scan failed: " + err.message);
    }
  }

  async function checkAll() {
    if (demoGuard()) return;
    setNotice("Scanning all active keyword groups...");
    try {
      await api("/api/rank/check-all", { method: "POST" });
      setNotice("All scans completed.");
      await loadAll();
    } catch (err) {
      setNotice("Scan failed: " + err.message);
    }
  }

  async function syncLpMs() {
    if (demoGuard()) return;
    setNotice("Syncing LP/MS domains to rank groups...");
    try {
      const r = await api("/api/rank/sync-lp-ms", { method: "POST" });
      setNotice(`Synced ${r.synced} domain${r.synced !== 1 ? "s" : ""} from LP/MS labels.`);
      await loadAll();
    } catch (err) {
      setNotice("Sync failed: " + err.message);
    }
  }

  async function delGroup(id) {
    if (demoGuard()) return;
    if (!confirm("Delete this keyword group?")) return;
    try {
      await api(`/api/rank/keywords/${id}`, { method: "DELETE" });
      await loadAll();
    } catch (err) {
      setNotice("Delete failed: " + err.message);
    }
  }

  function buildReportText(x, host) {
    const ns = Array.isArray(x.nameservers) ? x.nameservers.join(", ") : "-";
    return `Phishing / suspicious domain report\n\nDomain: ${x.domain || host}\nIP: ${x.ip || "-"}\nNameserver: ${ns}\nRegistrar: ${x.registrar || "-"}\nNetwork: ${x.network_name || "-"}\nASN/Handle: ${x.asn || "-"}\nAbuse contact: ${x.abuse_email || "-"}\n\nReason: This domain appeared as a non-whitelisted Google result for a monitored brand keyword in Domain Radar and may be impersonating the brand. Please investigate and suspend/remove if it violates your abuse policy.`;
  }

  async function openIntel(host) {
    setIntel({ host, data: null, reportText: "" });
    try {
      const x = await api(`/api/rank/intel/${encodeURIComponent(host)}`);
      setIntel({ host, data: x, reportText: buildReportText(x, host) });
    } catch (err) {
      setIntel({ host, data: { _error: err.message }, reportText: "" });
    }
  }

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(intel?.reportText || "");
      setNotice("Report text copied.");
    } catch (_) {
      setNotice("Copy failed. Select and copy manually.");
    }
  }

  async function whitelistDomain(groupId, domain) {
    await api(`/api/rank/keywords/${groupId}/whitelist-domain`, {
      method: "POST",
      body: JSON.stringify({ domain }),
    });
  }

  async function unwhitelistDomain(groupId, domain) {
    await api(`/api/rank/keywords/${groupId}/whitelist-domain`, {
      method: "DELETE",
      body: JSON.stringify({ domain }),
    });
  }

  async function classifyResult(resultId, classification) {
    await api(`/api/rank/results/${resultId}/classify`, {
      method: "POST",
      body: JSON.stringify({ classification }),
    });
    setResults((prev) =>
      prev.map((r) => (Number(r.id) === Number(resultId) ? { ...r, classification } : r))
    );
  }

  async function moveScanResult(r, groupId, targetGroup) {
    const key = `result-${r.id}`;
    setMovingId(key);
    try {
      if (targetGroup === "whitelisted") {
        await whitelistDomain(groupId, r.domain);
        await classifyResult(r.id, "whitelisted");
      } else if (targetGroup === "non-whitelisted") {
        await classifyResult(r.id, "suspicious");
      } else {
        await classifyResult(r.id, targetGroup);
      }
      await loadAll();
    } catch (err) {
      setNotice("Move failed: " + err.message);
    } finally {
      setMovingId(null);
    }
  }

  async function moveWhitelistedDomain(groupId, domain, targetGroup) {
    const key = `wl-${groupId}-${domain}`;
    setMovingId(key);
    setNotice(`Moving ${domain}…`);
    try {
      await unwhitelistDomain(groupId, domain);
      const scanResult = results.find(
        (r) => Number(r.group_id) === Number(groupId) && r.domain === domain
      );
      if (scanResult) {
        const classification = targetGroup === "non-whitelisted" ? "suspicious"
          : targetGroup === "entity_website" ? "entity_website"
          : targetGroup === "backlink" ? "backlink"
          : "unknown";
        await classifyResult(scanResult.id, classification);
      }
      setNotice(`${domain} moved to ${targetGroup.replace(/-/g, " ")}.`);
      await loadAll();
    } catch (err) {
      setNotice("Move failed: " + err.message);
    } finally {
      setMovingId(null);
    }
  }

  const totalKw = groups.length;
  const totalDomains = groups.reduce((a, g) => a + (g.domains?.length || 0), 0);
  const foundDomains = groups.reduce((a, g) => a + (g.domains || []).filter((d) => d.last_position).length, 0);
  const suspiciousTotal = results.filter((r) => r.classification === "suspicious").length;

  return (
    <div className="defensePage contentMain">
      <header>
        <div className="brand">
          <h1>Rank Defense Center</h1>
          <p>Google Top 100 rank scanner, whitelist control, and suspicious domain intelligence.</p>
        </div>
        <div className="toolbar">
          <button onClick={loadAll}>Refresh</button>
          <button onClick={syncLpMs}>Sync LP/MS</button>
          <button className="primaryBtn" onClick={checkAll}>Check All</button>
        </div>
      </header>

      <section className="panel formPanel">
        <form className="inputGrid" onSubmit={addKeyword} noValidate>
          <div className="modeInput">
            <label className="fieldLabel">Project Mode</label>
            <select value={projectMode} onChange={(e) => setProjectMode(e.target.value)}>
              <option value="existing">Existing Project</option>
              <option value="new">New Project</option>
            </select>
          </div>
          {projectMode === "existing" ? (
            <div className="projectSelect">
              <label className="fieldLabel">Existing Project</label>
              <select value={form.projectSelect} onChange={(e) => pf({ projectSelect: e.target.value })}>
                {projectNames.length
                  ? projectNames.map((n) => <option key={n} value={n}>{n}</option>)
                  : <option value="">No project yet</option>}
              </select>
            </div>
          ) : (
            <div className="projectNew">
              <label className="fieldLabel">New Project</label>
              <input value={form.projectNew} onChange={(e) => pf({ projectNew: e.target.value })} placeholder="New project name" />
            </div>
          )}
          <div className="keywordInput">
            <label className="fieldLabel">Keyword</label>
            <input value={form.keyword} onChange={(e) => pf({ keyword: e.target.value })} placeholder="Keyword, example: empire88" />
          </div>
          <div className="targetInput">
            <label className="fieldLabel">Target URL Optional</label>
            <input value={form.targetUrl} onChange={(e) => pf({ targetUrl: e.target.value })} placeholder="https://example.com/page" />
          </div>
          <div className="singleDomain">
            <label className="fieldLabel">Add Whitelisted Domain</label>
            <input value={form.singleDomain} onChange={(e) => pf({ singleDomain: e.target.value })} placeholder="example.com" />
          </div>
          <div className="domainInput">
            <label className="fieldLabel">Bulk Whitelisted Domains</label>
            <textarea
              value={form.domains}
              onChange={(e) => pf({ domains: e.target.value })}
              placeholder={"One domain per line or comma separated\nempire88-as1.pages.dev\nempire88livescore.com\nempire88apk.com"}
            />
          </div>
          <div className="submitArea">
            <button className="submitBtn" type="submit">Add / Merge</button>
          </div>
        </form>
        {notice && <div className="notice">{notice}</div>}
      </section>

      <section className="cards">
        <div className="card"><b>{totalKw}</b><span>Keyword Groups</span></div>
        <div className="card"><b>{totalDomains}</b><span>Whitelisted Domains</span></div>
        <div className="card"><b>{foundDomains}</b><span>Domains Found</span></div>
        <div className="card"><b>{suspiciousTotal}</b><span>Suspicious Results</span></div>
      </section>

      <section className="panel">
        <div className="kwGrid">
          {groups.length === 0 && (
            <p className="muted" style={{ padding: "16px" }}>No keyword groups yet. Add one above.</p>
          )}
          {groups.map((g) => {
            const gRes = groupResults(g);
            const susp = gRes.filter((r) => r.classification === "suspicious");
            const entityResults = gRes.filter((r) => r.classification === "entity_website");
            const backlinkResults = gRes.filter((r) => r.classification === "backlink");
            const nonWhite = gRes.filter((r) => !["whitelisted", "entity_website", "backlink"].includes(r.classification));

            return (
              <article key={g.id} className="kw">
                <div className="kwHead">
                  <div className="kwInfo">
                    <h2>{g.keyword}</h2>
                    <div className="muted">{g.project_name || "-"} · {g.domain_count || 0} domain</div>
                  </div>
                  <div className="kwLast">
                    <span className="kwLastLbl">LAST</span> {timeAgo(g.last_checked_at)}
                  </div>
                  <div className="kwRight">
                    <Pill type="warn" text={`Suspicious ${susp.length}`} />
                    <div className="toolbar">
                      <button onClick={() => checkGroup(g.id)}>Check</button>
                      <button onClick={() => delGroup(g.id)}>Delete</button>
                    </div>
                  </div>
                </div>

                <div className="cols">
                  {/* LEFT — TRUSTED */}
                  <div className="sub trustedPane">
                    <h3 className="paneTitle">✅ Trusted Domains</h3>

                    <div className="subGroup">
                      <div className="subGroupLabel">Whitelisted ({(g.domains || []).filter(d => d.is_whitelisted).length})</div>
                      <div className="tableWrap">
                        <table>
                          <thead>
                            <tr>
                              <th style={{ width: "40%" }}>Domain</th>
                              <th>Status</th>
                              <th className="wlDeskOnly">Page</th>
                              <th className="wlDeskOnly">Rank</th>
                              <th>Move</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(g.domains || []).filter(d => d.is_whitelisted).map((d) => {
                              const href = d.last_matched_url || `https://${d.domain}`;
                              const moveKey = `wl-${g.id}-${d.domain}`;
                              return (
                                <tr key={d.domain}>
                                  <td className="domain" data-label="Domain">
                                    <a className="wlLink" href={href} target="_blank" rel="noopener noreferrer">{d.domain}</a>
                                    {d.domain_label === 'landing_page' && <span className="landingChip">LP</span>}
                                    {d.domain_label === 'ms' && <span className="msChip">MS</span>}
                                  </td>
                                  <td data-label="Status">
                                    <Pill type={d.last_status === "found" ? "found" : "warn"} text={d.last_status || "pending"} />
                                  </td>
                                  <td className="wlDeskOnly" data-label="Page">
                                    <RankMetric value={d.last_page} label="PAGE" isPageOne={Number(d.last_page) === 1} />
                                  </td>
                                  <td className="wlDeskOnly" data-label="Rank">
                                    <RankMetric value={d.last_position ? `#${d.last_position}` : null} label="#" isPageOne={false} />
                                  </td>
                                  <td data-label="Move">
                                    <MoveDropdown
                                      currentGroup="whitelisted"
                                      disabled={movingId === moveKey}
                                      onMove={(target) => moveWhitelistedDomain(g.id, d.domain, target)}
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                            {(g.domains || []).filter(d => d.is_whitelisted).length === 0 && (
                              <tr><td colSpan={5} className="muted" style={{ fontSize: "12px", padding: "8px" }}>No whitelisted domains.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <NodeRankGrid group={g} nodes={nodes} nodePositions={nodePositions} />

                    {entityResults.length > 0 && (
                      <div className="subGroup">
                        <div className="subGroupLabel">Entity Website ({entityResults.length})</div>
                        <div className="resultList">
                          {entityResults.map((r) => (
                            <div key={r.id} className="resultRow trusted">
                              <div className="hostLine">
                                <div className="resultTopRow">
                                  <a target="_blank" href={r.matched_url || "#"} rel="noopener noreferrer">{r.domain || "-"}</a>
                                  {r.position && r.page && <span className="rankLabel">Rank {r.position}, Page {r.page}</span>}
                                </div>
                                <div className="titleLine">{r.title || "No title"}</div>
                              </div>
                              <div className="resultFooter">
                                <Pill type="ext" text="Entity" />
                                <MoveDropdown
                                  currentGroup="entity_website"
                                  disabled={movingId === `result-${r.id}`}
                                  onMove={(target) => moveScanResult(r, g.id, target)}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {backlinkResults.length > 0 && (
                      <div className="subGroup">
                        <div className="subGroupLabel">Backlink ({backlinkResults.length})</div>
                        <div className="resultList">
                          {backlinkResults.map((r) => (
                            <div key={r.id} className="resultRow trusted">
                              <div className="hostLine">
                                <div className="resultTopRow">
                                  <a target="_blank" href={r.matched_url || "#"} rel="noopener noreferrer">{r.domain || "-"}</a>
                                  {r.position && r.page && <span className="rankLabel">Rank {r.position}, Page {r.page}</span>}
                                </div>
                                <div className="titleLine">{r.title || "No title"}</div>
                              </div>
                              <div className="resultFooter">
                                <Pill type="ext" text="Backlink" />
                                <MoveDropdown
                                  currentGroup="backlink"
                                  disabled={movingId === `result-${r.id}`}
                                  onMove={(target) => moveScanResult(r, g.id, target)}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* RIGHT — NON-WHITELISTED */}
                  <div className="sub suspiciousPane">
                    <h3 className="paneTitle">⚠️ Non-Whitelisted / Suspicious</h3>
                    <div className="resultList">
                      {nonWhite.map((r) => (
                        <div key={r.id || `${r.group_id}-${r.domain}-${r.position}-${Math.random()}`} className="resultRow">
                          <div className="hostLine">
                            <div className="resultTopRow">
                              <a target="_blank" href={r.matched_url || "#"} rel="noopener noreferrer">{r.domain || "-"}</a>
                              {r.position && r.page && (
                                <span className="rankLabel">Rank {r.position}, Page {r.page}</span>
                              )}
                            </div>
                            <div className="titleLine">{r.title || "No title"}</div>
                            <div className="reasonLine">{r.reason || "-"}</div>
                          </div>
                          <div className="resultFooter">
                            <Pill type={r.classification} text={r.classification} />
                            <div className="resultActions">
                              <MoveDropdown
                                currentGroup="non-whitelisted"
                                disabled={movingId === `result-${r.id}`}
                                onMove={(target) => moveScanResult(r, g.id, target)}
                              />
                              <button className="intelBtn" onClick={() => openIntel(r.domain)}>Intel</button>
                            </div>
                          </div>
                        </div>
                      ))}
                      {nonWhite.length === 0 && (
                        <p className="muted" style={{ fontSize: "12px", padding: "8px 0" }}>No suspicious results.</p>
                      )}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {intel && (
        <div
          className="modalBackdrop active"
          style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.72)" }}
          onClick={(e) => { if (e.currentTarget === e.target) setIntel(null); }}
        >
          <div
            className="modal"
            style={{ width: "min(600px, 95vw)", maxHeight: "85vh", overflow: "auto", borderRadius: "16px", background: "#18191c", border: "1px solid rgba(255,255,255,.08)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
              <h2 style={{ margin: 0, fontSize: "16px", color: "#fff" }}>{intel.host}</h2>
              <button onClick={() => setIntel(null)} style={{ background: "#2f3136", border: 0, color: "#fff", borderRadius: "8px", padding: "6px 14px", cursor: "pointer", fontWeight: 700 }}>Close</button>
            </div>
            <div style={{ padding: "16px 20px" }}>
              {!intel.data ? (
                <p className="muted">Loading intelligence...</p>
              ) : intel.data._error ? (
                <p className="muted">{intel.data._error}</p>
              ) : (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", border: "1px solid rgba(255,255,255,.08)", borderRadius: "12px", overflow: "hidden", marginBottom: "16px" }}>
                    {[
                      ["Domain", intel.data.domain || intel.host],
                      ["IP", intel.data.ip || "-"],
                      ["Nameserver", Array.isArray(intel.data.nameservers) ? intel.data.nameservers.join(", ") : "-"],
                      ["Registrar", intel.data.registrar || "-"],
                      ["Network", intel.data.network_name || "-"],
                      ["ASN/Handle", intel.data.asn || "-"],
                      ["Abuse", intel.data.abuse_email || "-"],
                      ["Primary Report", intel.data.report_url
                        ? <a href={intel.data.report_url} target="_blank" rel="noopener noreferrer" style={{ color: "#69a8ff" }}>{intel.data.report_url}</a>
                        : "-"],
                    ].map(([k, v], i) => (
                      <React.Fragment key={k}>
                        <div style={{ padding: "10px", background: "#101116", color: "#9ca3af", fontSize: "12px", borderBottom: i < 7 ? "1px solid rgba(255,255,255,.06)" : "none" }}>{k}</div>
                        <div style={{ padding: "10px", color: "#d1d5db", fontSize: "12px", wordBreak: "break-all", borderBottom: i < 7 ? "1px solid rgba(255,255,255,.06)" : "none" }}>{v}</div>
                      </React.Fragment>
                    ))}
                  </div>
                  <div style={{ background: "#18191c", border: "1px solid rgba(255,255,255,.08)", borderRadius: "12px", padding: "16px" }}>
                    <h3 style={{ color: "#e5e7eb", fontSize: "13px", margin: "0 0 12px", fontWeight: 700 }}>Report Options</h3>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
                      {intel.data.report_url && (
                        <a target="_blank" href={intel.data.report_url} rel="noopener noreferrer" style={{ background: "#2f3136", color: "#fff", padding: "6px 12px", borderRadius: "8px", textDecoration: "none", fontSize: "12px" }}>Primary Report</a>
                      )}
                      <a target="_blank" href="https://abuse.cloudflare.com/" rel="noopener noreferrer" style={{ background: "#2f3136", color: "#fff", padding: "6px 12px", borderRadius: "8px", textDecoration: "none", fontSize: "12px" }}>Cloudflare Abuse</a>
                      <a target="_blank" href={`https://safebrowsing.google.com/safebrowsing/report_phish/?url=https://${encodeURIComponent(intel.data.domain || intel.host)}`} rel="noopener noreferrer" style={{ background: "#2f3136", color: "#fff", padding: "6px 12px", borderRadius: "8px", textDecoration: "none", fontSize: "12px" }}>Google Safe Browsing</a>
                      <a target="_blank" href={`https://www.google.com/search?q=${encodeURIComponent(`${intel.data.domain || intel.host} registrar abuse report`)}`} rel="noopener noreferrer" style={{ background: "#2f3136", color: "#fff", padding: "6px 12px", borderRadius: "8px", textDecoration: "none", fontSize: "12px" }}>Registrar Abuse</a>
                      <a target="_blank" href={`https://www.google.com/search?q=${encodeURIComponent(`${intel.data.domain || intel.host} hosting abuse ${intel.data.ip || ""} ${intel.data.network_name || ""}`)}`} rel="noopener noreferrer" style={{ background: "#2f3136", color: "#fff", padding: "6px 12px", borderRadius: "8px", textDecoration: "none", fontSize: "12px" }}>Hosting Abuse</a>
                      <button onClick={copyReport} style={{ background: "#20d46b", color: "#06100a", padding: "6px 14px", borderRadius: "8px", border: 0, cursor: "pointer", fontSize: "12px", fontWeight: 700 }}>Copy Report Text</button>
                    </div>
                    <pre style={{ background: "#101116", border: "1px solid rgba(255,255,255,.08)", borderRadius: "8px", padding: "12px", fontSize: "11px", color: "#9ca3af", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>
                      {intel.reportText}
                    </pre>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
