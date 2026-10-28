package id.domainradar.node;

import android.content.Context;
import android.net.Network;
import org.json.JSONObject;

import okhttp3.OkHttpClient;
import okhttp3.Call;
import okhttp3.Request;
import okhttp3.Response;
import java.util.concurrent.TimeUnit;
import java.util.List;
import java.net.InetAddress;

class DomainChecker {
    static JSONObject check(Context context, String domain, String provider, String networkMode, CheckContext control) {
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

        final StringBuilder resolved = new StringBuilder();
        long httpStarted = android.os.SystemClock.elapsedRealtime();
        try {
            control.check();
            if (requireCellular && !AutoProvisioner.providerFromOperator(cell.operator).equalsIgnoreCase(provider)) {
                return buildResult(r, provider, networkMode, "warning", 0, "", "", started,
                        "PROVIDER_IDENTITY_NOT_VERIFIED", cell);
            }
            OkHttpClient.Builder builder = new OkHttpClient.Builder()
                    .connectTimeout(12, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS)
                    .callTimeout(35, TimeUnit.SECONDS).retryOnConnectionFailure(false)
                    .followSslRedirects(false).connectionPool(new okhttp3.ConnectionPool(0, 1, TimeUnit.SECONDS))
                    .dns(host -> {
                        List<InetAddress> addresses=NetworkDns.resolve(network,host);
                        for(InetAddress address:addresses) {
                            if(resolved.length()<500) { if(resolved.length()>0)resolved.append(", "); resolved.append(address.getHostAddress()); }
                        }
                        return addresses;
                    });
            if(network!=null)builder.socketFactory(network.getSocketFactory());
            Call call=builder.build().newCall(new Request.Builder().url("https://"+clean)
                    .header("User-Agent", "PentagonProviderNode/"+BuildConfig.VERSION_NAME+" "+provider).build());
            control.attach(call); control.check(); NodeDiagnostics.phase("http");
            try(Response response=call.execute()) {
                http=response.code(); finalUrl=response.request().url().toString();
                if(http>=500 || http==403 || http==451 || http==429 || http>=300 && http<400) {
                    status="warning"; reason="HTTP "+http;
                }
            }
        } catch(Exception e) {
            status="warning";
            reason="HTTP error: "+e.getClass().getSimpleName()+": "+safe(e.getMessage());
        } finally {
            dns=resolved.toString();
            NodeDiagnostics.timing("http",android.os.SystemClock.elapsedRealtime()-httpStarted);
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
