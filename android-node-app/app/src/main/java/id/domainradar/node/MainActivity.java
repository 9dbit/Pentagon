package id.domainradar.node;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.widget.*;
import org.json.JSONObject;

public class MainActivity extends Activity {
    LinearLayout root;
    TextView status, logs;

    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        requestRuntimePermissions();
        buildUi();
    }

    private void buildUi() {
        ScrollView sv = new ScrollView(this);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(36, 36, 36, 36);
        root.setBackgroundColor(Color.rgb(5, 10, 18));
        sv.addView(root);
        title("Pentagon Node 1.6.0");

        EditText central = input("Central URL", Prefs.central(this));
        EditText node = input("Node Name", Prefs.nodeName(this));
        EditText provider = input("Provider", Prefs.provider(this));
        EditText networkType = input("Network Type (mobile/broadband)", Prefs.networkType(this));
        EditText expected = input("Expected Org", Prefs.expectedOrg(this));
        EditText secret = input("Agent Secret", Prefs.secret(this));
        EditText poll = input("Poll Interval ms", String.valueOf(Prefs.pollMs(this)));
        EditText quotaRemain = input("Quota remaining GB", Prefs.get(this, "quota_remaining_gb", ""));
        EditText quotaTotal = input("Quota total GB", Prefs.get(this, "quota_total_gb", ""));
        EditText quotaExp = input("Quota expires YYYY-MM-DD", Prefs.get(this, "quota_expires_at", ""));

        Button save = btn("Save Config");
        save.setOnClickListener(v -> {
            Prefs.put(this, "central", central.getText().toString().trim());
            Prefs.put(this, "node", node.getText().toString().trim());
            Prefs.put(this, "provider", provider.getText().toString().trim());
            Prefs.put(this, "network_type", networkType.getText().toString().trim());
            Prefs.put(this, "expected_org", expected.getText().toString().trim());
            Prefs.put(this, "secret", secret.getText().toString().trim());
            Prefs.put(this, "poll_ms", poll.getText().toString().trim());
            Prefs.put(this, "quota_remaining_gb", quotaRemain.getText().toString().trim());
            Prefs.put(this, "quota_total_gb", quotaTotal.getText().toString().trim());
            Prefs.put(this, "quota_expires_at", quotaExp.getText().toString().trim());
            toast("Config saved");
            refreshStatus();
        });
        root.addView(save);

        Button start = btn("Start Node");
        start.setOnClickListener(v -> { Prefs.putBool(this, "enabled", true); startNode(); refreshStatus(); });
        root.addView(start);

        Button stop = btn("Stop Node");
        stop.setOnClickListener(v -> { Prefs.putBool(this, "enabled", false); stopService(new Intent(this, NodeService.class)); refreshStatus(); });
        root.addView(stop);

        Button clearLogs = btn("Clear Logs");
        clearLogs.setOnClickListener(v -> { Prefs.put(this, "logs", ""); refreshStatus(); });
        root.addView(clearLogs);

        status = text("", 16, Color.WHITE);
        logs = text("", 13, Color.LTGRAY);
        root.addView(status);
        root.addView(logs);
        setContentView(sv);
        refreshStatus();
    }

    private void startNode() {
        Intent s = new Intent(this, NodeService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(s);
        else startService(s);
        toast("Node service started");
    }

    private void refreshStatus() {
        try {
            JSONObject t = TelemetryCollector.collect(this);
            status.setText("Node: " + Prefs.nodeName(this) + "\nProvider: " + Prefs.provider(this) + "\nService enabled: " + Prefs.getBool(this, "enabled", false) + "\nTelemetry: " + t.toString());
            logs.setText("\nLogs:\n" + Prefs.get(this, "logs", ""));
        } catch(Exception e) { status.setText(e.getMessage()); }
    }

    private EditText input(String hint, String value) {
        TextView l = text(hint, 13, Color.rgb(150,160,180));
        root.addView(l);
        EditText e = new EditText(this);
        e.setText(value);
        e.setHint(hint);
        e.setSingleLine(true);
        e.setTextColor(Color.WHITE);
        e.setHintTextColor(Color.GRAY);
        e.setBackgroundColor(Color.rgb(15, 25, 40));
        root.addView(e, new LinearLayout.LayoutParams(-1, -2));
        return e;
    }

    private Button btn(String label) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextColor(Color.WHITE);
        b.setBackgroundColor(Color.rgb(249, 115, 22));
        return b;
    }

    private void title(String s) { root.addView(text(s, 24, Color.WHITE)); }
    private TextView text(String s, int sp, int color) { TextView v = new TextView(this); v.setText(s); v.setTextSize(sp); v.setTextColor(color); v.setPadding(0,12,0,12); return v; }
    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show(); }

    private void requestRuntimePermissions() {
        if (Build.VERSION.SDK_INT >= 23) {
            java.util.ArrayList<String> ps = new java.util.ArrayList<>();
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) ps.add(Manifest.permission.ACCESS_FINE_LOCATION);
            if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) ps.add(Manifest.permission.READ_PHONE_STATE);
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) ps.add(Manifest.permission.POST_NOTIFICATIONS);
            if (!ps.isEmpty()) requestPermissions(ps.toArray(new String[0]), 5);
        }
    }
}
