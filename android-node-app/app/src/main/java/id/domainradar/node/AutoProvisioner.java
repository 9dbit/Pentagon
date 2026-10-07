package id.domainradar.node;

import android.content.Context;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

final class AutoProvisioner {
    static final class Result {
        final String operator;
        final String provider;
        final String nodeName;
        final boolean changed;
        Result(String operator, String provider, String nodeName, boolean changed) {
            this.operator = operator;
            this.provider = provider;
            this.nodeName = nodeName;
            this.changed = changed;
        }
    }

    private AutoProvisioner() {}

    static Result ensure(Context context) throws Exception {
        CellularNetworkHelper.Info cell = CellularNetworkHelper.inspect(context);
        String operator = safe(cell.operator).trim();
        String detectedProvider = providerFromOperator(operator);
        if (detectedProvider.isEmpty()) {
            throw new IllegalStateException(operator.isEmpty()
                    ? "No active mobile operator detected"
                    : "Unsupported operator: " + operator);
        }

        if (detectedProvider.equalsIgnoreCase(Prefs.provider(context))
                && !Prefs.nodeName(context).isEmpty()
                && !Prefs.secret(context).isEmpty()) {
            return new Result(operator, Prefs.provider(context), Prefs.nodeName(context), false);
        }

        JSONObject request = new JSONObject();
        request.put("operator", operator);
        request.put("install_id", Prefs.installId(context));
        request.put("app_version", BuildConfig.VERSION_NAME);
        request.put("cellular_available", cell.available);
        request.put("subscription_id", cell.subscriptionId >= 0 ? cell.subscriptionId : JSONObject.NULL);

        JSONObject response = post(context, "/api/agent/bootstrap", request);
        String nodeName = response.getString("node_name").trim();
        String provider = response.getString("provider_name").trim();
        String secret = response.getString("secret_key").trim();
        if (nodeName.isEmpty() || provider.isEmpty() || secret.isEmpty()) {
            throw new IllegalStateException("Bootstrap returned incomplete node credentials");
        }

        Prefs.put(context, "central", response.optString("central_url",
                "https://pentagon-web-production.up.railway.app").trim());
        Prefs.put(context, "node", nodeName);
        Prefs.put(context, "provider", provider);
        Prefs.put(context, "network_type", response.optString("network_type", "mobile").trim());
        Prefs.put(context, "expected_org", response.optString("expected_org",
                provider.toLowerCase(Locale.US)).trim());
        Prefs.put(context, "secret", secret);
        Prefs.put(context, "poll_ms", response.optString("poll_ms", "3000"));

        return new Result(operator, provider, nodeName, true);
    }

    static String providerFromOperator(String operator) {
        String value = safe(operator).toLowerCase(Locale.US).replaceAll("\\s+", " ").trim();
        if (value.contains("telkomsel")) return "Telkomsel";
        if (value.equals("xl") || value.contains("xl axiata") || value.contains("axiata")) return "XL";
        if (value.contains("indosat") || value.contains("im3")) return "Indosat";
        if (value.equals("3") || value.contains("tri") || value.contains("three")) return "Tri";
        if (value.contains("smartfren")) return "Smartfren";
        return "";
    }

    private static JSONObject post(Context context, String path, JSONObject body) throws Exception {
        URL url = new URL(Prefs.central(context) + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(20000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("Cache-Control", "no-cache");
        conn.setRequestProperty("User-Agent", "PentagonProviderNode/" + BuildConfig.VERSION_NAME);
        conn.setDoOutput(true);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(body.toString().getBytes("UTF-8"));
        }
        int code = conn.getResponseCode();
        InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        String text = read(stream);
        if (code >= 400) {
            String detail = text;
            try { detail = new JSONObject(text).optString("error", text); } catch (Exception ignored) {}
            throw new IllegalStateException("Bootstrap HTTP " + code + ": " + detail);
        }
        return new JSONObject(text);
    }

    private static String read(InputStream stream) throws Exception {
        if (stream == null) return "";
        BufferedReader br = new BufferedReader(new InputStreamReader(stream));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = br.readLine()) != null) sb.append(line);
        return sb.toString();
    }

    private static String safe(String value) { return value == null ? "" : value; }
}
