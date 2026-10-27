#!/usr/bin/env python3
"""Official registry exact-match relay from an authorized Windows service PC.

The script never sends credentials or registry content to ChatGPT. It sends
only per-tenant whitelisted matches, file integrity metadata and a timestamp
to Pentagon's internal HTTPS endpoint, using a locally protected bearer token.
It never changes blocked statuses or sends Telegram alerts.
"""
import datetime
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

OFFICIAL = "https://trustpositif.komdigi.go.id/assets/db/domains_isp"
BASE = os.environ.get("PENTAGON_TP_BRIDGE_BASE", "https://pentagon.quest").rstrip("/")
TOKEN = os.environ.get("PENTAGON_TP_BRIDGE_TOKEN", "")
MIN_BYTES = 100000000
MIN_ENTRIES = 5000000


def request_json(url, method="GET", body=None, timeout=40):
    payload = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        url,
        method=method,
        data=payload,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {}),
            "User-Agent": "PentagonTrustSourceBridge/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read(1024 * 1024).decode("utf-8"))


def scan_official(lookup_keys):
    targets = {d.encode("ascii") for d in lookup_keys}
    found = set()
    seen_bytes = 0
    lines = 0
    tail = b""
    digest = hashlib.sha256()
    started = time.monotonic()
    req = urllib.request.Request(
        OFFICIAL,
        headers={
            "User-Agent": "PentagonTrustPositif/1.0",
            "Accept": "application/octet-stream,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as response:
        if response.status != 200:
            raise RuntimeError("OFFICIAL_SOURCE_HTTP_ERROR")
        content_type = response.headers.get("Content-Type", "")
        if "text/html" in content_type.lower():
            raise RuntimeError("OFFICIAL_SOURCE_HTML_INSTEAD_OF_DATA")
        announced = response.headers.get("Content-Length")
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            seen_bytes += len(chunk)
            fragments = (tail + chunk).split(b"\n")
            tail = fragments.pop()
            for entry in fragments:
                lines += 1
                if entry.strip().lower().rstrip(b".") in targets:
                    found.add(entry.strip().lower().rstrip(b"."))
            if time.monotonic() - started > 360:
                raise TimeoutError("SOURCE_TRANSFER_DEADLINE")
        if tail:
            lines += 1
            key = tail.strip().lower().rstrip(b".")
            if key in targets:
                found.add(key)
        if announced is not None and seen_bytes != int(announced):
            raise RuntimeError("OFFICIAL_DOWNLOAD_TRUNCATED")
    if seen_bytes < MIN_BYTES or lines < MIN_ENTRIES:
        raise RuntimeError("OFFICIAL_SNAPSHOT_INCOMPLETE")
    return {
        "source_url": OFFICIAL,
        "source_http": 200,
        "source_sha256": digest.hexdigest(),
        "source_bytes": seen_bytes,
        "source_entries": lines,
        "verified_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }, found


def main():
    if len(TOKEN) < 48:
        raise RuntimeError("PROTECTED_BRIDGE_CREDENTIAL_MISSING")
    if not BASE.startswith("https://") and not BASE.startswith("http://127.0.0.1:"):
        raise RuntimeError("HTTPS_BRIDGE_REQUIRED")
    base = BASE + "/api/internal/trustpositif/bridge"
    inventory = request_json(base + "/inventory")
    if inventory.get("ok") is not True:
        raise RuntimeError("INVENTORY_NOT_READY")
    rows = inventory.get("domains", [])
    if not rows:
        print("SOURCE_BRIDGE_NO_WHITELISTED_PRODUCTION_DOMAINS")
        return
    if len(rows) > 5000:
        raise RuntimeError("SOURCE_BRIDGE_INVENTORY_OVER_LIMIT")
    target = {row["lookup_key"] for row in rows}
    meta, found = scan_official(target)
    meta["matches"] = [
        {"tenant": row["tenant"], "domain": row["domain"],
         "lookup_key": row["lookup_key"],
         "listed": row["lookup_key"].encode("ascii") in found}
        for row in rows
    ]
    answer = request_json(base + "/evidence", "POST", meta, timeout=100)
    if answer.get("ok") is not True:
        raise RuntimeError("BRIDGE_IMPORT_REJECTED")
    print("SOURCE_BRIDGE_SUCCESS")
    print("IMPORTED=" + str(answer.get("accepted", 0)))
    print("LISTED=" + str(answer.get("listed", 0)))
    print("SNAPSHOT_ENTRIES=" + str(meta["source_entries"]))
    print("SNAPSHOT_BYTES=" + str(meta["source_bytes"]))
    print("SOURCE_SHA256=" + meta["source_sha256"])
    print("VERIFIED_AT=" + meta["verified_at_utc"])


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as exc:
        print("SOURCE_BRIDGE_HTTP_ERROR=" + str(exc.code), file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        # Never print Bearer credentials or raw payload contents in logs.
        print("SOURCE_BRIDGE_ERROR=" + type(exc).__name__ + ":" +
              str(exc).split("\n", 1)[0][:70], file=sys.stderr)
        sys.exit(1)
