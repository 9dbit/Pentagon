package id.domainradar.node;

import org.junit.Test;
import static org.junit.Assert.*;
import java.net.SocketTimeoutException;
import java.io.IOException;
import javax.net.ssl.SSLHandshakeException;

public class AppUpdaterSourcesTest {
    private static final String DIRECT = "https://provider-node-release-production.up.railway.app/latest.apk";
    private static final String FALLBACK = "https://pentagon.quest/api/provider-node/releases/cloud/apk";

    @Test public void knownReleaseHasOneFixedFallback() {
        assertArrayEquals(new String[] { DIRECT, FALLBACK }, AppUpdater.downloadCandidates(DIRECT));
        assertArrayEquals(new String[] { FALLBACK }, AppUpdater.downloadCandidates(FALLBACK));
    }

    @Test public void manifestCannotExpandUpdateOriginsOrPaths() {
        String[] invalid = { "http://provider-node-release-production.up.railway.app/latest.apk",
            DIRECT + "?redirect=evil", DIRECT + "#fragment", "https://user:secret@pentagon.quest/api/provider-node/releases/cloud/apk",
            "https://pentagon.quest.evil.example/api/provider-node/releases/cloud/apk", "https://pentagon.quest:444/api/provider-node/releases/cloud/apk",
            "https://127.0.0.1/latest.apk", "https://pentagon.quest/other.apk", "https://other.example/latest.apk" };
        for (String value : invalid) {
            try { AppUpdater.downloadCandidates(value); fail("untrusted update accepted: " + value); }
            catch (SecurityException expected) { }
        }
    }

    @Test public void safeGetsRecoverFromTimeoutOrUnavailableUpstream() {
        assertTrue(AppUpdater.retryable(new SocketTimeoutException("fixture")));
        assertTrue(AppUpdater.retryable(new AppUpdater.UpdateHttpException(503)));
    }

    @Test public void certificateRedirectAuthAndIntegrityFailuresDoNotUseFallback() {
        assertFalse(AppUpdater.retryable(new SSLHandshakeException("fixture")));
        assertFalse(AppUpdater.retryable(new IOException("wrapped", new SSLHandshakeException("fixture"))));
        assertFalse(AppUpdater.retryable(new AppUpdater.UpdateHttpException(302)));
        assertFalse(AppUpdater.retryable(new AppUpdater.UpdateHttpException(401)));
        assertFalse(AppUpdater.retryable(new AppUpdater.UpdateHttpException(403)));
        assertFalse(AppUpdater.retryable(new SecurityException("APK_CHECKSUM_MISMATCH")));
    }
}
