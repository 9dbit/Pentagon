package id.domainradar.node;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

final class AppUpdater {
    private static final String MANIFEST_URL =
            "https://pentagon-web-production.up.railway.app/api/provider-node/releases/cloud/latest";

    private AppUpdater() {}

    static void check(Activity activity, boolean manual) {
        new Thread(() -> {
            try {
                JSONObject release = fetchManifest();
                long remoteCode = release.getLong("versionCode");
                long installedCode = installedVersionCode(activity);
                String remotePackage = release.optString("packageName", "");
                if (!activity.getPackageName().equals(remotePackage)) {
                    throw new IllegalStateException("Release package mismatch");
                }
                if (remoteCode > installedCode) {
                    activity.runOnUiThread(() -> showUpdateDialog(activity, release));
                } else if (manual) {
                    toast(activity, "You already have the latest version.");
                }
            } catch (Exception e) {
                if (manual) toast(activity, "Update check failed: " + safe(e.getMessage()));
            }
        }, "PentagonUpdateCheck").start();
    }

    private static JSONObject fetchManifest() throws Exception {
        URL url = new URL(MANIFEST_URL + "?t=" + System.currentTimeMillis());
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("GET");
        conn.setUseCaches(false);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(15000);
        conn.setRequestProperty("Cache-Control", "no-cache");
        conn.setRequestProperty("Pragma", "no-cache");
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("User-Agent", "PentagonProviderNode/" + BuildConfig.VERSION_NAME);
        try {
            int code = conn.getResponseCode();
            if (code != 200) throw new IllegalStateException("HTTP " + code);
            return new JSONObject(readAll(conn.getInputStream()));
        } finally {
            conn.disconnect();
        }
    }

    private static void showUpdateDialog(Activity activity, JSONObject release) {
        String versionName = release.optString("versionName", "new version");
        String notes = release.optString("releaseNotes", "A newer Pentagon Provider Node is available.");
        new AlertDialog.Builder(activity)
                .setTitle("Update available: " + versionName)
                .setMessage(notes)
                .setPositiveButton("Update", (dialog, which) -> beginUpdate(activity, release))
                .setNegativeButton("Later", null)
                .show();
    }

    private static void beginUpdate(Activity activity, JSONObject release) {
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(intent);
            toast(activity, "Allow installs for Pentagon Node, then tap Check Update again.");
            return;
        }
        new Thread(() -> {
            try {
                String downloadUrl = release.getString("downloadUrl");
                String expectedSha = release.getString("sha256").trim().toLowerCase(Locale.US);
                if (!downloadUrl.startsWith("https://")) throw new IllegalStateException("Insecure update URL");
                if (expectedSha.length() != 64) throw new IllegalStateException("Invalid release SHA-256");

                File dir = new File(activity.getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Cannot create update cache");
                File apk = new File(dir, "Pentagon-Provider-Node-update.apk");

                download(downloadUrl, apk);
                String actualSha = sha256(apk);
                if (!expectedSha.equals(actualSha)) {
                    apk.delete();
                    throw new SecurityException("APK checksum mismatch");
                }
                activity.runOnUiThread(() -> launchInstaller(activity, apk));
            } catch (Exception e) {
                toast(activity, "Update failed: " + safe(e.getMessage()));
            }
        }, "PentagonUpdateDownload").start();
    }

    private static void download(String downloadUrl, File output) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(downloadUrl).openConnection();
        conn.setRequestMethod("GET");
        conn.setUseCaches(false);
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(60000);
        conn.setRequestProperty("Cache-Control", "no-cache");
        conn.setRequestProperty("Pragma", "no-cache");
        conn.setRequestProperty("User-Agent", "PentagonProviderNode/" + BuildConfig.VERSION_NAME);
        try {
            int code = conn.getResponseCode();
            if (code != 200) throw new IllegalStateException("APK HTTP " + code);
            try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(output)) {
                byte[] buf = new byte[32768];
                int n;
                while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
            }
        } finally {
            conn.disconnect();
        }
    }

    private static void launchInstaller(Activity activity, File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".files", apk);
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(install);
        } catch (Exception e) {
            toast(activity, "Installer failed: " + safe(e.getMessage()));
        }
    }

    private static long installedVersionCode(Activity activity) throws Exception {
        PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
        if (Build.VERSION.SDK_INT >= 28) return info.getLongVersionCode();
        return info.versionCode;
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = in.read(buf)) >= 0) digest.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : digest.digest()) sb.append(String.format(Locale.US, "%02x", b));
        return sb.toString();
    }

    private static String readAll(InputStream in) throws Exception {
        StringBuilder out = new StringBuilder();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) >= 0) out.append(new String(buf, 0, n, "UTF-8"));
        return out.toString();
    }

    private static void toast(Activity activity, String message) {
        activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_LONG).show());
    }

    private static String safe(String value) {
        return value == null || value.isEmpty() ? "unknown error" : value;
    }
}
