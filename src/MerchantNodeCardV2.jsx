import React from "react";
import { Battery, BatteryCharging, BatteryWarning, Clock3 } from "lucide-react";

const dateWib = value => value && Number.isFinite(new Date(value).getTime())
  ? new Date(value).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }) + " WIB"
  : "Belum tersedia";

const connectivityText = {
  online: "ONLINE", degraded: "DEGRADED", waiting: "WAITING",
  offline: "OFFLINE", unknown: "UNKNOWN", inactive: "INACTIVE"
};

function lastSeenText(value, asOf) {
  if (!value) return "Belum pernah terhubung";
  const age = new Date(asOf || Date.now()).getTime() - new Date(value).getTime();
  if (!Number.isFinite(age) || age < 0) return "Waktu heartbeat tidak valid";
  if (age < 60000) return Math.floor(age / 1000) + " detik lalu";
  if (age < 3600000) return Math.floor(age / 60000) + " menit lalu";
  if (age < 86400000) return Math.floor(age / 3600000) + " jam lalu";
  return Math.floor(age / 86400000) + " hari lalu";
}

export default function MerchantNodeCardV2({ node, asOf }) {
  const bars = Number.isInteger(node.signal_bars) && node.signal_bars >= 0 &&
    node.signal_bars <= 5 ? node.signal_bars : null;
  const battery = typeof node.battery_percent === "number" &&
    node.battery_percent >= 0 && node.battery_percent <= 100 ?
    node.battery_percent : null;
  const isLow = battery !== null && battery < 20;
  const isCharging = node.is_charging === true;
  const BatteryIcon = isCharging ? BatteryCharging : isLow ? BatteryWarning : Battery;

  return <article className={"maNodeCardV2 maNodeHealth-" + node.connectivity}
    aria-label={node.public_alias + " " + (connectivityText[node.connectivity] || "UNKNOWN")}>
    <div className="maNodeTopV2">
      <div className="maNodeBrandV2">
        <span className="maNodeProvider">{node.provider_name}</span>
        <span className="maNodeAlias">{node.public_alias} · {node.network_type}</span>
      </div>
      <div className={"maNodeEnabled " + (node.is_active ? "is-active" : "is-inactive")}>
        <span className="maNodeDot" aria-hidden="true"/>
        {node.is_active ? "ACTIVE" : "INACTIVE"}
      </div>
    </div>

    <div className="maNodeTelemetryV2">
      <div className="maNodeDataBlock">
        <span className="maNodeDataLabel">SIGNAL STRENGTH</span>
        <div className="maSignalMeter" role="img"
          aria-label={bars === null ? "Signal tidak tersedia" : "Signal " + bars + " dari 5 batang"}>
          {[1,2,3,4,5].map(level =>
            <span key={level} className={bars !== null && level <= bars ? "filled" : ""}/>
          )}
        </div>
        <div className="maSignalReading">
          <strong>{node.signal_label || "Unknown"}</strong>
          <span>{node.signal_dbm == null ? node.network_type : node.signal_dbm + " dBm"}</span>
        </div>
      </div>
      <div className="maNodeDataBlock">
        <span className="maNodeDataLabel">BATTERY LEVEL</span>
        <div className="maBatteryTop">
          <BatteryIcon size={22} aria-hidden="true" className={isLow ? "maBatteryLow" : ""}/>
          <strong>{battery === null ? "N/A" : battery + "%"}</strong>
        </div>
        <div className="maBatteryTrack" aria-hidden="true">
          <span className={isLow ? "maBatteryLowFill" : ""}
            style={{width: (battery ?? 0) + "%"}}/>
        </div>
        <span className="maBatteryCaption">{battery === null ? "Data tidak tersedia" :
          isCharging ? "Charging" : isLow ? "Low battery" :
          node.telemetry_fresh ? "Battery reported" : "Last reported"}</span>
      </div>
    </div>

    <div className="maNodeStatusV2">
      <div className="maNodeConnection">
        <span className={"maConnectionDot " + (node.connectivity || "unknown")} aria-hidden="true"/>
        <strong>{connectivityText[node.connectivity] || "UNKNOWN"}</strong>
        {!node.telemetry_fresh && node.last_seen_at &&
          <span className="maNodeStale">LAST READING</span>}
      </div>
      <div className="maHeartbeat">
        <Clock3 size={14} aria-hidden="true"/>
        <span>{lastSeenText(node.last_seen_at, asOf)}</span>
      </div>
      <span className="maNodeTime" title={node.last_seen_at ? dateWib(node.last_seen_at) : ""}>
        Heartbeat: {dateWib(node.last_seen_at)}
      </span>
    </div>
  </article>;
}
