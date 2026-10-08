package id.domainradar.node;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
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

    private static final Object REQUEST_LOCK = new Object();
    private static volatile Network requestedNetwork;
    private static volatile ConnectivityManager.NetworkCallback cellularCallback;
    private static volatile long lastRequestAt = 0L;

    private CellularNetworkHelper() {}

    static Info inspect(Context context) {
        Info out = new Info();
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            try {
                Network preferred = requestedNetwork;
                if (preferred != null && applyNetwork(cm, preferred, out)) {
                    fillTelephony(context, out);
                    return finalizeInfo(out);
                }

                for (Network network : cm.getAllNetworks()) {
                    if (applyNetwork(cm, network, out)) break;
                }
            } catch (Exception ignored) {}
        }

        fillTelephony(context, out);
        return finalizeInfo(out);
    }

    static Info ensureCellular(Context context, long waitMs) {
        Info current = inspect(context);
        if (current.available) return current;

        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return current;

        synchronized (REQUEST_LOCK) {
            long now = System.currentTimeMillis();
            if (cellularCallback == null && now - lastRequestAt > 5000L) {
                lastRequestAt = now;
                NetworkRequest request = new NetworkRequest.Builder()
                        .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
                        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        .build();

                cellularCallback = new ConnectivityManager.NetworkCallback() {
                    @Override public void onAvailable(Network network) {
                        requestedNetwork = network;
                    }

                    @Override public void onLost(Network network) {
                        if (requestedNetwork != null && requestedNetwork.equals(network)) {
                            requestedNetwork = null;
                        }
                    }

                    @Override public void onUnavailable() {
                        requestedNetwork = null;
                        synchronized (REQUEST_LOCK) {
                            cellularCallback = null;
                        }
                    }
                };

                try {
                    cm.requestNetwork(request, cellularCallback);
                } catch (Exception e) {
                    cellularCallback = null;
                }
            }
        }

        long deadline = System.currentTimeMillis() + Math.max(0L, waitMs);
        while (System.currentTimeMillis() < deadline) {
            try { Thread.sleep(250L); } catch (InterruptedException ignored) { break; }
            current = inspect(context);
            if (current.available) return current;
        }
        return inspect(context);
    }

    static void releaseCellular(Context context) {
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        synchronized (REQUEST_LOCK) {
            if (cm != null && cellularCallback != null) {
                try { cm.unregisterNetworkCallback(cellularCallback); } catch (Exception ignored) {}
            }
            cellularCallback = null;
            requestedNetwork = null;
        }
    }

    private static boolean applyNetwork(ConnectivityManager cm, Network network, Info out) {
        NetworkCapabilities caps = cm.getNetworkCapabilities(network);
        if (caps == null) return false;
        if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return false;
        if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return false;

        out.network = network;
        out.available = true;
        out.reason = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                ? "CELLULAR_TRANSPORT_VALIDATED"
                : "CELLULAR_TRANSPORT_AVAILABLE";
        return true;
    }

    private static void fillTelephony(Context context, Info out) {
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
    }

    private static Info finalizeInfo(Info out) {
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
