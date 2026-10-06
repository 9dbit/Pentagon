package id.domainradar.node;

import android.content.Context;
import android.net.Network;
import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;

class DomainChecker {
    static JSONObject check(Context context, String domain, String provider, String networkMode) {
        long started = System.currentTimeMillis();
        JSONObject r = new JSONObject();
        String clean = domain == null ? "" : domain.replaceFirst("^https?://", "").replaceFirst("/.*$", "").trim().toLowerCase();
        String status = "working";
        String reason = "OK";
        String dns = "";
        int http = 0;
        String finalUrl = "";

        CellularNetworkHelper.Info cell = CellularNetworkHelper.inspect(context);
        boolean requireCellular = "mobile".equalsIgnoreCase(networkMode);
        Network network = requireCellular ? cell.network : null;

        if (requireCellular && !cell.available) {
            status = "warning";
            reason = "NO_CELLULAR_TRANSPORT: enable mobile data on this provider SIM";
            return buildResult(r, provider, networkMode, status, http, finalUrl, dns, started, reason, cell);
        }

        try {
            InetAddress[] addrs = network != null ? network.getAllByName(clean) : InetAddress.getAllByName(clean);
            StringBuilder sb = new StringBuilder();
            for (InetAddress a : addrs) {
                if (sb.length() > 0) sb.append(", ");
                sb.append(a.getHostAddress());
            }
            dns = sb.toString();
        } catch (Exception e) {
            status = "warning";
            reason = "DNS error: " + e.getClass().getSimpleName();
        }

        HttpURLConnection conn = null;
        try {
            URL url = new URL("https://" + clean);
            conn = (HttpURLConnection) (network != null ? network.openConnection(url) : url.openConnection());
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(18000);
            conn.setReadTimeout(18000);
            conn.setRequestProperty("User-Agent", "PentagonProviderNode/" + BuildConfig.VERSION_NAME + " " + provider);
            http = conn.getResponseCode();
            finalUrl = conn.getURL().toString();

            if (http >= 500 || http == 403 || http == 451 || http == 429) {
                status = "warning";
                reason = "HTTP " + http;
            } else if (!"warning".equals(status)) {
                status = "working";
                reason = "OK";
            }
        } catch (Exception e) {
            status = "warning";
            reason = "HTTP error: " + e.getClass().getSimpleName() + ": " + safe(e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }

        return buildResult(r, provider, networkMode, status, http, finalUrl, dns, started, reason, cell);
    }

    private static JSONObject buildResult(JSONObject r, String provider, String networkMode, String status,
                                          int http, String finalUrl, String dns, long started, String reason,
                                          CellularNetworkHelper.Info cell) {
        try {
            r.put("provider_name", provider);
            r.put("network_type", networkMode);
            r.put("status", status);
            r.put("http_status", http == 0 ? JSONObject.NULL : http);
            r.put("final_url", finalUrl);
            r.put("dns_result", dns);
            r.put("latency_ms", System.currentTimeMillis() - started);
            r.put("reason", reason);
            r.put("transport", cell.available ? "cellular" : "default");
            r.put("cellular_available", cell.available);
            r.put("subscription_id", cell.subscriptionId >= 0 ? cell.subscriptionId : JSONObject.NULL);
            r.put("operator", cell.operator);
            r.put("network_type_label", TelemetryCollector.display(cell.networkType));
            r.put("network_reason", cell.reason);
        } catch (Exception ignored) {}
        return r;
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
