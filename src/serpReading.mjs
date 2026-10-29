export function serpReading(row, now = Date.now()) {
  const stamp = row.last_checked_at ? new Date(row.last_checked_at).getTime() : NaN;
  const checked = Number.isFinite(stamp) && stamp <= now;
  const positive = value => typeof value !== "boolean" && Number.isInteger(Number(value)) &&
    Number(value) > 0 ? Number(value) : null;
  const position = positive(row.last_position);
  const page = positive(row.last_page);
  const status = !checked || row.last_status === "pending" ? "pending" :
    row.last_status === "not_found" ? "not_found" :
    row.last_status === "found" && position ? "found" : "unavailable";
  return { status, position:status === "found" ? position : null,
    page:status === "found" ? page : null, checkedAt:checked ? row.last_checked_at : null };
}
