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
    private static final long TASK_LIMIT_MS = 40000L;
    private final SingleFlight<JSONObject> checks = new SingleFlight<>(android.os.SystemClock::elapsedRealtime,TASK_LIMIT_MS);
    static final String CHANNEL = "domain_radar_node";

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        NodeDiagnostics.running(true);
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
                catch (Exception e) {
                    NodeDiagnostics.pollError(e);
                    String reason = NodeDiagnostics.code(e);
                    Prefs.put(this, "last_poll_error", reason.substring(0, Math.min(220, reason.length())));
                    Prefs.put(this, "last_poll_error_at", String.valueOf(System.currentTimeMillis()));
                    log("Poll error: " + reason);
                }
                try { Thread.sleep(Prefs.pollMs(this)); } catch (InterruptedException ignored) { if(!running)break; }
            }
        }, "PentagonNodeLoop");
        worker.start();
    }

    private void pollOnce() throws Exception {
        checks.tick();
        AutoProvisioner.Result provisioned = checks.busy() ? null : AutoProvisioner.ensure(this);
        if (provisioned != null && provisioned.changed) {
            log("Auto-configured " + provisioned.nodeName + " from operator " + provisioned.operator);
            updateNotification("Configured " + provisioned.provider);
        }
        String mode = Prefs.networkType(this);
        boolean mobile = "mobile".equalsIgnoreCase(mode);
        CellularNetworkHelper.Info cell = mobile
                ? CellularNetworkHelper.ensureCellular(this, 3500L)
                : CellularNetworkHelper.inspect(this);

        NodeDiagnostics.pollStart();
        JSONObject telemetry = telemetry();
        JSONObject poll = base();
        poll.put("telemetry", telemetry);
        poll.put("busy", checks.busy());

        String detectedProvider = AutoProvisioner.providerFromOperator(cell.operator);
        boolean correctSim = !mobile || (!detectedProvider.isEmpty()
                && detectedProvider.equalsIgnoreCase(Prefs.provider(this)));
        boolean networkOk = !mobile || (cell.available && correctSim);
        String networkReason = mobile
                ? cell.reason + (cell.operator.isEmpty() ? " · SIM_OPERATOR_UNKNOWN" : " · " + cell.operator)
                    + (correctSim ? "" : " · PROVIDER_IDENTITY_NOT_VERIFIED")
                : "broadband/default network";

        poll.put("network_ok", networkOk);
        poll.put("network_reason", networkReason);

        JSONObject response = ApiClient.post(this, "/api/agent/poll", poll);
        if (!response.optBoolean("ok", false)) {
            throw new IllegalStateException("ACK_REJECTED");
        }
        NodeDiagnostics.pollAck();
        // This timestamp means the Railway API really acknowledged the request,
        // NOT merely that the Android service is enabled.
        Prefs.put(this, "last_poll_ok_ms", String.valueOf(System.currentTimeMillis()));
        Prefs.putBool(this, "last_poll_network_ok", networkOk);
        Prefs.put(this, "last_poll_error", "");
        Prefs.put(this, "last_poll_error_at", "");
        checks.tick();
        submitPending();
        JSONObject task = response.optJSONObject("task");

        if (!networkOk) {
            updateNotification("Waiting cellular network");
            log("Waiting: " + networkReason);
            return;
        }

        if (task == null) {
            updateNotification(checks.busy()?"Checking; heartbeat active":"Online, waiting task");
            return;
        }

        String id = task.optString("id");
        String domain = task.optString("domain");
        String taskType = task.optString("task_type", "domain_check");

        log("Task " + id + " [" + taskType + "]: " + domain);
        updateNotification("Running " + taskType);

        final CheckContext control=new CheckContext();
        final String provider=Prefs.provider(this);
        NodeDiagnostics.phase("claimed"); NodeDiagnostics.event("TASK_START",0);
        checks.start(id, () -> {
            JSONObject result;
            if ("trustpositif_fetch".equals(taskType)) result=TrustPositifProbe.probe(this,mode);
            else result=DomainChecker.check(this,domain,provider,mode,control);
            control.check();
            return result;
        },control::cancel);
    }

    private JSONObject telemetry() throws Exception {
        JSONObject value=TelemetryCollector.collect(this);
        value.put("diagnostics",NodeDiagnostics.snapshot(this,checks.busy(),checks.elapsedMs()));
        return value;
    }

    private void submitPending() {
        SingleFlight.Outcome<JSONObject> result=checks.pending();
        if(result==null)return;
        try {
            JSONObject value=result.value;
            if(result.timedOut || result.error!=null || value==null) {
                value=new JSONObject(); value.put("status","warning");
                value.put("reason",result.timedOut?"CHECK_DEADLINE_EXCEEDED":"CHECK_ERROR_"+NodeDiagnostics.code(result.error==null?new Exception():result.error));
                value.put("latency_ms",checks.elapsedMs()); value.put("provider_name",Prefs.provider(this));
                value.put("network_type",Prefs.networkType(this));
                NodeDiagnostics.phase(result.timedOut?"timeout":"error");
                NodeDiagnostics.event(result.timedOut?"TASK_TIMEOUT":"TASK_ERROR",checks.elapsedMs());
            } else NodeDiagnostics.phase("result");
            JSONObject done=base(); done.put("task_id",result.id); done.put("result",value); done.put("telemetry",telemetry());
            JSONObject ack=ApiClient.post(this,"/api/agent/result",done);
            if(!ack.optBoolean("ok",false) && !ack.optBoolean("ignored",false))throw new IllegalStateException("ACK_REJECTED");
            boolean ignored=ack.optBoolean("ignored",false);
            NodeDiagnostics.result(ignored?"ignored":"accepted");
            log(ignored?"Result ignored: task expired or already completed":"Result accepted: "+value.optString("status"));
            checks.acknowledge(result.id);
            NodeDiagnostics.phase(checks.busy()?"cancelling":"idle");
        } catch(Exception e) {
            NodeDiagnostics.result("error"); log("Result upload: "+NodeDiagnostics.code(e));
        }
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

    @Override public void onDestroy() {
        running = false;
        NodeDiagnostics.running(false);
        checks.close();
        ApiClient.cancelAll();
        if(worker!=null)worker.interrupt();
        CellularNetworkHelper.releaseCellular(this);
        if (Prefs.getBool(this, "enabled", false)) {
            try { startService(new Intent(this, NodeService.class)); } catch (Exception ignored) {}
        }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
