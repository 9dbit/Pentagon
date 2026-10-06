package id.domainradar.node;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Prefs.getBool(context, "enabled", false)) return;
        Intent service = new Intent(context, NodeService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service);
        else context.startService(service);
        NodeService.logStatic(context, "Boot receiver started service");
    }
}
