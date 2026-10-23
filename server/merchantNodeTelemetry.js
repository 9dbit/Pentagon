"use strict";

/**
 * Read-only merchant telemetry projection.
 * Never spread an entire provider_nodes/node_telemetry row into this response.
 * These are shared checker health readings, NOT controls or verified domain status.
 */
const FRESH_MS = 5 * 60 * 1000;
const OFFLINE_MS = 15 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 0;

function validNumber(value, min, max) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function readingTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function networkLabel(rawTelemetry, rawFallback) {
  // Explicit whitelist prevents exposing SSID, operator identity, raw device data.
  const s = String(rawTelemetry || "").trim().toLowerCase().replace(/[^a-z0-9+]/g, "");
  const modes = {
    nr: "5G", nsa: "5G", sa: "5G", nr5g: "5G", "5g": "5G",
    lte: "4G LTE", "lte+": "4G LTE", lteplus: "4G LTE", "4g": "4G LTE",
    hspa: "3G", hspap: "3G", "hspa+": "3G", umts: "3G", wcdma: "3G", "3g": "3G",
    edge: "2G", gprs: "2G", gsm: "2G", "2g": "2G",
    wifi: "Wi-Fi", wlan: "Wi-Fi", iwlan: "Wi-Fi"
  };
  if (modes[s]) return modes[s];
  const fallback = String(rawFallback || "").toLowerCase();
  if (fallback === "mobile") return "Mobile";
  if (fallback === "broadband") return "Broadband";
  if (fallback === "proxy") return "Proxy";
  if (fallback === "vps") return "VPS";
  return "Unknown";
}

function signalReading(row) {
  const level = validNumber(row.signal_level, 0, 4);
  const percent = validNumber(row.signal_percent, 0, 100);
  const dbm = validNumber(row.signal_dbm, -150, -20);
  let bars = null;
  if (level !== null) bars = Math.round(level * 5 / 4);
  else if (percent !== null) bars = Math.round(percent * 5 / 100);
  else if (dbm !== null) bars = Math.round((Math.min(-40, Math.max(-120, dbm)) + 120) * 5 / 80);
  const signalLabel = bars === null ? "Unknown" : bars === 0 ? "No Signal" :
    bars <= 2 ? "Weak" : bars === 3 ? "Good" : "Strong";
  return { signal_bars: bars, signal_label: signalLabel, signal_dbm: dbm === null ? null : Math.round(dbm) };
}

function safeProvider(value) {
  const name = String(value || "").replace(/[^\p{L}\p{N} .+-]/gu, "").trim().slice(0, 48);
  return name || "Provider";
}

function serializeMerchantNodes(rows, now = Date.now()) {
  if (!Array.isArray(rows)) return [];
  const index = new Map();
  return rows.map(row => {
    const provider_name = safeProvider(row.provider_name);
    const current = (index.get(provider_name) || 0) + 1;
    index.set(provider_name, current);
    const stamp = readingTime(row.telemetry_last_seen_at);
    const age = stamp === null ? null : now - stamp;
    const validAge = age !== null && age >= -MAX_CLOCK_SKEW_MS;
    const heartbeatFresh = validAge && age <= FRESH_MS;
    const rawHealth = String(row.last_health_status || "").toLowerCase();
    const degraded = ["wrong_network", "network_error", "error", "degraded"].includes(rawHealth);
    const is_active = row.is_active === true;
    const connectivity = !is_active ? "inactive" : !validAge ? "unknown" :
      age <= FRESH_MS ? (degraded ? "degraded" : "online") :
      age <= OFFLINE_MS ? "waiting" : "offline";

    const signal = signalReading(row);
    const battery = validNumber(row.battery_percent, 0, 100);
    const charging = typeof row.is_charging === "boolean" ? row.is_charging : null;
    return {
      public_alias: provider_name.toUpperCase() + " NODE " + String(current).padStart(2, "0"),
      provider_name,
      network_type: networkLabel(row.network_type_label, row.network_type),
      is_active,
      connectivity,
      signal_bars: signal.signal_bars,
      signal_label: signal.signal_label,
      signal_dbm: signal.signal_dbm,
      battery_percent: battery === null ? null : Math.round(battery),
      is_charging: charging,
      telemetry_fresh: Boolean(heartbeatFresh),
      last_seen_at: validAge ? new Date(stamp).toISOString() : null
    };
  });
}

module.exports = {
  FRESH_MS, OFFLINE_MS, networkLabel, signalReading,
  serializeMerchantNodes
};
