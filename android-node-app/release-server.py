import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("PORT", "8080"))
VERSION_CODE = int(os.environ["VERSION_CODE"])
VERSION_NAME = os.environ["VERSION_NAME"]
PACKAGE_NAME = os.environ["PACKAGE_NAME"]
RELEASE_NOTES = os.environ.get("RELEASE_NOTES", "")
APK_PATH = f"/data/Pentagon-Provider-Node-v{VERSION_NAME}.apk"
SHA_PATH = f"/data/Pentagon-Provider-Node-v{VERSION_NAME}.sha256"
SIGNER_PATH = "/data/signer.sha256"

def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read().strip()

class Handler(BaseHTTPRequestHandler):
    server_version = "PentagonRelease/1.0"

    def log_message(self, fmt, *args):
        print("[release]", self.address_string(), fmt % args, flush=True)

    def common_headers(self, content_type):
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("X-Content-Type-Options", "nosniff")

    def base_url(self):
        configured = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
        if configured:
            return configured
        host = self.headers.get("Host", "").strip()
        return f"https://{host}" if host else ""

    def do_HEAD(self):
        self.handle_request(head_only=True)

    def do_GET(self):
        self.handle_request(head_only=False)

    def handle_request(self, head_only=False):
        path = urlparse(self.path).path
        if path == "/health":
            body = json.dumps({"ok": True, "versionName": VERSION_NAME, "versionCode": VERSION_CODE}).encode()
            self.send_response(200)
            self.common_headers("application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)
            return

        if path == "/latest.json":
            size = os.path.getsize(APK_PATH)
            manifest = {
                "versionCode": VERSION_CODE,
                "versionName": VERSION_NAME,
                "releaseNotes": RELEASE_NOTES,
                "sizeBytes": size,
                "sha256": read_text(SHA_PATH),
                "signerSha256": read_text(SIGNER_PATH),
                "packageName": PACKAGE_NAME,
                "downloadUrl": self.base_url() + "/latest.apk",
            }
            body = json.dumps(manifest, separators=(",", ":")).encode()
            self.send_response(200)
            self.common_headers("application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)
            return

        if path in ("/latest.apk", f"/Pentagon-Provider-Node-v{VERSION_NAME}.apk"):
            size = os.path.getsize(APK_PATH)
            self.send_response(200)
            self.common_headers("application/vnd.android.package-archive")
            self.send_header("Content-Disposition", f'attachment; filename="Pentagon-Provider-Node-v{VERSION_NAME}.apk"')
            self.send_header("Content-Length", str(size))
            self.end_headers()
            if not head_only:
                with open(APK_PATH, "rb") as f:
                    while True:
                        chunk = f.read(1024 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            return

        body = b'{"error":"not found"}'
        self.send_response(404)
        self.common_headers("application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
