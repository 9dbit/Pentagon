package id.domainradar.node;

import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateException;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.IntFunction;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;

import static org.junit.Assert.*;

/** Isolated request tests. All credentials are fixtures; network tests use loopback only. */
public class ApiTransportTest {
    private static final String JSON = "{\"node_name\":\"UNIT-NODE\",\"secret_key\":\"FIXTURE-NOT-A-REAL-KEY\"}";
    private static final String USER_AGENT = "PentagonProviderNode/unit-test";

    private static EndpointRecovery.Attempt route(String configured) {
        return new EndpointRecovery().current(configured);
    }

    private static Response response(Request request, int status, String body) {
        return new Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
                .code(status).message("Test response")
                .body(ResponseBody.create(body, MediaType.get("application/json"))).build();
    }

    private interface Operation { void run() throws Exception; }

    private static ApiTransport.Failure failure(Operation operation) throws Exception {
        try {
            operation.run();
            fail("Expected an explicit failure, not a fabricated successful ACK");
            throw new AssertionError();
        } catch (ApiTransport.Failure expected) {
            return expected;
        }
    }

    @Test public void successfulPostUsesOneShotBodyAndExactlyOneExecution() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        OkHttpClient client = new OkHttpClient.Builder().addInterceptor(chain -> {
            calls.incrementAndGet();
            Request request = chain.request();
            assertEquals(EndpointRecovery.PRIMARY + "/api/agent/poll", request.url().toString());
            assertEquals("POST", request.method());
            assertEquals(USER_AGENT, request.header("User-Agent"));
            assertNotNull(request.body());
            assertTrue("A poll must not be eligible for automatic POST replay", request.body().isOneShot());
            Buffer payload = new Buffer();
            request.body().writeTo(payload);
            assertEquals(JSON, payload.readUtf8());
            return response(request, 200, "{\"ok\":true}");
        }).build();
        ApiTransport transport = new ApiTransport(client);
        assertEquals("{\"ok\":true}", transport.post(route(EndpointRecovery.PRIMARY),
                "/api/agent/poll", JSON, USER_AGENT));
        assertEquals(1, calls.get());
    }

    @Test public void networkFailureNeverReplaysPostWithinTheSameCall() throws Exception {
        IOException[] failures = {
                new UnknownHostException("private-dns-name.example"),
                new ConnectException("private-destination:443"),
                new SocketTimeoutException("FIXTURE-NOT-A-REAL-KEY")
        };
        for (IOException error : failures) {
            AtomicInteger calls = new AtomicInteger();
            ApiTransport transport = new ApiTransport(new OkHttpClient.Builder()
                    .retryOnConnectionFailure(true)
                    .addInterceptor(chain -> { calls.incrementAndGet(); throw error; }).build());
            ApiTransport.Failure result = failure(() -> transport.post(route(EndpointRecovery.PRIMARY),
                    "/api/agent/poll", JSON, USER_AGENT));
            assertEquals(EndpointRecovery.Failure.TRANSPORT, result.kind);
            assertEquals(1, calls.get());
            assertFalse(result.getMessage().contains("private-"));
            assertFalse(result.getMessage().contains("FIXTURE"));
            assertNull("Raw transport errors must not leak through a chained cause", result.getCause());
        }
    }

    @Test public void authHttpAndTlsErrorsRemainDistinctWithoutFallbackReplay() throws Exception {
        for (int status : new int[]{401, 403, 429, 500, 503}) {
            AtomicInteger calls = new AtomicInteger();
            ApiTransport transport = new ApiTransport(new OkHttpClient.Builder().addInterceptor(chain -> {
                calls.incrementAndGet();
                return response(chain.request(), status, "{\"error\":\"FIXTURE-NOT-A-REAL-KEY\"}");
            }).build());
            ApiTransport.Failure result = failure(() -> transport.post(route(EndpointRecovery.PRIMARY),
                    "/api/agent/poll", JSON, USER_AGENT));
            assertEquals(status == 401 || status == 403
                    ? EndpointRecovery.Failure.AUTH : EndpointRecovery.Failure.HTTP, result.kind);
            assertEquals("response", result.phase);
            assertEquals("railway", result.endpointLabel);
            assertEquals(1, calls.get());
            assertFalse(result.getMessage().contains("FIXTURE"));
        }
        for (IOException tls : new IOException[]{new SSLHandshakeException("bad certificate"),
                new SSLPeerUnverifiedException("untrusted hostname")}) {
            AtomicInteger calls = new AtomicInteger();
            ApiTransport transport = new ApiTransport(new OkHttpClient.Builder().addInterceptor(chain -> {
                calls.incrementAndGet(); throw tls;
            }).build());
            ApiTransport.Failure result = failure(() -> transport.post(route(EndpointRecovery.PRIMARY),
                    "/api/agent/poll", JSON, USER_AGENT));
            assertEquals(EndpointRecovery.Failure.TLS, result.kind);
            assertEquals(1, calls.get());
        }
    }

    @Test public void oversizedResponseIsRejectedAsAckFailure() throws Exception {
        char[] tooLarge = new char[65537];
        java.util.Arrays.fill(tooLarge, 'x');
        ApiTransport transport = new ApiTransport(new OkHttpClient.Builder().addInterceptor(chain ->
                response(chain.request(), 200, new String(tooLarge))).build());
        ApiTransport.Failure result = failure(() -> transport.post(route(EndpointRecovery.PRIMARY),
                "/api/agent/poll", JSON, USER_AGENT));
        assertEquals(EndpointRecovery.Failure.ACK, result.kind);
        assertEquals("read", result.phase);
    }

    @Test public void malformedConfiguredUrlFailsBeforeAnyRequest() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        ApiTransport transport = new ApiTransport(new OkHttpClient.Builder().addInterceptor(chain -> {
            calls.incrementAndGet();
            return response(chain.request(), 200, "{\"ok\":true}");
        }).build());
        ApiTransport.Failure result = failure(() -> transport.post(route("not a URL"),
                "/api/agent/poll", JSON, USER_AGENT));
        assertEquals(EndpointRecovery.Failure.OTHER, result.kind);
        assertEquals("configured", result.endpointLabel);
        assertEquals(0, calls.get());
    }

    @Test public void failureClassificationSanitizesDetailsAndKeepsCancellationTerminal() {
        IOException certificate = new IOException("private proxy URL",
                new CertificateException("private certificate data"));
        ApiTransport.Failure tls = ApiTransport.classify(certificate, "tls", "railway", false);
        assertEquals(EndpointRecovery.Failure.TLS, tls.kind);
        assertNull(tls.getCause());

        ApiTransport.Failure timeout = ApiTransport.classify(new SocketTimeoutException("private URL"),
                "read", "pentagon", false);
        assertEquals("TIMEOUT", timeout.code);
        assertEquals("read", timeout.phase);
        assertEquals("pentagon", timeout.endpointLabel);

        ApiTransport.Failure cancelled = ApiTransport.classify(new InterruptedIOException("private URL"),
                "secret phase", "https://private-host.example", true);
        assertEquals(EndpointRecovery.Failure.CANCELLED, cancelled.kind);
        assertEquals("unknown", cancelled.phase);
        assertEquals("configured", cancelled.endpointLabel);
        assertFalse(cancelled.getMessage().contains("private"));
    }

    @Test public void cancellingActiveRequestReportsCancelledInsteadOfNetworkFailure() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicReference<Throwable> observed = new AtomicReference<>();
        ApiTransport transport = new ApiTransport(new OkHttpClient.Builder().addInterceptor(chain -> {
            entered.countDown();
            try {
                if (!release.await(2, TimeUnit.SECONDS)) throw new IOException("test release timed out");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new InterruptedIOException();
            }
            throw new IOException("cancelled connection with private details");
        }).build());
        Thread worker = new Thread(() -> {
            try {
                transport.post(route(EndpointRecovery.PRIMARY), "/api/agent/result", JSON, USER_AGENT);
            } catch (Throwable error) { observed.set(error); }
        });
        try {
            worker.start();
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            transport.cancelAll();
            release.countDown();
            worker.join(2000);
            assertFalse(worker.isAlive());
            assertTrue(observed.get() instanceof ApiTransport.Failure);
            assertEquals(EndpointRecovery.Failure.CANCELLED, ((ApiTransport.Failure) observed.get()).kind);
        } finally {
            release.countDown();
            transport.cancelAll();
            worker.join(2000);
        }
    }

    @Test public void actual503RetryAfterZeroDoesNotReplayCredentialPost() throws Exception {
        // This goes through OkHttp's real follow-up machinery. An application
        // interceptor alone cannot catch the 503 Retry-After: 0 replay behavior.
        try (LoopbackServer server = new LoopbackServer(count -> count == 1
                ? wireResponse(503, "Retry-After: 0\r\n", "{}")
                : wireResponse(200, "", "{\"ok\":true}"))) {
            ApiTransport transport = new ApiTransport(new OkHttpClient.Builder()
                    .proxy(Proxy.NO_PROXY).retryOnConnectionFailure(true).build());
            ApiTransport.Failure result = failure(() -> transport.post(route(server.origin()),
                    "/api/agent/poll", JSON, USER_AGENT));
            assertEquals(EndpointRecovery.Failure.HTTP, result.kind);
            assertEquals(1, server.requests.get());
            assertEquals(JSON, server.lastBody.get());
            server.assertHealthy();
        }
    }

    @Test public void actual307RedirectCannotForwardCredentialsToAnotherOrigin() throws Exception {
        try (LoopbackServer trap = new LoopbackServer(count -> wireResponse(200, "", "{\"ok\":true}"));
             LoopbackServer server = new LoopbackServer(count -> wireResponse(307,
                     "Location: " + trap.origin() + "/credential-trap\r\n", "{}"))) {
            ApiTransport transport = new ApiTransport(new OkHttpClient.Builder().proxy(Proxy.NO_PROXY)
                    .followRedirects(true).followSslRedirects(true).build());
            ApiTransport.Failure result = failure(() -> transport.post(route(server.origin()),
                    "/api/agent/result", JSON, USER_AGENT));
            assertEquals(EndpointRecovery.Failure.HTTP, result.kind);
            assertEquals(1, server.requests.get());
            assertEquals(0, trap.requests.get());
            server.assertHealthy();
            trap.assertHealthy();
        }
    }

    private static String wireResponse(int status, String headers, String body) {
        return "HTTP/1.1 " + status + " Test\r\n" + headers
                + "Content-Type: application/json\r\nContent-Length: "
                + body.getBytes(StandardCharsets.UTF_8).length
                + "\r\nConnection: close\r\n\r\n" + body;
    }

    /** Tiny deterministic HTTP fixture, avoiding a new MockWebServer dependency. */
    private static final class LoopbackServer implements AutoCloseable {
        final AtomicInteger requests = new AtomicInteger();
        final AtomicReference<String> lastBody = new AtomicReference<>();
        private final ServerSocket server;
        private final Thread worker;
        private volatile boolean closed;
        private volatile Throwable problem;

        LoopbackServer(IntFunction<String> response) throws IOException {
            server = new ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"));
            server.setSoTimeout(1000);
            worker = new Thread(() -> {
                while (!closed) {
                    try (Socket socket = server.accept()) {
                        socket.setSoTimeout(2000);
                        InputStream input = socket.getInputStream();
                        ByteArrayOutputStream headerBytes = new ByteArrayOutputStream();
                        int state = 0;
                        byte[] terminator = {'\r', '\n', '\r', '\n'};
                        while (state < terminator.length) {
                            int value = input.read();
                            if (value < 0) throw new IOException("Unexpected end of request headers");
                            headerBytes.write(value);
                            state = value == terminator[state] ? state + 1 : (value == '\r' ? 1 : 0);
                            if (headerBytes.size() > 16384) throw new IOException("Oversized fixture request");
                        }
                        String headers = new String(headerBytes.toByteArray(), StandardCharsets.US_ASCII);
                        int length = 0;
                        for (String line : headers.split("\r\n")) {
                            if (line.toLowerCase(Locale.ROOT).startsWith("content-length:")) {
                                length = Integer.parseInt(line.substring(line.indexOf(':') + 1).trim());
                            }
                        }
                        if (length < 0 || length > 16384) throw new IOException("Invalid fixture body size");
                        byte[] body = new byte[length];
                        int offset = 0;
                        while (offset < length) {
                            int read = input.read(body, offset, length - offset);
                            if (read < 0) throw new IOException("Unexpected end of request body");
                            offset += read;
                        }
                        lastBody.set(new String(body, StandardCharsets.UTF_8));
                        int count = requests.incrementAndGet();
                        socket.getOutputStream().write(response.apply(count).getBytes(StandardCharsets.UTF_8));
                        socket.getOutputStream().flush();
                    } catch (SocketTimeoutException ignored) {
                        // Accept may wait while a redirect/retry is correctly suppressed.
                    } catch (Throwable error) {
                        if (!closed) problem = error;
                        return;
                    }
                }
            }, "PentagonLoopbackTest");
            worker.setDaemon(true);
            worker.start();
        }

        String origin() { return "http://127.0.0.1:" + server.getLocalPort(); }
        void assertHealthy() { if (problem != null) throw new AssertionError(problem); }

        @Override public void close() throws Exception {
            closed = true;
            server.close();
            worker.join(2500);
            assertFalse("Fixture worker must finish", worker.isAlive());
            assertHealthy();
        }
    }
}
