const FRESH_MS = 5 * 60 * 1000;
const OFFLINE_MS = 15 * 60 * 1000;
const REGISTRY_FRESH_MS = 12 * 60 * 60 * 1000;

export function readingTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function nodeReading(node, now = Date.now()) {
  const lastSeen = node.last_seen_at || node.telemetry_last_seen_at;
  const stamp = readingTime(lastSeen);
  const age = stamp === null ? null : now - stamp;
  const fresh = age !== null && age >= 0 && age <= FRESH_MS;
  const degraded = ["degraded", "wrong_network", "network_error", "error"].includes(
    node.connectivity || node.last_health_status);
  const status = node.is_active === false ? "inactive" : age === null || age < 0 ? "unknown" :
    fresh ? (degraded ? "degraded" : "online") : age <= OFFLINE_MS ? "waiting" : "offline";
  const battery = node.battery_percent;
  const batteryText = battery !== null && battery !== undefined && battery !== "" &&
    Number.isFinite(Number(battery)) && Number(battery) >= 0 && Number(battery) <= 100
    ? Math.round(Number(battery)) + "%" : "N/A";
  const signal = node.signal_dbm != null ? node.signal_dbm + " dBm" :
    node.signal_bars != null ? node.signal_bars + "/5" :
    node.signal_level != null ? node.signal_level + "/4" :
    node.signal_percent != null ? node.signal_percent + "%" : "N/A";
  return { status, fresh, lastSeen: stamp !== null && age >= 0 ? lastSeen : null, batteryText, signal };
}

export function registryReading(trust, now = Date.now()) {
  const domains = Array.isArray(trust?.domains) ? trust.domains : [];
  // A successful OpenAI HTTP request is not evidence of an official registry lookup.
  const verified = domains.filter(row => typeof row.registry_listed === "boolean" &&
    /tradevicepc/i.test(String(row.registry_collector || "") + " " + String(row.registry_source || "")) &&
    readingTime(row.registry_checked_at) !== null && readingTime(row.registry_checked_at) <= now);
  const recent = verified.filter(row => now - readingTime(row.registry_checked_at) <= REGISTRY_FRESH_MS);
  const latest = verified.reduce((value, row) => Math.max(value, readingTime(row.registry_checked_at)), 0);
  return {
    status: !latest ? "unknown" : recent.length ? "available" : "stale",
    lastSeen: latest ? new Date(latest).toISOString() : null,
    checked: recent.length,
    total: domains.length
  };
}
