package id.domainradar.node;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Prefs.getBool(context, "enabled", false)) return;
        Intent service = new Intent(context, NodeService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service);
            else context.startService(service);
            NodeService.logStatic(context, "Boot receiver requested service start");
        } catch (RuntimeException e) {
            // Android OEM background restrictions can still block startup.
            // Surface the reason in Recent Logs rather than crashing silently.
            NodeService.logStatic(context, "Boot start denied: " + e.getClass().getSimpleName());
        }
    }
}
