package id.domainradar.node;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLException;
import okhttp3.Call;
import okhttp3.Connection;
import okhttp3.EventListener;
import okhttp3.Handshake;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSink;

/** One bounded control POST, with no redirects, follow-up replay or raw error text. */
final class ApiTransport {
    static final class Failure extends IOException {
        final String code;
        final String phase;
        final String endpointLabel;
        final EndpointRecovery.Failure kind;

        private Failure(String code, String phase, String endpointLabel, EndpointRecovery.Failure kind) {
            // Do not retain the original exception as a cause: it can contain
            // an address, URL, proxy configuration or other private details.
            super(code);
            this.code = code;
            this.phase = safePhase(phase);
            this.endpointLabel = safeLabel(endpointLabel);
            this.kind = kind;
        }
    }

    private final OkHttpClient client;
    private final Map<Call, Trace> active = new ConcurrentHashMap<>();

    ApiTransport() { this(new OkHttpClient()); }

    // Supplying a client permits isolated transport tests without Android or a
    // live production node. The safety settings are always applied here.
    ApiTransport(OkHttpClient baseClient) {
        client = baseClient.newBuilder()
                .connectTimeout(10, TimeUnit.SECONDS).readTimeout(12, TimeUnit.SECONDS)
                .writeTimeout(10, TimeUnit.SECONDS).callTimeout(15, TimeUnit.SECONDS)
                .followRedirects(false).followSslRedirects(false)
                .retryOnConnectionFailure(false)
                .eventListenerFactory(call -> {
                    Trace trace = call.request().tag(Trace.class);
                    return trace == null ? EventListener.NONE : trace;
                }).build();
    }

    String post(EndpointRecovery.Attempt route, String path, String json, String userAgent) throws Failure {
        Trace trace = new Trace();
        Call call = null;
        try {
            Request request = new Request.Builder().url(route.origin + path)
                    .header("User-Agent", userAgent)
                    .tag(Trace.class, trace)
                    .post(oneShotJson(json)).build();
            call = client.newCall(request);
            active.put(call, trace);
            // Exactly one execute. Endpoint recovery belongs to the next loop.
            try (Response response = call.execute()) {
                if (!response.isSuccessful()) {
                    int status = response.code();
                    boolean auth = status == 401 || status == 403;
                    throw new Failure(auth ? "AUTH" : "HTTP", "response", route.label,
                            auth ? EndpointRecovery.Failure.AUTH : EndpointRecovery.Failure.HTTP);
                }
                if (response.body() == null) throw acknowledgement(route, "read");
                trace.phase = "read";
                if (response.body().source().request(65537)) throw acknowledgement(route, "read");
                return response.body().string();
            }
        } catch (Failure failure) {
            throw failure;
        } catch (IOException error) {
            throw classify(error, trace.phase, route.label, trace.cancelled);
        } catch (IllegalArgumentException error) {
            throw new Failure("UNKNOWN", "unknown", route.label, EndpointRecovery.Failure.OTHER);
        } finally {
            if (call != null) active.remove(call);
        }
    }

    void reconnect() {
        // Called only after the existing bounded attempt has finished. Do not
        // cancel result uploads or a request which may already have claimed work.
        client.connectionPool().evictAll();
    }

    void cancelAll() {
        for (Map.Entry<Call, Trace> entry : active.entrySet()) {
            entry.getValue().cancelled = true;
            entry.getKey().cancel();
        }
    }

    static Failure acknowledgement(EndpointRecovery.Attempt route, String phase) {
        return new Failure("ACK", phase, route.label, EndpointRecovery.Failure.ACK);
    }

    static Failure classify(IOException error, String phase, String endpointLabel, boolean cancelled) {
        if (cancelled || (error instanceof InterruptedIOException && Thread.currentThread().isInterrupted())) {
            return new Failure("CANCELLED", phase, endpointLabel, EndpointRecovery.Failure.CANCELLED);
        }
        // Certificate/handshake errors remain visible and never cause fallback.
        Throwable cause = error;
        for (int depth = 0; cause != null && depth < 8; depth++, cause = cause.getCause()) {
            if (cause instanceof SSLException || cause instanceof java.security.cert.CertificateException) {
                return new Failure("TLS", phase, endpointLabel, EndpointRecovery.Failure.TLS);
            }
        }
        if (error instanceof UnknownHostException) {
            return new Failure("DNS", "dns", endpointLabel, EndpointRecovery.Failure.TRANSPORT);
        }
        if (error instanceof SocketTimeoutException || error instanceof InterruptedIOException) {
            return new Failure("TIMEOUT", phase, endpointLabel, EndpointRecovery.Failure.TRANSPORT);
        }
        return new Failure("IO", phase, endpointLabel, EndpointRecovery.Failure.TRANSPORT);
    }

    private static RequestBody oneShotJson(String json) {
        final RequestBody body = RequestBody.create(json, MediaType.get("application/json; charset=utf-8"));
        return new RequestBody() {
            @Override public MediaType contentType() { return body.contentType(); }
            @Override public long contentLength() throws IOException { return body.contentLength(); }
            @Override public void writeTo(BufferedSink sink) throws IOException { body.writeTo(sink); }
            // OkHttp can follow 503 Retry-After: 0 even with connection retries
            // disabled. A polling POST must never be replayed in this call.
            @Override public boolean isOneShot() { return true; }
        };
    }

    private static String safePhase(String phase) {
        if ("none".equals(phase) || "dns".equals(phase) || "connect".equals(phase)
                || "tls".equals(phase) || "write".equals(phase)
                || "response".equals(phase) || "read".equals(phase)) return phase;
        return "unknown";
    }

    private static String safeLabel(String label) {
        return "railway".equals(label) || "pentagon".equals(label) ? label : "configured";
    }

    private static final class Trace extends EventListener {
        volatile String phase = "unknown";
        volatile boolean cancelled;

        @Override public void dnsStart(Call call, String domainName) { phase = "dns"; }
        @Override public void dnsEnd(Call call, String domainName, List<InetAddress> addresses) { phase = "connect"; }
        @Override public void connectStart(Call call, InetSocketAddress address, Proxy proxy) { phase = "connect"; }
        @Override public void secureConnectStart(Call call) { phase = "tls"; }
        @Override public void secureConnectEnd(Call call, Handshake handshake) { phase = "connect"; }
        @Override public void connectEnd(Call call, InetSocketAddress address, Proxy proxy, Protocol protocol) { phase = "write"; }
        @Override public void connectionAcquired(Call call, Connection connection) { phase = "write"; }
        @Override public void requestHeadersStart(Call call) { phase = "write"; }
        @Override public void requestBodyEnd(Call call, long byteCount) { phase = "response"; }
        @Override public void responseHeadersStart(Call call) { phase = "response"; }
        @Override public void responseBodyStart(Call call) { phase = "read"; }
    }
}
