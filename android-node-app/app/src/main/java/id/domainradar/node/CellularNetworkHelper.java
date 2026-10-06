package id.domainradar.node;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;

final class CellularNetworkHelper {
    static final class Info {
        Network network;
        boolean available;
        int subscriptionId = -1;
        String operator = "";
        String networkType = "";
        String reason = "NO_CELLULAR_TRANSPORT";
    }

    private CellularNetworkHelper() {}

    static Info inspect(Context context) {
        Info out = new Info();
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            try {
                for (Network network : cm.getAllNetworks()) {
                    NetworkCapabilities caps = cm.getNetworkCapabilities(network);
                    if (caps == null) continue;
                    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                            && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                        out.network = network;
                        out.available = true;
                        out.reason = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                                ? "CELLULAR_TRANSPORT_VALIDATED"
                                : "CELLULAR_TRANSPORT_AVAILABLE";
                        break;
                    }
                }
            } catch (Exception ignored) {}
        }

        try {
            TelephonyManager tm = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm != null) {
                int subId = SubscriptionManager.getDefaultDataSubscriptionId();
                if (SubscriptionManager.isValidSubscriptionId(subId)) {
                    out.subscriptionId = subId;
                    try { tm = tm.createForSubscriptionId(subId); } catch (Exception ignored) {}
                }
                out.operator = safe(tm.getNetworkOperatorName());
                try {
                    out.networkType = TelemetryCollector.networkType(tm.getDataNetworkType());
                } catch (SecurityException ignored) {}
            }
        } catch (Exception ignored) {}

        if (out.available && out.subscriptionId < 0) {
            out.reason = out.reason + "_NO_VALID_SUBSCRIPTION_ID";
        }
        return out;
    }

    static boolean hasPhonePermission(Context context) {
        return context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
