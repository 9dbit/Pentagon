package id.domainradar.node;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.BatteryManager;
import android.telephony.CellInfo;
import android.telephony.CellInfoLte;
import android.telephony.CellSignalStrength;
import android.telephony.TelephonyManager;
import org.json.JSONObject;
import java.util.List;

class TelemetryCollector {
    static JSONObject collect(Context c) {
        JSONObject o = new JSONObject();
        try {
            BatteryManager bm = (BatteryManager)c.getSystemService(Context.BATTERY_SERVICE);
            int pct = bm == null ? -1 : bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            o.put("battery_percent", pct >= 0 ? pct : JSONObject.NULL);
            o.put("is_charging", false);
            o.put("battery_status", "android");
            o.put("battery_health", "unknown");
            o.put("battery_temperature_c", JSONObject.NULL);

            Signal s = readSignal(c);
            o.put("signal_percent", s.percent >= 0 ? s.percent : JSONObject.NULL);
            o.put("signal_dbm", s.dbm != 0 ? s.dbm : JSONObject.NULL);
            o.put("signal_asu", s.asu >= 0 ? s.asu : JSONObject.NULL);
            o.put("signal_level", s.level >= 0 ? s.level : JSONObject.NULL);
            o.put("signal_label", s.label);
            o.put("network_operator", s.operator);
            o.put("network_type_label", s.type);

            CellularNetworkHelper.Info cell = CellularNetworkHelper.inspect(c);
            o.put("cellular_available", cell.available);
            o.put("subscription_id", cell.subscriptionId >= 0 ? cell.subscriptionId : JSONObject.NULL);
            o.put("subscription_reason", cell.reason);
            if (!cell.operator.isEmpty()) o.put("network_operator", cell.operator);
            if (!cell.networkType.isEmpty()) o.put("network_type_label", display(cell.networkType));

            String qRemain = Prefs.get(c, "quota_remaining_gb", "");
            String qTotal = Prefs.get(c, "quota_total_gb", "");
            String qExp = Prefs.get(c, "quota_expires_at", "");
            if (!qRemain.isEmpty()) o.put("quota_remaining_gb", Double.parseDouble(qRemain));
            if (!qTotal.isEmpty()) o.put("quota_total_gb", Double.parseDouble(qTotal));
            if (!qExp.isEmpty()) o.put("quota_expires_at", qExp);
            if (!qRemain.isEmpty() && !qTotal.isEmpty()) o.put("quota_label", qRemain + " GB / " + qTotal + " GB");
        } catch (Exception ignored) {}
        return o;
    }

    private static Signal readSignal(Context c) {
        Signal s = new Signal();
        try {
            TelephonyManager tm = (TelephonyManager)c.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null) return s;
            s.operator = safe(tm.getNetworkOperatorName());
            s.type = networkType(tm.getDataNetworkType());
            s.label = display(s.type);
            if (c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return s;
            List<CellInfo> infos = tm.getAllCellInfo();
            if (infos == null) return s;
            for (CellInfo info : infos) {
                if (info == null || !info.isRegistered()) continue;
                CellSignalStrength cs = null;
                if (info instanceof CellInfoLte) { cs = ((CellInfoLte)info).getCellSignalStrength(); s.type = "lte"; s.label = "4G LTE"; }
                if (cs != null) {
                    int dbm = cs.getDbm();
                    int asu = cs.getAsuLevel();
                    int level = cs.getLevel();

                    s.dbm = (dbm <= -20 && dbm >= -200) ? dbm : 0;
                    s.asu = (asu >= 0 && asu <= 255) ? asu : -1;
                    s.level = (level >= 0 && level <= 4) ? level : -1;
                    s.percent = s.level >= 0
                            ? Math.max(0, Math.min(100, Math.round((s.level / 4f) * 100)))
                            : -1;
                    break;
                }
            }
        } catch (Exception ignored) {}
        return s;
    }

    static String networkType(int t) {
        switch (t) {
            case TelephonyManager.NETWORK_TYPE_LTE: return "lte";
            case TelephonyManager.NETWORK_TYPE_EDGE: return "edge";
            case TelephonyManager.NETWORK_TYPE_GPRS: return "gprs";
            case TelephonyManager.NETWORK_TYPE_HSDPA:
            case TelephonyManager.NETWORK_TYPE_HSPA:
            case TelephonyManager.NETWORK_TYPE_HSUPA:
            case TelephonyManager.NETWORK_TYPE_UMTS: return "hspa";
            case TelephonyManager.NETWORK_TYPE_NR: return "5g";
            default: return "mobile";
        }
    }

    static String display(String t) {
        if ("lte".equals(t)) return "4G LTE";
        if ("5g".equals(t)) return "5G";
        if ("edge".equals(t)) return "EDGE";
        if ("gprs".equals(t)) return "GPRS";
        if ("hspa".equals(t)) return "3G HSPA";
        return t == null || t.isEmpty() ? "mobile" : t.toUpperCase();
    }
    private static String safe(String x) { return x == null ? "" : x; }
    static class Signal { int percent=-1, dbm=0, asu=-1, level=-1; String label="", type="", operator=""; }
}
