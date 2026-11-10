package id.domainradar.node;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
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
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.UnknownHostException;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLException;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

final class AppUpdater {
    private static final String[] MANIFEST_URLS = {
            "https://pentagon-web-production.up.railway.app/api/provider-node/releases/cloud/latest",
            "https://pentagon.quest/api/provider-node/releases/cloud/latest"
    };
    private static final String RELEASE_APK_URL = "https://provider-node-release-production.up.railway.app/latest.apk";
    private static final String PRIMARY_APK_URL = "https://pentagon-web-production.up.railway.app/api/provider-node/releases/cloud/apk";
    private static final String FALLBACK_APK_URL = "https://pentagon.quest/api/provider-node/releases/cloud/apk";
    private static final long MAX_APK_BYTES = 32L * 1024L * 1024L;
    private static final OkHttpClient MANIFEST_CLIENT = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build();
    private static final OkHttpClient DOWNLOAD_CLIENT = MANIFEST_CLIENT.newBuilder()
            .readTimeout(20, TimeUnit.SECONDS).callTimeout(60, TimeUnit.SECONDS).build();

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
                if (manual) toast(activity, "Update check failed: " + safeError(e));
            }
        }, "PentagonUpdateCheck").start();
    }

    private static JSONObject fetchManifest() throws Exception {
        for (int i = 0; i < MANIFEST_URLS.length; i++) {
            Request request = updateRequest(MANIFEST_URLS[i]).header("Accept", "application/json").build();
            try (Response response = MANIFEST_CLIENT.newCall(request).execute()) {
                if (response.code() != 200) throw new UpdateHttpException(response.code());
                if (response.body() == null || response.body().source().request(65537)) {
                    throw new SecurityException("INVALID_RELEASE_METADATA");
                }
                return new JSONObject(response.body().string());
            } catch (Exception error) {
                if (i + 1 == MANIFEST_URLS.length || !retryable(error)) throw error;
            }
        }
        throw new IOException("RELEASE_UNAVAILABLE");
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
                String expectedSha = release.getString("sha256").trim().toLowerCase(Locale.US);
                if (!expectedSha.matches("[a-f0-9]{64}")) throw new SecurityException("INVALID_RELEASE_HASH");
                long expectedSize = release.getLong("sizeBytes");
                if (expectedSize < 1L || expectedSize > MAX_APK_BYTES) throw new SecurityException("INVALID_APK_SIZE");

                File dir = new File(activity.getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Cannot create update cache");
                File apk = new File(dir, "Pentagon-Provider-Node-update.apk");

                downloadWithFallback(release.getString("downloadUrl"), apk, expectedSize);
                String actualSha = sha256(apk);
                if (!expectedSha.equals(actualSha)) {
                    apk.delete();
                    throw new SecurityException("APK_CHECKSUM_MISMATCH");
                }
                verifyPackageAndSigner(activity, apk, release);
                activity.runOnUiThread(() -> launchInstaller(activity, apk));
            } catch (Exception e) {
                toast(activity, "Update failed: " + safeError(e));
            }
        }, "PentagonUpdateDownload").start();
    }

    static String[] downloadCandidates(String downloadUrl) {
        // A manifest cannot expand the app's trusted update origins. In
        // particular, no node or bootstrap credential is sent on this channel.
        if (FALLBACK_APK_URL.equals(downloadUrl)) return new String[] { FALLBACK_APK_URL };
        if (!RELEASE_APK_URL.equals(downloadUrl) && !PRIMARY_APK_URL.equals(downloadUrl)) {
            throw new SecurityException("UNTRUSTED_UPDATE_URL");
        }
        return new String[] { downloadUrl, FALLBACK_APK_URL };
    }

    private static Request.Builder updateRequest(String url) {
        return new Request.Builder().url(url).get()
                .header("Cache-Control", "no-cache").header("Pragma", "no-cache")
                .header("Accept-Encoding", "identity")
                .header("User-Agent", "PentagonProviderNode/" + BuildConfig.VERSION_NAME);
    }

    private static void downloadWithFallback(String downloadUrl, File output, long expectedSize) throws Exception {
        String[] candidates = downloadCandidates(downloadUrl);
        for (int i = 0; i < candidates.length; i++) {
            try { download(candidates[i], output, expectedSize); return; }
            catch (Exception error) {
                output.delete();
                if (i + 1 == candidates.length || !retryable(error)) throw error;
            }
        }
    }

    private static void download(String downloadUrl, File output, long expectedSize) throws Exception {
        try (Response response = DOWNLOAD_CLIENT.newCall(updateRequest(downloadUrl).build()).execute()) {
            if (response.code() != 200) throw new UpdateHttpException(response.code());
            if (response.body() == null) throw new IOException("EMPTY_APK_RESPONSE");
            long advertisedSize = response.body().contentLength();
            if (advertisedSize != -1 && advertisedSize != expectedSize) throw new SecurityException("APK_SIZE_MISMATCH");
            try (InputStream in = response.body().byteStream(); FileOutputStream out = new FileOutputStream(output)) {
                byte[] buf = new byte[32768];
                int n; long received = 0L;
                while ((n = in.read(buf)) >= 0) {
                    received += n;
                    if (received > expectedSize || received > MAX_APK_BYTES) throw new SecurityException("APK_TOO_LARGE");
                    out.write(buf, 0, n);
                }
                if (received != expectedSize) throw new IOException("INCOMPLETE_APK");
            }
        }
    }

    static boolean retryable(Exception error) {
        // GET retries are safe, but certificate, package and hash failures are
        // never hidden by changing hosts. Redirects remain disabled.
        Throwable cause = error;
        for (int depth = 0; cause != null && depth < 8; depth++, cause = cause.getCause()) {
            if (cause instanceof SSLException || cause instanceof SecurityException) return false;
        }
        if (error instanceof UpdateHttpException) {
            int status = ((UpdateHttpException) error).status;
            return status >= 500 && status < 600;
        }
        return error instanceof IOException;
    }

    static final class UpdateHttpException extends IOException {
        final int status;
        UpdateHttpException(int status) { super("HTTP_" + status); this.status = status; }
    }

    private static void verifyPackageAndSigner(Activity activity, File apk, JSONObject release) throws Exception {
        PackageManager manager = activity.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        PackageInfo installed = manager.getPackageInfo(activity.getPackageName(), flags);
        if (archive == null || !activity.getPackageName().equals(archive.packageName)
                || versionCode(archive) != release.getLong("versionCode")) {
            apk.delete(); throw new SecurityException("APK_IDENTITY_MISMATCH");
        }
        String archiveSigner = signerSha256(archive);
        String installedSigner = signerSha256(installed);
        if (!archiveSigner.equals(installedSigner)
                || !archiveSigner.equals(release.getString("signerSha256").toLowerCase(Locale.US))) {
            apk.delete(); throw new SecurityException("APK_SIGNER_MISMATCH");
        }
    }

    private static String signerSha256(PackageInfo info) throws Exception {
        Signature[] signatures = Build.VERSION.SDK_INT >= 28 && info.signingInfo != null
                ? info.signingInfo.getApkContentsSigners() : info.signatures;
        if (signatures == null || signatures.length != 1) throw new SecurityException("APK_SIGNER_UNAVAILABLE");
        return hex(MessageDigest.getInstance("SHA-256").digest(signatures[0].toByteArray()));
    }

    private static void launchInstaller(Activity activity, File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".files", apk);
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(install);
        } catch (Exception e) {
            toast(activity, "Installer failed: " + safeError(e));
        }
    }

    private static long installedVersionCode(Activity activity) throws Exception {
        PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
        return versionCode(info);
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = in.read(buf)) >= 0) digest.update(buf, 0, n);
        }
        return hex(digest.digest());
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) out.append(String.format(Locale.US, "%02x", b));
        return out.toString();
    }

    private static void toast(Activity activity, String message) {
        activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_LONG).show());
    }

    private static String safeError(Exception error) {
        if (error instanceof SSLException) return "TLS verification failed";
        if (error instanceof UnknownHostException) return "DNS unavailable";
        if (error instanceof InterruptedIOException) return "Connection timed out";
        if (error instanceof UpdateHttpException) return "HTTP " + ((UpdateHttpException) error).status;
        if (error instanceof SecurityException) return "Release verification failed";
        if (error instanceof IOException) return "Connection unavailable";
        return "Invalid or unavailable release";
    }
}
