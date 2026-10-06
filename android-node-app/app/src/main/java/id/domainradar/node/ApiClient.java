package id.domainradar.node;

import android.content.Context;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

class ApiClient {
    static JSONObject post(Context c, String path, JSONObject body) throws Exception {
        URL url = new URL(Prefs.central(c) + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(30000);
        conn.setReadTimeout(30000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("User-Agent", "PentagonNodeAndroid/1.6.0");
        conn.setDoOutput(true);
        try (OutputStream os = conn.getOutputStream()) { os.write(body.toString().getBytes("UTF-8")); }
        int code = conn.getResponseCode();
        InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        String text = read(is);
        if (code >= 400) throw new RuntimeException(text.isEmpty() ? ("HTTP " + code) : text);
        return text.isEmpty() ? new JSONObject() : new JSONObject(text);
    }

    private static String read(InputStream is) throws Exception {
        if (is == null) return "";
        BufferedReader br = new BufferedReader(new InputStreamReader(is));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = br.readLine()) != null) sb.append(line);
        return sb.toString();
    }
}
