package id.domainradar.node;

import android.content.Context;
import android.content.SharedPreferences;

class Prefs {
    private static final String NAME = "domain_radar_node";
    static SharedPreferences sp(Context c) { return c.getSharedPreferences(NAME, Context.MODE_PRIVATE); }
    static String get(Context c, String key, String def) { return sp(c).getString(key, def); }
    static boolean getBool(Context c, String key, boolean def) { return sp(c).getBoolean(key, def); }
    static void put(Context c, String key, String value) { sp(c).edit().putString(key, value).apply(); }
    static void putBool(Context c, String key, boolean value) { sp(c).edit().putBoolean(key, value).apply(); }

    static String central(Context c) {
        String value = get(c, "central", "https://pentagon-web-production.up.railway.app").trim().replaceAll("/+$", "");
        String lower = value.toLowerCase(java.util.Locale.US);
        // Migrate only known legacy Pentagon hostnames. Keep existing node
        // credentials, provider identity, and install ID exactly as stored.
        if (lower.isEmpty() || lower.equals("https://domain-radar.org")
                || lower.equals("https://pentagon.quest")
                || lower.equals("https://demo.pentagon.quest")
                || lower.endsWith(".replit.app")
                || lower.endsWith(".replit.dev")
                || lower.endsWith(".repl.co")) {
            return "https://pentagon-web-production.up.railway.app";
        }
        return value;
    }
    static String nodeName(Context c) { return get(c, "node", ""); }
    static String provider(Context c) { return get(c, "provider", ""); }
    static String networkType(Context c) { return get(c, "network_type", "mobile"); }
    static String expectedOrg(Context c) { return get(c, "expected_org", ""); }
    static String secret(Context c) { return get(c, "secret", ""); }
    static String installId(Context c) {
        String current = get(c, "install_id", "");
        if (!current.isEmpty()) return current;
        String created = java.util.UUID.randomUUID().toString();
        put(c, "install_id", created);
        return created;
    }
    static int pollMs(Context c) { try { return Integer.parseInt(get(c, "poll_ms", "3000")); } catch(Exception e) { return 3000; } }
}
