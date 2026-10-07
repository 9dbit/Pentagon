package id.domainradar.node;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Space;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final int BG = Color.rgb(5, 10, 18);
    private static final int CARD = Color.rgb(10, 22, 34);
    private static final int CARD_ALT = Color.rgb(12, 27, 41);
    private static final int BORDER = Color.rgb(31, 52, 69);
    private static final int TEXT = Color.rgb(244, 247, 251);
    private static final int MUTED = Color.rgb(151, 166, 184);
    private static final int ORANGE = Color.rgb(249, 115, 22);
    private static final int GREEN = Color.rgb(35, 211, 133);
    private static final int RED = Color.rgb(255, 92, 92);

    private LinearLayout root;
    private TextView statusDot, statusTitle, statusSubtitle, servicePill;
    private TextView providerValue, nodeValue, credentialValue, serviceValue;
    private TextView batteryValue, batterySub, signalValue, signalSub, levelValue, levelSub;
    private TextView tempValue, tempSub, networkValue, networkSub, operatorValue, operatorSub;
    private TextView cellularValue, cellularSub, subscriptionValue, subscriptionSub;
    private TextView updatedText, recentLogs;
    private volatile boolean provisioning = false;
    private String lastSetupError = "";

    private final Handler refreshHandler = new Handler(Looper.getMainLooper());
    private final Runnable refreshRunnable = new Runnable() {
        @Override public void run() {
            refreshStatus();
            refreshHandler.postDelayed(this, 3000);
        }
    };

    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(BG);
            getWindow().setNavigationBarColor(BG);
        }
        requestRuntimePermissions();
        buildUi();
        autoConfigureAndStart();
    }

    @Override protected void onResume() {
        super.onResume();
        refreshHandler.removeCallbacks(refreshRunnable);
        refreshHandler.post(refreshRunnable);
    }

    @Override protected void onPause() {
        refreshHandler.removeCallbacks(refreshRunnable);
        super.onPause();
    }

    private void buildUi() {
        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        sv.setBackgroundColor(BG);
        sv.setClipToPadding(false);

        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(18), dp(20), dp(28));
        root.setBackgroundColor(BG);
        sv.addView(root, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        buildHeader();
        spacer(18);
        buildStatusCard();
        spacer(16);
        buildTelemetryCard();
        spacer(16);
        buildQuickActions();
        spacer(16);
        buildLogsCard();

        setContentView(sv);
        refreshStatus();
        AppUpdater.check(this, false);
    }

    private void buildHeader() {
        LinearLayout row = hLayout(Gravity.CENTER_VERTICAL);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.ic_launcher);
        logo.setScaleType(ImageView.ScaleType.CENTER_CROP);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(54), dp(54));
        lp.rightMargin = dp(14);
        row.addView(logo, lp);

        LinearLayout titles = vLayout();
        LinearLayout titleLine = hLayout(Gravity.BOTTOM);
        TextView title = label("Pentagon Node", 24, TEXT, true);
        titleLine.addView(title);

        TextView version = label(BuildConfig.VERSION_NAME, 15, MUTED, false);
        LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        vlp.leftMargin = dp(10);
        vlp.bottomMargin = dp(2);
        titleLine.addView(version, vlp);

        titles.addView(titleLine);
        TextView subtitle = label("Zero-config Provider Node", 14, MUTED, false);
        titles.addView(subtitle);

        row.addView(titles, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(row);
    }

    private void buildStatusCard() {
        LinearLayout card = card();
        card.setPadding(dp(18), dp(18), dp(18), dp(16));

        LinearLayout top = hLayout(Gravity.CENTER_VERTICAL);
        statusDot = label("●", 30, GREEN, true);
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(42), ViewGroup.LayoutParams.WRAP_CONTENT);
        top.addView(statusDot, dlp);

        LinearLayout state = vLayout();
        statusTitle = label("Node starting", 20, TEXT, true);
        statusSubtitle = label("Preparing secure provider connection", 13, MUTED, false);
        state.addView(statusTitle);
        state.addView(statusSubtitle);
        top.addView(state, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        servicePill = label("Starting", 12, ORANGE, true);
        servicePill.setGravity(Gravity.CENTER);
        servicePill.setPadding(dp(12), dp(8), dp(12), dp(8));
        servicePill.setBackground(roundRect(Color.rgb(20, 39, 34), GREEN, 1, 18));
        top.addView(servicePill);

        card.addView(top);
        divider(card, 14, 12);

        providerValue = value();
        nodeValue = value();
        credentialValue = value();
        serviceValue = value();

        card.addView(infoRow("Provider", providerValue));
        card.addView(infoRow("Node", nodeValue));
        card.addView(infoRow("Credential", credentialValue));
        card.addView(infoRow("Service", serviceValue));

        root.addView(card);
    }

    private void buildTelemetryCard() {
        LinearLayout card = card();
        card.setPadding(dp(16), dp(16), dp(16), dp(16));

        LinearLayout heading = hLayout(Gravity.CENTER_VERTICAL);
        TextView title = label("Connectivity & Telemetry", 18, TEXT, true);
        heading.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        updatedText = label("Updated just now", 12, MUTED, false);
        heading.addView(updatedText);
        card.addView(heading);
        spacerInside(card, 14);

        batteryValue = valueLarge(); batterySub = sub();
        signalValue = valueLarge(); signalSub = sub();
        levelValue = valueLarge(); levelSub = sub();
        tempValue = valueLarge(); tempSub = sub();
        networkValue = valueLarge(); networkSub = sub();
        operatorValue = valueLarge(); operatorSub = sub();
        cellularValue = valueLarge(); cellularSub = sub();
        subscriptionValue = valueLarge(); subscriptionSub = sub();

        card.addView(tileRow(
                tile("Battery", batteryValue, batterySub, GREEN),
                tile("Signal", signalValue, signalSub, GREEN)
        ));
        spacerInside(card, 10);
        card.addView(tileRow(
                tile("Signal Level", levelValue, levelSub, ORANGE),
                tile("Temperature", tempValue, tempSub, Color.rgb(173, 190, 211))
        ));
        spacerInside(card, 10);
        card.addView(tileRow(
                tile("Network", networkValue, networkSub, ORANGE),
                tile("Operator", operatorValue, operatorSub, ORANGE)
        ));
        spacerInside(card, 10);
        card.addView(tileRow(
                tile("Cellular", cellularValue, cellularSub, GREEN),
                tile("Subscription", subscriptionValue, subscriptionSub, GREEN)
        ));

        root.addView(card);
    }

    private void buildQuickActions() {
        LinearLayout card = card();
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        card.addView(label("Quick Actions", 18, TEXT, true));
        spacerInside(card, 12);

        TextView start = action("▶  Start / Retry", true, ORANGE);
        start.setOnClickListener(v -> autoConfigureAndStart());

        TextView stop = action("■  Stop Node", false, RED);
        stop.setOnClickListener(v -> {
            Prefs.putBool(this, "enabled", false);
            stopService(new Intent(this, NodeService.class));
            toast("Node stopped");
            refreshStatus();
        });

        TextView update = action("↻  Check Update", false, ORANGE);
        update.setOnClickListener(v -> AppUpdater.check(this, true));

        TextView viewLogs = action("☰  View Logs", false, ORANGE);
        viewLogs.setOnClickListener(v -> showLogsDialog());

        card.addView(actionRow(start, stop));
        spacerInside(card, 10);
        card.addView(actionRow(update, viewLogs));
        root.addView(card);
    }

    private void buildLogsCard() {
        LinearLayout card = card();
        card.setPadding(dp(16), dp(16), dp(16), dp(16));

        LinearLayout heading = hLayout(Gravity.CENTER_VERTICAL);
        heading.addView(label("Recent Logs", 18, TEXT, true),
                new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView clear = label("Clear Logs", 13, ORANGE, true);
        clear.setPadding(dp(8), dp(6), 0, dp(6));
        clear.setOnClickListener(v -> {
            Prefs.put(this, "logs", "");
            refreshLogsOnly();
            toast("Logs cleared");
        });
        heading.addView(clear);
        card.addView(heading);
        spacerInside(card, 12);

        recentLogs = label("", 13, Color.rgb(202, 214, 228), false);
        recentLogs.setTypeface(Typeface.MONOSPACE);
        recentLogs.setLineSpacing(0f, 1.25f);
        recentLogs.setPadding(dp(12), dp(12), dp(12), dp(12));
        recentLogs.setBackground(roundRect(Color.rgb(7, 16, 26), BORDER, 1, 12));
        card.addView(recentLogs, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        root.addView(card);
    }

    private void autoConfigureAndStart() {
        if (provisioning) return;
        provisioning = true;
        lastSetupError = "";
        statusTitle.setText("Configuring node");
        statusSubtitle.setText("Detecting active SIM provider and secure credential");
        statusDot.setTextColor(ORANGE);
        servicePill.setText("Configuring");
        servicePill.setTextColor(ORANGE);

        new Thread(() -> {
            try {
                AutoProvisioner.Result result = AutoProvisioner.ensure(this);
                Prefs.putBool(this, "enabled", true);
                runOnUiThread(() -> {
                    provisioning = false;
                    lastSetupError = "";
                    startNode();
                    toast("Detected " + result.provider + " · " + result.nodeName);
                    refreshStatus();
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    provisioning = false;
                    lastSetupError = safe(e.getMessage());
                    refreshStatus();
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
        if (statusTitle == null) return;
        try {
            JSONObject t = TelemetryCollector.collect(this);
            String node = Prefs.nodeName(this);
            String provider = Prefs.provider(this);
            boolean enabled = Prefs.getBool(this, "enabled", false);
            boolean provisioned = !node.isEmpty() && !Prefs.secret(this).isEmpty();
            boolean cellular = t.optBoolean("cellular_available", false);

            if (!lastSetupError.isEmpty() && !provisioned) {
                statusDot.setTextColor(RED);
                statusTitle.setText("Setup waiting");
                statusSubtitle.setText(lastSetupError);
                servicePill.setText("Needs attention");
                servicePill.setTextColor(RED);
                servicePill.setBackground(roundRect(Color.rgb(46, 24, 28), RED, 1, 18));
            } else if (enabled && provisioned && cellular) {
                statusDot.setTextColor(GREEN);
                statusTitle.setText("Node Online");
                statusSubtitle.setText("Running and connected");
                servicePill.setText("Service Enabled");
                servicePill.setTextColor(GREEN);
                servicePill.setBackground(roundRect(Color.rgb(17, 48, 40), GREEN, 1, 18));
            } else if (enabled) {
                statusDot.setTextColor(ORANGE);
                statusTitle.setText("Node Starting");
                statusSubtitle.setText("Waiting for validated cellular transport");
                servicePill.setText("Starting");
                servicePill.setTextColor(ORANGE);
                servicePill.setBackground(roundRect(Color.rgb(51, 37, 20), ORANGE, 1, 18));
            } else {
                statusDot.setTextColor(MUTED);
                statusTitle.setText("Node Stopped");
                statusSubtitle.setText("Service is currently disabled");
                servicePill.setText("Stopped");
                servicePill.setTextColor(MUTED);
                servicePill.setBackground(roundRect(Color.rgb(25, 34, 43), BORDER, 1, 18));
            }

            providerValue.setText(provider.isEmpty() ? "Detecting…" : provider);
            nodeValue.setText(node.isEmpty() ? "Auto provisioning…" : node);
            credentialValue.setText(provisioned ? "Provisioned securely" : "Not provisioned yet");
            serviceValue.setText(enabled ? "Enabled" : "Disabled");

            batteryValue.setText(json(t, "battery_percent", "N/A", "%"));
            batterySub.setText(t.optBoolean("is_charging", false) ? "Charging" : "Not charging");

            signalValue.setText(json(t, "signal_percent", "N/A", "%"));
            String dbm = json(t, "signal_dbm", "N/A", "");
            signalSub.setText("N/A".equals(dbm) ? "Signal unavailable" : dbm + " dBm");

            levelValue.setText(json(t, "signal_level", "N/A", ""));
            levelSub.setText(signalBars(t.optInt("signal_level", -1)));

            String temp = json(t, "battery_temperature_c", "N/A", "");
            tempValue.setText("N/A".equals(temp) ? "N/A" : temp + "°C");
            tempSub.setText("N/A".equals(temp) ? "Not reported" : "Battery temperature");

            String network = t.optString("network_type_label", "mobile");
            networkValue.setText(network.isEmpty() ? "Mobile" : network);
            networkSub.setText(t.optString("signal_label", network));

            String operator = t.optString("network_operator", provider);
            operatorValue.setText(operator == null || operator.isEmpty() ? "Unknown" : operator);
            operatorSub.setText(provider.isEmpty() ? "Detected SIM" : provider + " provider");

            cellularValue.setText(cellular ? "Available" : "Unavailable");
            cellularValue.setTextColor(cellular ? GREEN : RED);
            cellularSub.setText(cellular ? "Validated transport" : "Check mobile data");

            String subscription = json(t, "subscription_id", "N/A", "");
            subscriptionValue.setText(subscription);
            String reason = t.optString("subscription_reason", "");
            subscriptionSub.setText(humanReason(reason));

            updatedText.setText("Updated just now");
            refreshLogsOnly();
        } catch (Exception e) {
            statusDot.setTextColor(RED);
            statusTitle.setText("Status unavailable");
            statusSubtitle.setText(safe(e.getMessage()));
        }
    }

    private void refreshLogsOnly() {
        if (recentLogs == null) return;
        String raw = Prefs.get(this, "logs", "");
        List<String> lines = new ArrayList<>();
        for (String line : raw.split("\\r?\\n")) {
            String clean = line.trim();
            if (!clean.isEmpty()) lines.add(clean);
        }
        if (lines.isEmpty()) {
            recentLogs.setText("No recent logs yet.");
            return;
        }
        StringBuilder out = new StringBuilder();
        int start = Math.max(0, lines.size() - 3);
        for (int i = start; i < lines.size(); i++) {
            if (out.length() > 0) out.append("\n");
            out.append("●  ").append(lines.get(i));
        }
        recentLogs.setText(out.toString());
    }

    private void showLogsDialog() {
        String raw = Prefs.get(this, "logs", "");
        if (raw.trim().isEmpty()) raw = "No logs yet.";
        TextView body = label(raw, 13, Color.rgb(220, 228, 238), false);
        body.setTypeface(Typeface.MONOSPACE);
        body.setPadding(dp(18), dp(12), dp(18), dp(12));

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(8, 17, 27));
        scroll.addView(body);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Provider Node Logs")
                .setView(scroll)
                .setPositiveButton("Close", null)
                .setNeutralButton("Clear", (d, which) -> {
                    Prefs.put(this, "logs", "");
                    refreshLogsOnly();
                })
                .create();
        dialog.setOnShowListener(d -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(ORANGE);
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setTextColor(RED);
        });
        dialog.show();
    }

    private LinearLayout infoRow(String label, TextView value) {
        LinearLayout row = hLayout(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(8), 0, dp(8));
        TextView l = label(label, 14, MUTED, false);
        row.addView(l, new LinearLayout.LayoutParams(dp(112), ViewGroup.LayoutParams.WRAP_CONTENT));
        row.addView(value, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return row;
    }

    private LinearLayout tile(String title, TextView value, TextView subtitle, int accent) {
        LinearLayout tile = vLayout();
        tile.setPadding(dp(14), dp(13), dp(14), dp(13));
        tile.setBackground(roundRect(CARD_ALT, BORDER, 1, 14));

        TextView heading = label(title, 12, MUTED, false);
        tile.addView(heading);

        value.setTextColor(accent);
        LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        vlp.topMargin = dp(5);
        tile.addView(value, vlp);

        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.topMargin = dp(3);
        tile.addView(subtitle, slp);
        return tile;
    }

    private LinearLayout tileRow(View left, View right) {
        LinearLayout row = hLayout(Gravity.TOP);
        LinearLayout.LayoutParams a = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        a.rightMargin = dp(5);
        row.addView(left, a);
        LinearLayout.LayoutParams b = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        b.leftMargin = dp(5);
        row.addView(right, b);
        return row;
    }

    private LinearLayout actionRow(View left, View right) {
        LinearLayout row = hLayout(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams a = new LinearLayout.LayoutParams(0, dp(54), 1f);
        a.rightMargin = dp(5);
        row.addView(left, a);
        LinearLayout.LayoutParams b = new LinearLayout.LayoutParams(0, dp(54), 1f);
        b.leftMargin = dp(5);
        row.addView(right, b);
        return row;
    }

    private TextView action(String text, boolean filled, int color) {
        TextView v = label(text, 13, filled ? Color.WHITE : color, true);
        v.setGravity(Gravity.CENTER);
        v.setClickable(true);
        v.setFocusable(true);
        v.setBackground(roundRect(filled ? color : Color.TRANSPARENT, color, filled ? 0 : 2, 15));
        return v;
    }

    private LinearLayout card() {
        LinearLayout c = vLayout();
        c.setBackground(roundRect(CARD, BORDER, 1, 18));
        return c;
    }

    private TextView value() {
        TextView v = label("", 14, TEXT, true);
        v.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        return v;
    }

    private TextView valueLarge() { return label("—", 20, TEXT, true); }
    private TextView sub() { return label("", 11, MUTED, false); }

    private TextView label(String s, int sp, int color, boolean bold) {
        TextView v = new TextView(this);
        v.setText(s);
        v.setTextSize(sp);
        v.setTextColor(color);
        if (bold) v.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return v;
    }

    private LinearLayout hLayout(int gravity) {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(gravity);
        return l;
    }

    private LinearLayout vLayout() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    private void spacer(int px) {
        Space s = new Space(this);
        root.addView(s, new LinearLayout.LayoutParams(1, dp(px)));
    }

    private void spacerInside(LinearLayout parent, int px) {
        Space s = new Space(this);
        parent.addView(s, new LinearLayout.LayoutParams(1, dp(px)));
    }

    private void divider(LinearLayout parent, int top, int bottom) {
        View v = new View(this);
        v.setBackgroundColor(BORDER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1));
        lp.topMargin = dp(top);
        lp.bottomMargin = dp(bottom);
        parent.addView(v, lp);
    }

    private GradientDrawable roundRect(int fill, int stroke, int strokeWidth, int radius) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radius));
        if (strokeWidth > 0) g.setStroke(dp(strokeWidth), stroke);
        return g;
    }

    private String json(JSONObject o, String key, String fallback, String suffix) {
        if (!o.has(key) || o.isNull(key)) return fallback;
        String value = o.optString(key, "");
        if (value == null || value.isEmpty() || "null".equalsIgnoreCase(value)) return fallback;
        return value + suffix;
    }

    private String signalBars(int level) {
        if (level < 0) return "Signal level unavailable";
        int safe = Math.max(0, Math.min(4, level));
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < 4; i++) b.append(i < safe ? "▮" : "▯").append(i < 3 ? " " : "");
        return b.toString();
    }

    private String humanReason(String reason) {
        if (reason == null || reason.isEmpty()) return "No subscription detail";
        if ("CELLULAR_TRANSPORT_VALIDATED".equals(reason)) return "Transport validated";
        return reason.replace('_', ' ').toLowerCase();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show(); }
    private String safe(String s) { return s == null || s.isEmpty() ? "Unknown error" : s; }

    private void requestRuntimePermissions() {
        if (Build.VERSION.SDK_INT >= 23) {
            ArrayList<String> ps = new ArrayList<>();
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
