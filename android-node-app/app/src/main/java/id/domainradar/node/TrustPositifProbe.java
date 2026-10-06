package id.domainradar.node;

import android.content.Context;
import android.net.Network;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.time.Instant;

final class TrustPositifProbe {
    static final String SOURCE_URL = "https://trustpositif.komdigi.go.id/assets/db/domains_isp";

    private TrustPositifProbe() {}

    static JSONObject probe(Context context, String networkMode) {
        long started = System.currentTimeMillis();
        CellularNetworkHelper.Info cell = CellularNetworkHelper.inspect(context);
        boolean requireCellular = "mobile".equalsIgnoreCase(networkMode);

        if (requireCellular && !cell.available) {
            return failure(started, null, cell, "NO_CELLULAR_TRANSPORT: enable mobile data on this provider SIM");
        }

        try {
            URL url = new URL(SOURCE_URL);
            HttpURLConnection conn = open(url, requireCellular ? cell.network : null);
            conn.setRequestMethod("HEAD");
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(20000);
            conn.setRequestProperty("User-Agent", "PentagonNodeAndroid/1.6.0");
            conn.setRequestProperty("Accept", "*/*");

            int code = conn.getResponseCode();
            long payloadBytes = conn.getContentLengthLong();
            String contentType = safe(conn.getContentType());
            conn.disconnect();

            if (code >= 200 && code < 300 && payloadBytes > 1000) {
                return success(started, code, payloadBytes, 0, contentType, cell, "SOURCE_AVAILABLE");
            }

            if (code == 403 || code == 405 || payloadBytes <= 0) {
                return rangeProbe(started, url, requireCellular ? cell.network : null, cell);
            }
            return failure(started, code, cell, "SOURCE_UNAVAILABLE_HTTP_" + code);
        } catch (Exception e) {
            return failure(started, null, cell, "SOURCE_UNAVAILABLE: " + e.getClass().getSimpleName() + ": " + safe(e.getMessage()));
        }
    }

    private static JSONObject rangeProbe(long started, URL url, Network network, CellularNetworkHelper.Info cell) {
        HttpURLConnection conn = null;
        try {
            conn = open(url, network);
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(20000);
            conn.setRequestProperty("User-Agent", "PentagonNodeAndroid/1.6.0");
            conn.setRequestProperty("Accept", "application/octet-stream,*/*");
            conn.setRequestProperty("Range", "bytes=0-65535");

            int code = conn.getResponseCode();
            String contentRange = safe(conn.getHeaderField("Content-Range"));
            long totalBytes = parseTotal(contentRange);
            if (totalBytes <= 0) totalBytes = conn.getContentLengthLong();

            int read = 0;
            try (InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
                if (in != null) {
                    byte[] buf = new byte[8192];
                    while (read < 65536) {
                        int n = in.read(buf, 0, Math.min(buf.length, 65536 - read));
                        if (n < 0) break;
                        read += n;
                    }
                }
            }

            if ((code == 200 || code == 206) && read > 0) {
                return success(started, code, totalBytes, read, safe(conn.getContentType()), cell, "SOURCE_AVAILABLE_RANGE_PROBE");
            }
            return failure(started, code, cell, "SOURCE_UNAVAILABLE_HTTP_" + code);
        } catch (Exception e) {
            return failure(started, null, cell, "SOURCE_UNAVAILABLE: " + e.getClass().getSimpleName() + ": " + safe(e.getMessage()));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static HttpURLConnection open(URL url, Network network) throws Exception {
        return (HttpURLConnection) (network != null ? network.openConnection(url) : url.openConnection());
    }

    private static JSONObject success(long started, int code, long payloadBytes, int probeBytes, String contentType,
                                      CellularNetworkHelper.Info cell, String reason) {
        JSONObject result = base(started, cell);
        try {
            result.put("ok", true);
            result.put("status", "working");
            result.put("http_status", code);
            result.put("payload_bytes", Math.max(0, payloadBytes));
            result.put("probe_bytes", Math.max(0, probeBytes));
            result.put("content_type", contentType);
            result.put("reason", reason);
        } catch (Exception ignored) {}
        return result;
    }

    private static JSONObject failure(long started, Integer code, CellularNetworkHelper.Info cell, String reason) {
        JSONObject result = base(started, cell);
        try {
            result.put("ok", false);
            result.put("status", "warning");
            result.put("http_status", code == null ? JSONObject.NULL : code);
            result.put("payload_bytes", 0);
            result.put("probe_bytes", 0);
            result.put("content_type", "");
            result.put("reason", reason);
        } catch (Exception ignored) {}
        return result;
    }

    private static JSONObject base(long started, CellularNetworkHelper.Info cell) {
        JSONObject result = new JSONObject();
        try {
            result.put("trustpositif_fetch", true);
            result.put("probe_only", true);
            result.put("source_url", SOURCE_URL);
            result.put("latency_ms", System.currentTimeMillis() - started);
            result.put("entry_count", 0);
            result.put("fetched_at", Instant.now().toString());
            result.put("matches", new JSONObject());
            result.put("transport", cell.available ? "cellular" : "default");
            result.put("cellular_available", cell.available);
            result.put("subscription_id", cell.subscriptionId >= 0 ? cell.subscriptionId : JSONObject.NULL);
            result.put("operator", cell.operator);
            result.put("network_type_label", TelemetryCollector.display(cell.networkType));
            result.put("network_reason", cell.reason);
        } catch (Exception ignored) {}
        return result;
    }

    private static long parseTotal(String contentRange) {
        if (contentRange == null) return 0;
        int slash = contentRange.lastIndexOf('/');
        if (slash < 0 || slash + 1 >= contentRange.length()) return 0;
        try { return Long.parseLong(contentRange.substring(slash + 1).trim()); }
        catch (Exception ignored) { return 0; }
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
