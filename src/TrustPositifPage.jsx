import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, CheckCircle2, Clock, Database, HardDrive,
  RefreshCw, Search, Server, ShieldCheck, Wifi, XCircle
} from "lucide-react";
import "./TrustPositifPage.css";

async function api(url, opt = {}) {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opt
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function formatBytes(value) {
  const n = Number(value || 0);
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(value) {
  if (!value) return "Never";
  try { return new Date(value).toLocaleString("id-ID"); } catch (_) { return String(value); }
}

function ResultBadge({ ok, label, neutral = false }) {
  return (
    <span className={`tpResultBadge ${neutral ? "neutral" : ok ? "ok" : "bad"}`}>
      {ok ? <CheckCircle2 size={14}/> : <XCircle size={14}/>}
      {label || (ok ? "AVAILABLE" : "UNAVAILABLE")}
    </span>
  );
}

export default function TrustPositifPage() {
  const [status, setStatus] = useState({ source_url: "", direct: null, nodes: [] });
  const [history, setHistory] = useState([]);
  const [domainsText, setDomainsText] = useState("");
  const [domainResult, setDomainResult] = useState(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [checkLoading, setCheckLoading] = useState(false);
  const [nodeLoading, setNodeLoading] = useState({});
  const [notice, setNotice] = useState("");

  const domains = useMemo(() => (
    [...new Set(domainsText.split(/[\s,;]+/).map(v => v.trim()).filter(Boolean))].slice(0, 50)
  ), [domainsText]);

  async function refresh() {
    try {
      const [s, h] = await Promise.all([
        api("/api/trustpositif/status"),
        api("/api/trustpositif/history").catch(() => [])
      ]);
      setStatus(s || { source_url: "", direct: null, nodes: [] });
      setHistory(Array.isArray(h) ? h : []);
    } catch (err) {
      setNotice(err.message || "Gagal load TrustPositif status.");
    }
  }

  useEffect(() => { refresh(); }, []);

  async function testSource() {
    setSourceLoading(true);
    setNotice("");
    try {
      const result = await api("/api/trustpositif/source/test", {
        method: "POST",
        body: JSON.stringify({ domains })
      });
      setNotice(result.ok ? "Official source reachable." : result.reason);
      await refresh();
    } catch (err) {
      setNotice(err.message || "Source test failed.");
    } finally {
      setSourceLoading(false);
    }
  }

  async function checkDomains() {
    if (!domains.length) {
      setNotice("Masukkan minimal 1 domain.");
      return;
    }
    setCheckLoading(true);
    setNotice("");
    try {
      const result = await api("/api/trustpositif/check", {
        method: "POST",
        body: JSON.stringify({ domains })
      });
      setDomainResult(result);
      setNotice(result.ok ? `Checked ${result.domains?.length || 0} domain.` : result.reason);
      await refresh();
    } catch (err) {
      setNotice(err.message || "Domain check failed.");
    } finally {
      setCheckLoading(false);
    }
  }

  async function testNode(node) {
    setNodeLoading(prev => ({ ...prev, [node.id]: true }));
    setNotice("");
    try {
      const result = await api(`/api/trustpositif/nodes/${node.id}/test`, {
        method: "POST",
        body: JSON.stringify({ domains })
      });
      setNotice(`${node.name}: ${result.reason || (result.ok ? "SOURCE_AVAILABLE" : "SOURCE_UNAVAILABLE")}${result.probe_only ? " (probe only, domain membership not verified)" : ""}`);
      await refresh();
    } catch (err) {
      setNotice(`${node.name}: ${err.message || "Node test failed"}`);
    } finally {
      setNodeLoading(prev => ({ ...prev, [node.id]: false }));
    }
  }

  const direct = status.direct;
  const nodes = Array.isArray(status.nodes) ? status.nodes : [];

  return (
    <div className="tpPage">
      <section className="tpHero">
        <div>
          <div className="tpEyebrow"><ShieldCheck size={16}/> KOMDIGI SOURCE DIAGNOSTIC</div>
          <h1>Trust Positif</h1>
          <p>Verify official TrustPositif source reachability. Node availability probes do not verify whether a domain appears in the registry.</p>
        </div>
        <button className="tpRefreshBtn" onClick={refresh}><RefreshCw size={16}/> Refresh</button>
      </section>

      {notice ? <div className="tpNotice">{notice}</div> : null}

      <section className="tpSourceGrid">
        <article className="tpSourceCard">
          <div className="tpCardHead">
            <div><Database size={20}/><span>Official Source</span></div>
            <ResultBadge ok={Boolean(direct?.ok)} neutral={!direct} label={direct ? (direct.ok ? (direct.details?.probe_only ? "PROBE OK" : "AVAILABLE") : "UNAVAILABLE") : "NOT TESTED"}/>
          </div>
          <code>{status.source_url || "https://trustpositif.komdigi.go.id/assets/db/domains_isp"}</code>
          <div className="tpMetricGrid">
            <div><span>HTTP</span><b>{direct?.http_status ?? "—"}</b></div>
            <div><span>Latency</span><b>{direct?.latency_ms ? `${direct.latency_ms} ms` : "—"}</b></div>
            <div><span>{direct?.details?.probe_only ? "Reported size" : "Payload"}</span><b>{formatBytes(direct?.payload_bytes)}</b></div>
            <div><span>Cache</span><b>{status.cache?.fresh ? "READY" : "EMPTY"}</b></div>
          </div>
          <div className="tpMetaLine"><Clock size={14}/> Last test: {formatTime(direct?.created_at)}</div>
          <button onClick={testSource} disabled={sourceLoading}>
            <RefreshCw size={15}/>{sourceLoading ? " Testing source..." : " Test Official Source"}
          </button>
        </article>

        <article className="tpLookupCard">
          <div className="tpCardHead"><div><Search size={20}/><span>Exact Domain Lookup</span></div></div>
          <textarea
            value={domainsText}
            onChange={e => setDomainsText(e.target.value)}
            placeholder={"domain1.com\ndomain2.com"}
            rows={5}
          />
          <div className="tpCacheHint">First exact lookup may download the ~208 MB registry once. Pentagon caches it for 6 hours; subsequent lookups reuse the cache.</div>
          <div className="tpLookupActions">
            <span>{domains.length}/50 domains</span>
            <button onClick={checkDomains} disabled={checkLoading || !domains.length}>
              <Search size={15}/>{checkLoading ? " Checking..." : " Check Registry"}
            </button>
          </div>
        </article>
      </section>

      {domainResult?.domains?.length ? (
        <section className="tpPanel">
          <div className="tpPanelTitle"><Database size={18}/><h2>Registry Result</h2></div>
          <div className="tpDomainResults">
            {domainResult.domains.map(item => (
              <div className="tpDomainRow" key={item.domain}>
                <div><b>{item.domain}</b><small>Exact match against domains_isp</small></div>
                <ResultBadge
                  ok={domainResult.ok && !item.listed}
                  label={!domainResult.ok ? "UNKNOWN" : item.listed ? "ADA / TERDAFTAR" : "TIDAK ADA"}
                />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="tpPanel">
        <div className="tpPanelTitle">
          <Server size={18}/><h2>Indonesian Provider Nodes</h2>
          <span>{nodes.length} nodes</span>
        </div>
        <div className="tpNodeGrid">
          {nodes.map(node => {
            const checked = Boolean(node.trust_checked_at);
            const ok = Boolean(node.trust_ok);
            return (
              <article className="tpNodeCard" key={node.id}>
                <div className="tpNodeHead">
                  <div>
                    <b>{node.name}</b>
                    <small>{node.provider_name} · {node.network_type}</small>
                  </div>
                  <ResultBadge ok={ok} neutral={!checked} label={checked ? (ok ? (node.trust_details?.probe_only ? "PROBE OK" : "SOURCE OK") : "SOURCE FAIL") : "NOT TESTED"}/>
                </div>
                <div className="tpNodeNetwork">
                  <Wifi size={14}/>
                  <span>{node.network_operator || "operator n/a"} · {node.network_type_label || "network n/a"}</span>
                </div>
                <div className="tpCellularLine">
                  <span className={node.cellular_available === true ? "tpCellOk" : node.cellular_available === false ? "tpCellBad" : "tpCellUnknown"}>
                    Cellular {node.cellular_available === true ? "YES" : node.cellular_available === false ? "NO" : "UNKNOWN"}
                  </span>
                  <span>Sub ID: {node.subscription_id ?? "n/a"}</span>
                  <span>{node.subscription_reason || "no subscription diagnostic yet"}</span>
                </div>
                <div className="tpNodeStats">
                  <div><span>Node Health</span><b>{node.last_health_status || "unknown"}</b></div>
                  <div><span>HTTP</span><b>{node.trust_http_status ?? "—"}</b></div>
                  <div><span>Latency</span><b>{node.trust_latency_ms ? `${node.trust_latency_ms} ms` : "—"}</b></div>
                  <div><span>{node.trust_details?.probe_only ? "Reported size" : "Payload"}</span><b>{formatBytes(node.trust_payload_bytes)}</b></div>
                </div>
                <div className="tpNodeReason">{node.trust_reason || node.last_health_reason || "No TrustPositif test yet."}{node.trust_details?.probe_only ? " Endpoint probe only; registry content and domain membership were not checked." : ""}</div>
                <div className="tpMetaLine"><Clock size={13}/> {formatTime(node.trust_checked_at || node.last_seen_at)}</div>
                <button onClick={() => testNode(node)} disabled={nodeLoading[node.id] || node.is_active === false}>
                  <Server size={15}/>{nodeLoading[node.id] ? " Waiting for node..." : " Test Endpoint via Node"}
                </button>
              </article>
            );
          })}
          {!nodes.length ? <div className="tpEmpty">No provider nodes configured.</div> : null}
        </div>
      </section>

      <section className="tpPanel">
        <div className="tpPanelTitle"><HardDrive size={18}/><h2>Recent Tests</h2><span>Latest {Math.min(history.length, 20)}</span></div>
        <div className="tpHistory">
          {history.slice(0, 20).map(row => (
            <div className="tpHistoryRow" key={row.id}>
              <ResultBadge ok={Boolean(row.ok)} label={row.mode === "node" ? ((row.provider_name || "NODE") + (row.details?.probe_only ? " PROBE" : "")) : "DIRECT"}/>
              <div><b>{row.reason || "—"}</b><small>{formatTime(row.created_at)}</small></div>
              <span>{row.http_status ?? "—"} · {row.latency_ms ? `${row.latency_ms} ms` : "—"}</span>
            </div>
          ))}
          {!history.length ? <div className="tpEmpty">No TrustPositif diagnostic history yet.</div> : null}
        </div>
      </section>

      <div className="tpFootnote">
        <AlertTriangle size={14}/>
        Availability probes read source headers or a limited range, not the full registry. Only a completed exact domain lookup can establish whether a domain is listed. A failed source fetch is never treated as a clean domain result.
      </div>
    </div>
  );
}
