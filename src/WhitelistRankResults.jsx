import React from "react";
import { serpReading } from "./serpReading.mjs";
import "./WhitelistRankResults.css";

const dateWib = value => value ? new Date(value).toLocaleString("id-ID", {
  timeZone:"Asia/Jakarta", day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit"
}) + " WIB" : "—";
const statusText = { found:"Ditemukan", not_found:"Tidak ditemukan dalam hasil scan",
  pending:"Belum diperiksa", unavailable:"Hasil belum tersedia" };

function CheckerCell({reading,loading,error}) {
  return <td className={"whitelistCheckerCell "+(error?"stale":reading?.state||"unknown")}>
    <span>{reading?.text||(loading?"Memuat…":"Belum diperiksa")}</span>
    {reading?.checked_at&&<time>{dateWib(reading.checked_at)}</time>}
    {reading?.attribution==="provider_history"&&<small>Riwayat provider</small>}
    {error&&reading&&<small>Refresh gagal</small>}
  </td>;
}
export default function WhitelistRankResults({ domains = [], keyword = "", evidence = {} }) {
  const rows = Array.isArray(domains) ? domains : [];
  const nodes=Array.isArray(evidence.nodes)?evidence.nodes:[];
  const byDomain=new Map((evidence.domains||[]).map(d=>[d.domain.toLowerCase(),d]));
  return <div className="whitelistSerp">
    {evidence.error&&<p role="status" className="whitelistSerpNote">{evidence.error}</p>}
    <div className="whitelistSerpScroll" role="region" tabIndex={0} aria-label={"Hasil SERP whitelist untuk " + keyword}>
      <table className="whitelistSerpTable">
        <caption>Hasil Google SERP · {keyword}</caption>
        <thead><tr><th scope="col">Domain whitelist</th><th scope="col">Halaman SERP</th>
          <th scope="col">Rank keseluruhan</th><th scope="col">Hasil pencarian</th><th scope="col">Diperiksa Google</th>
          {nodes.map(node=><th scope="col" key={node.key}>{node.label}<small>Akses jaringan{node.is_active?"":" · nonaktif"}</small></th>)}
          <th scope="col">AI Checker<small>Registry TrustPositif</small></th></tr></thead>
        <tbody>{rows.map((row,index) => {
          const reading = serpReading(row);
          const checks=byDomain.get(String(row.domain).toLowerCase());
          return <tr key={row.domain || index}>
            <th scope="row">{row.domain}</th>
            <td className="whitelistSerpNumber">{reading.page ?? "—"}</td>
            <td className="whitelistSerpNumber">{reading.position ? "#" + reading.position : "—"}</td>
            <td><span className={"whitelistSerpStatus " + reading.status}>{statusText[reading.status]}</span></td>
            <td><time>{dateWib(reading.checkedAt)}</time></td>
            {nodes.map(node=><CheckerCell key={node.key} reading={checks?.node_results?.[node.key]} loading={evidence.loading} error={evidence.error}/>)}
            <CheckerCell reading={checks?.ai} loading={evidence.loading} error={evidence.error}/>
          </tr>;
        })}{!rows.length && <tr><td colSpan={6+nodes.length}>Belum ada domain whitelist untuk keyword ini.</td></tr>}</tbody>
      </table>
    </div>
    <p className="whitelistSerpNote">Rank adalah urutan keseluruhan hasil pencarian. Tidak ditemukan berarti domain tidak ada
      pada hasil yang dipindai, bukan bukti domain tidak terindeks Google. Kolom node menunjukkan akses jaringan,
      AI Checker menunjukkan registry TrustPositif; keduanya bukan posisi Google dari jaringan SIM.</p>
  </div>;
}
