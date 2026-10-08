package id.domainradar.node;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import org.json.JSONObject;

public class NodeService extends Service {
    private volatile boolean running = false;
    private Thread worker;
    static final String CHANNEL = "domain_radar_node";

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        Prefs.putBool(this, "enabled", true);
        startForeground(88, notification("Starting " + Prefs.nodeName(this)));
        startLoop();
        return START_STICKY;
    }

    private void startLoop() {
        if (running) return;
        running = true;
        worker = new Thread(() -> {
            while (running) {
                try { pollOnce(); }
                catch (Exception e) { log("Poll error: " + safe(e.getMessage())); }
                try { Thread.sleep(Math.max(1500, Prefs.pollMs(this))); } catch (InterruptedException ignored) {}
            }
        }, "PentagonNodeLoop");
        worker.start();
    }

    private void pollOnce() throws Exception {
        AutoProvisioner.Result provisioned = AutoProvisioner.ensure(this);
        if (provisioned.changed) {
            log("Auto-configured " + provisioned.nodeName + " from operator " + provisioned.operator);
            updateNotification("Configured " + provisioned.provider);
        }
        String mode = Prefs.networkType(this);
        boolean mobile = "mobile".equalsIgnoreCase(mode);
        CellularNetworkHelper.Info cell = mobile
                ? CellularNetworkHelper.ensureCellular(this, 3500L)
                : CellularNetworkHelper.inspect(this);

        JSONObject telemetry = TelemetryCollector.collect(this);
        JSONObject poll = base();
        poll.put("telemetry", telemetry);

        boolean networkOk = !mobile || cell.available;
        String networkReason = mobile
                ? cell.reason + (cell.operator.isEmpty() ? "" : " · " + cell.operator)
                : "broadband/default network";

        poll.put("network_ok", networkOk);
        poll.put("network_reason", networkReason);

        JSONObject response = ApiClient.post(this, "/api/agent/poll", poll);
        JSONObject task = response.optJSONObject("task");

        if (!networkOk) {
            updateNotification("Waiting cellular network");
            log("Waiting: " + networkReason);
            return;
        }

        if (task == null) {
            updateNotification("Online, waiting task");
            return;
        }

        String id = task.optString("id");
        String domain = task.optString("domain");
        String taskType = task.optString("task_type", "domain_check");
        JSONObject payload = task.optJSONObject("payload");

        log("Task " + id + " [" + taskType + "]: " + domain);
        updateNotification("Running " + taskType);

        JSONObject result;
        if ("trustpositif_fetch".equals(taskType)) {
            result = TrustPositifProbe.probe(this, mode);
        } else {
            result = DomainChecker.check(this, domain, Prefs.provider(this), mode);
        }

        if (payload != null && "trustpositif_fetch".equals(taskType)) {
            result.put("requested_source_url", payload.optString("source_url", TrustPositifProbe.SOURCE_URL));
        }

        JSONObject done = base();
        done.put("task_id", id);
        done.put("result", result);
        done.put("telemetry", TelemetryCollector.collect(this));
        ApiClient.post(this, "/api/agent/result", done);

        String msg = "Done " + taskType + ": " + result.optString("status") + " / " + result.optString("reason");
        log(msg);
        updateNotification(msg);
    }

    private JSONObject base() throws Exception {
        JSONObject o = new JSONObject();
        o.put("node_name", Prefs.nodeName(this));
        o.put("secret_key", Prefs.secret(this));
        return o;
    }

    private void updateNotification(String text) {
        NotificationManager nm = (NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(88, notification(text));
    }

    private Notification notification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return b.setContentTitle("Pentagon Node")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Pentagon Node", NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = (NotificationManager)getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    static void logStatic(android.content.Context c, String m) {
        String old = Prefs.get(c, "logs", "");
        String line = "[" + new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(new java.util.Date()) + "] " + m + "\n";
        if (old.length() > 5000) old = old.substring(0, 5000);
        Prefs.put(c, "logs", line + old);
    }
    private void log(String m) { logStatic(this, m); }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    @Override public void onDestroy() {
        running = false;
        CellularNetworkHelper.releaseCellular(this);
        if (Prefs.getBool(this, "enabled", false)) {
            try { startService(new Intent(this, NodeService.class)); } catch (Exception ignored) {}
        }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
