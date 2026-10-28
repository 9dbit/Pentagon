"use strict";
// APK reports are untrusted. Never store arbitrary logs, credentials, domains,
// SIM identifiers or exception messages in the diagnostic projection.
const PHASES = new Set(["idle", "claimed", "dns", "http", "result", "timeout", "cancelling", "error"]);
const CODES = new Set(["NONE", "IO", "DNS", "TLS", "TIMEOUT", "CANCELLED", "AUTH", "HTTP", "ACK", "UNKNOWN"]);
const EVENTS = new Set(["SERVICE_START", "SERVICE_STOP", "POLL_ERROR", "POLL_RECOVERED", "TASK_START", "DNS_DONE", "HTTP_DONE", "TASK_TIMEOUT", "TASK_ERROR", "RESULT_ACCEPTED", "RESULT_IGNORED", "RESULT_ERROR"]);
function normalizeDiagnostics(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema_version !== 1) return null;
  const out = { schema_version: 1 };
  for (const key of ["uptime_ms", "configured_poll_ms", "effective_poll_ms", "last_poll_duration_ms", "last_poll_gap_ms", "last_ack_age_ms", "task_elapsed_ms", "dns_ms", "http_ms"]) {
    const n = raw[key];
    out[key] = typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 31536000000 ? n : null;
  }
  for (const key of ["service_running", "task_busy", "device_idle", "interactive", "power_save", "battery_optimization_exempt"]) out[key] = typeof raw[key] === "boolean" ? raw[key] : null;
  out.task_phase = PHASES.has(raw.task_phase) ? raw.task_phase : "idle";
  out.last_error_code = CODES.has(raw.last_error_code) ? raw.last_error_code : "UNKNOWN";
  out.last_result_state = ["none", "accepted", "ignored", "error"].includes(raw.last_result_state) ? raw.last_result_state : "none";
  out.events = (Array.isArray(raw.events) ? raw.events : []).slice(-20).filter(e => e && EVENTS.has(e.event)).map(e => ({
    event: e.event,
    at: typeof e.at === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(e.at) && Number.isFinite(Date.parse(e.at)) ? e.at : null,
    duration_ms: Number.isSafeInteger(e.duration_ms) && e.duration_ms >= 0 && e.duration_ms <= 86400000 ? e.duration_ms : null
  }));
  return out;
}
module.exports = { normalizeDiagnostics };
