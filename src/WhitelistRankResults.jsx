import React from "react";
import { serpReading } from "./serpReading.mjs";
import "./WhitelistRankResults.css";

const dateWib = value => value ? new Date(value).toLocaleString("id-ID", {
  timeZone:"Asia/Jakarta", day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit"
}) + " WIB" : "—";
const statusText = { found:"Ditemukan", not_found:"Tidak ditemukan dalam hasil scan",
  pending:"Belum diperiksa", unavailable:"Hasil belum tersedia" };

export default function WhitelistRankResults({ domains = [], keyword = "" }) {
  const rows = Array.isArray(domains) ? domains : [];
  return <div className="whitelistSerp">
    <div className="whitelistSerpScroll" role="region" tabIndex={0} aria-label={"Hasil SERP whitelist untuk " + keyword}>
      <table className="whitelistSerpTable">
        <caption>Hasil Google SERP · {keyword}</caption>
        <thead><tr><th scope="col">Domain whitelist</th><th scope="col">Halaman SERP</th>
          <th scope="col">Rank keseluruhan</th><th scope="col">Hasil pencarian</th><th scope="col">Terakhir diperiksa</th></tr></thead>
        <tbody>{rows.map((row,index) => {
          const reading = serpReading(row);
          return <tr key={row.domain || index}>
            <th scope="row">{row.domain}</th>
            <td className="whitelistSerpNumber">{reading.page ?? "—"}</td>
            <td className="whitelistSerpNumber">{reading.position ? "#" + reading.position : "—"}</td>
            <td><span className={"whitelistSerpStatus " + reading.status}>{statusText[reading.status]}</span></td>
            <td><time>{dateWib(reading.checkedAt)}</time></td>
          </tr>;
        })}{!rows.length && <tr><td colSpan={5}>Belum ada domain whitelist untuk keyword ini.</td></tr>}</tbody>
      </table>
    </div>
    <p className="whitelistSerpNote">Rank adalah urutan keseluruhan hasil pencarian. Tidak ditemukan berarti domain tidak ada
      pada hasil yang dipindai, bukan bukti domain tidak terindeks Google.</p>
  </div>;
}
