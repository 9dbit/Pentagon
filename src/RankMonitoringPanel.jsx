import React, { useEffect, useState } from "react";
import { RefreshCw, Server, ShieldCheck } from "lucide-react";
import { nodeReading, registryReading } from "./rankMonitoring.mjs";
import "./RankMonitoringPanel.css";

const labels = { online:"Online", degraded:"Degraded", waiting:"Waiting", offline:"Offline",
  inactive:"Inactive", unknown:"Unknown", available:"Snapshot tersedia", stale:"Snapshot lama" };
const timeWib = value => value ? new Date(value).toLocaleString("id-ID", {
  timeZone:"Asia/Jakarta", day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit", second:"2-digit"
}) + " WIB" : "Belum tersedia";
function Status({ value }) {
  return <span className={"rankMonitorStatus rankMonitor-" + value}><i aria-hidden="true"/>{labels[value] || "Unknown"}</span>;
}

export function RankMonitoringTable({ nodes = [], trust = null, loading = false, errors = [], onRefresh, now = Date.now() }) {
  const rows = Array.isArray(nodes) ? nodes : [];
  const ai = registryReading(trust, now);
  return <section className="rankMonitor" aria-label="All Nodes & AI Checker" aria-busy={loading}>
    <div className="rankMonitorHead">
      <div><span className="rankMonitorEyebrow">MONITORING</span><h2>All Nodes &amp; AI Checker</h2>
        <p>Heartbeat provider dan pembaruan registry resmi.</p></div>
      {onRefresh && <button className="rankMonitorRefresh" type="button" onClick={onRefresh} disabled={loading}>
        <RefreshCw size={14}/>{loading ? "Memuat…" : "Refresh status"}</button>}
    </div>
    {errors.length > 0 && <p className="rankMonitorError" role="alert">{errors.join(" ")} Pembacaan yang tersimpan ditampilkan bila tersedia.</p>}
    <div className="rankMonitorScroll" tabIndex={0} role="region" aria-label="Tabel status semua node dan AI Checker">
      <table className="rankMonitorTable">
        <thead><tr><th scope="col">Node / checker</th><th scope="col">Status</th>
          <th scope="col">Jaringan / sumber</th><th scope="col">Pembacaan terakhir</th><th scope="col">Baterai / sinyal</th></tr></thead>
        <tbody>
          {rows.map((node, index) => {
            const reading = nodeReading(node, now);
            return <tr key={node.id ?? node.public_alias ?? index}>
              <th scope="row"><span className="rankMonitorName"><Server size={16}/>{node.provider_name || "Provider"}</span>
                <small>{node.public_alias || node.name || "Provider node"}</small></th>
              <td><Status value={reading.status}/></td>
              <td>{node.network_type_label || node.network_label || node.network_type || "Unknown"}</td>
              <td><time>{timeWib(reading.lastSeen)}</time><small>{reading.fresh ? "Heartbeat terbaru" : "Pembacaan lama / belum tersedia"}</small></td>
              <td><strong>{reading.batteryText}</strong><small>Sinyal: {reading.signal}</small></td>
            </tr>;
          })}
          {!rows.length && <tr><td colSpan={5} className="rankMonitorEmpty">{loading ? "Memuat node…" : "Data node belum tersedia."}</td></tr>}
          <tr className="rankMonitorAi">
            <th scope="row"><span className="rankMonitorName"><ShieldCheck size={16}/>AI Checker</span><small>Verifikasi registry resmi</small></th>
            <td><Status value={ai.status}/></td><td>Komdigi · Trust Positif</td>
            <td><time>{timeWib(ai.lastSeen)}</time><small>Verifikasi registry terakhir</small></td>
            <td><strong>{trust ? ai.checked + " / " + ai.total : "—"}</strong><small>Domain diverifikasi ≤12 jam</small></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p className="rankMonitorNote">Online memerlukan heartbeat ≤5 menit. Snapshot AI Checker menunjukkan verifikasi registry;
      status domain dan posisi Google mengikuti hasil pemeriksaan masing-masing.</p>
  </section>;
}

export default function RankMonitoringPanel({ audience = "admin" }) {
  const [data, setData] = useState({ nodes:[], trust:null, errors:[], loading:true });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true, running = false;
    const controller = new AbortController();
    const merchant = audience === "merchant";
    const urls = merchant ? ["/api/merchant/node-health", "/api/merchant/trust-positif"] :
      ["/api/nodes", "/api/trustpositif/watchlist"];
    async function load() {
      if (running) return;
      running = true;
      setData(previous => ({ ...previous, loading:true }));
      const results = await Promise.allSettled(urls.map(async url => {
        const response = await fetch(url, { credentials:"include", cache:"no-store", signal:controller.signal });
        if (!response.ok) throw new Error("Status unavailable");
        const value = await response.json();
        if (url === urls[0] && !Array.isArray(merchant ? value.nodes : value)) throw new Error("Invalid nodes");
        if (url === urls[1] && !Array.isArray(value.domains)) throw new Error("Invalid registry");
        return value;
      }));
      if (active) setData(previous => ({
        nodes:results[0].status === "fulfilled" ? (merchant ? results[0].value.nodes : results[0].value) : previous.nodes,
        trust:results[1].status === "fulfilled" ? results[1].value : previous.trust,
        errors:results.flatMap((result, index) => result.status === "rejected" ?
          [index === 0 ? "Status node gagal diperbarui." : "Status AI Checker gagal diperbarui."] : []),
        loading:false
      }));
      running = false;
    }
    load();
    const timer = setInterval(load, 60000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [audience, refresh]);
  return <RankMonitoringTable {...data} onRefresh={() => setRefresh(value => value + 1)}/>;
}
