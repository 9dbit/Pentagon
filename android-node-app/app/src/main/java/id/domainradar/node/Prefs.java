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
        String value = get(c, "central", "https://pentagon-web-production.up.railway.app").replaceAll("/+$", "");
        if ("https://domain-radar.org".equalsIgnoreCase(value)
                || "https://pentagon.quest".equalsIgnoreCase(value)
                || "https://demo.pentagon.quest".equalsIgnoreCase(value)) {
            return "https://pentagon-web-production.up.railway.app";
        }
        return value;
    }
    static String nodeName(Context c) { return get(c, "node", "INDOSAT-JKT-01"); }
    static String provider(Context c) { return get(c, "provider", "Indosat"); }
    static String networkType(Context c) { return get(c, "network_type", "mobile"); }
    static String expectedOrg(Context c) { return get(c, "expected_org", "indosat"); }
    static String secret(Context c) { return get(c, "secret", ""); }
    static int pollMs(Context c) { try { return Integer.parseInt(get(c, "poll_ms", "3000")); } catch(Exception e) { return 3000; } }
}
