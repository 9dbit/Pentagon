package id.domainradar.node;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.widget.*;
import org.json.JSONObject;

public class MainActivity extends Activity {
    LinearLayout root;
    TextView status, logs;
    private volatile boolean provisioning = false;

    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        requestRuntimePermissions();
        buildUi();
        autoConfigureAndStart();
    }

    private void buildUi() {
        ScrollView sv = new ScrollView(this);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(36, 36, 36, 36);
        root.setBackgroundColor(Color.rgb(5, 10, 18));
        sv.addView(root);

        title("Pentagon Node " + BuildConfig.VERSION_NAME);
        root.addView(text("Zero-config Provider Node", 14, Color.rgb(150,160,180)));

        status = text("Detecting active SIM provider...", 16, Color.WHITE);
        logs = text("", 13, Color.LTGRAY);
        root.addView(status);

        Button auto = btn("Auto Detect & Start");
        auto.setOnClickListener(v -> autoConfigureAndStart());
        root.addView(auto);

        Button stop = btn("Stop Node");
        stop.setOnClickListener(v -> {
            Prefs.putBool(this, "enabled", false);
            stopService(new Intent(this, NodeService.class));
            refreshStatus();
        });
        root.addView(stop);

        Button clearLogs = btn("Clear Logs");
        clearLogs.setOnClickListener(v -> {
            Prefs.put(this, "logs", "");
            refreshStatus();
        });
        root.addView(clearLogs);

        Button checkUpdate = btn("Check Update");
        checkUpdate.setOnClickListener(v -> AppUpdater.check(this, true));
        root.addView(checkUpdate);

        root.addView(logs);
        setContentView(sv);
        refreshStatus();
        AppUpdater.check(this, false);
    }

    private void autoConfigureAndStart() {
        if (provisioning) return;
        provisioning = true;
        status.setText("Detecting active mobile operator and provisioning node...");

        new Thread(() -> {
            try {
                AutoProvisioner.Result result = AutoProvisioner.ensure(this);
                Prefs.putBool(this, "enabled", true);
                runOnUiThread(() -> {
                    provisioning = false;
                    startNode();
                    toast("Detected " + result.provider + " · " + result.nodeName);
                    refreshStatus();
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    provisioning = false;
                    status.setText("Auto setup waiting: " + safe(e.getMessage())
                            + "\n\nEnable mobile data on the provider SIM, allow requested permissions, then tap Auto Detect & Start.");
                    refreshLogsOnly();
                });
            }
        }, "PentagonAutoProvision").start();
    }

    private void startNode() {
        Intent s = new Intent(this, NodeService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(s);
        else startService(s);
    }

    private void refreshStatus() {
        try {
            JSONObject t = TelemetryCollector.collect(this);
            String node = Prefs.nodeName(this);
            String provider = Prefs.provider(this);
            boolean provisioned = !node.isEmpty() && !Prefs.secret(this).isEmpty();
            status.setText(
                    "Provider: " + (provider.isEmpty() ? "Detecting..." : provider)
                    + "\nNode: " + (node.isEmpty() ? "Auto provisioning..." : node)
                    + "\nCredential: " + (provisioned ? "Provisioned securely" : "Not provisioned yet")
                    + "\nService enabled: " + Prefs.getBool(this, "enabled", false)
                    + "\nTelemetry: " + t.toString()
            );
            refreshLogsOnly();
        } catch(Exception e) {
            status.setText(safe(e.getMessage()));
        }
    }

    private void refreshLogsOnly() {
        logs.setText("\nLogs:\n" + Prefs.get(this, "logs", ""));
    }

    private Button btn(String label) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextColor(Color.WHITE);
        b.setBackgroundColor(Color.rgb(249, 115, 22));
        return b;
    }

    private void title(String s) { root.addView(text(s, 24, Color.WHITE)); }

    private TextView text(String s, int sp, int color) {
        TextView v = new TextView(this);
        v.setText(s);
        v.setTextSize(sp);
        v.setTextColor(color);
        v.setPadding(0,12,0,12);
        return v;
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show(); }
    private String safe(String s) { return s == null || s.isEmpty() ? "unknown error" : s; }

    private void requestRuntimePermissions() {
        if (Build.VERSION.SDK_INT >= 23) {
            java.util.ArrayList<String> ps = new java.util.ArrayList<>();
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
                ps.add(Manifest.permission.ACCESS_FINE_LOCATION);
            if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED)
                ps.add(Manifest.permission.READ_PHONE_STATE);
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                ps.add(Manifest.permission.POST_NOTIFICATIONS);
            if (!ps.isEmpty()) requestPermissions(ps.toArray(new String[0]), 5);
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 5) autoConfigureAndStart();
    }
}
