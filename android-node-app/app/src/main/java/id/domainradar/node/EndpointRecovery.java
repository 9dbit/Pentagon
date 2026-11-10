package id.domainradar.node;

import java.net.URI;

/** Selects a control endpoint between poll iterations, never by replaying a POST. */
final class EndpointRecovery {
    static final String PRIMARY = "https://pentagon-web-production.up.railway.app";
    static final String ALTERNATE = "https://pentagon.quest";

    enum Failure { TRANSPORT, AUTH, HTTP, ACK, TLS, CANCELLED, OTHER }

    static final class Attempt {
        final long generation;
        final String origin;
        final String label;

        private Attempt(long generation, String origin) {
            this.generation = generation;
            this.origin = origin;
            this.label = PRIMARY.equals(origin) ? "railway"
                    : ALTERNATE.equals(origin) ? "pentagon" : "configured";
        }
    }

    private String configured;
    private String active;
    private boolean fallbackAllowed;
    private boolean switchPending;
    private int transportFailures;
    private long generation;

    synchronized Attempt beginPoll(String configuredCentral) {
        configure(configuredCentral);
        if (switchPending && fallbackAllowed) {
            active = PRIMARY.equals(active) ? ALTERNATE : PRIMARY;
            switchPending = false;
            transportFailures = 0;
            generation++;
        }
        return snapshot();
    }

    /** Result uploads and UI reads cannot apply a switch queued by a failed poll. */
    synchronized Attempt current(String configuredCentral) {
        configure(configuredCentral);
        return snapshot();
    }

    synchronized void succeeded(Attempt attempt) {
        if (!isCurrent(attempt)) return;
        transportFailures = 0;
        switchPending = false;
    }

    synchronized void failed(Attempt attempt, Failure failure) {
        if (!isCurrent(attempt)) return;
        if (failure == Failure.TRANSPORT && fallbackAllowed) {
            transportFailures = Math.min(2, transportFailures + 1);
            switchPending = transportFailures >= 2;
        } else {
            // A server response, rejected ACK, TLS failure or cancellation is
            // not evidence that credentials should be sent to another origin.
            transportFailures = 0;
            switchPending = false;
        }
    }

    synchronized void reconnect() {
        // Keep a working alternate. Invalidate any earlier callback without
        // modifying the configured endpoint, node identity or credentials.
        generation++;
        transportFailures = 0;
        switchPending = false;
    }

    private Attempt snapshot() {
        return new Attempt(generation, active);
    }

    private boolean isCurrent(Attempt attempt) {
        return attempt != null && attempt.generation == generation
                && attempt.origin.equals(active);
    }

    private void configure(String value) {
        String next = normalize(value);
        if (next.equals(configured)) return;
        configured = next;
        active = next;
        fallbackAllowed = PRIMARY.equals(next) || ALTERNATE.equals(next);
        switchPending = false;
        transportFailures = 0;
        generation++;
    }

    private static String normalize(String value) {
        String configured = value == null ? "" : value.trim().replaceAll("/+$", "");
        if (configured.isEmpty()) return PRIMARY;
        try {
            URI url = new URI(configured);
            String path = url.getRawPath();
            boolean exactHttpsOrigin = "https".equalsIgnoreCase(url.getScheme())
                    && url.getRawUserInfo() == null && url.getRawQuery() == null
                    && url.getRawFragment() == null
                    && (url.getPort() == -1 || url.getPort() == 443)
                    && (path == null || path.isEmpty());
            if (exactHttpsOrigin) {
                if ("pentagon-web-production.up.railway.app".equalsIgnoreCase(url.getHost())) return PRIMARY;
                if ("pentagon.quest".equalsIgnoreCase(url.getHost())) return ALTERNATE;
            }
        } catch (Exception ignored) {
            // Preserve intentional custom configuration. Invalid URLs will fail
            // locally; they must never gain a trusted-origin fallback.
        }
        return configured;
    }
}
