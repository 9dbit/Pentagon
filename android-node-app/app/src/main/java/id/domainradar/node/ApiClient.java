package id.domainradar.node;

import android.content.Context;
import org.json.JSONException;
import org.json.JSONObject;

class ApiClient {
    private static final EndpointRecovery RECOVERY = new EndpointRecovery();
    private static final ApiTransport TRANSPORT = new ApiTransport();
    private static String previousPollOrigin;

    static void beginPoll(Context context) {
        EndpointRecovery.Attempt route = RECOVERY.beginPoll(Prefs.central(context));
        if (previousPollOrigin != null && !previousPollOrigin.equals(route.origin)) {
            TRANSPORT.reconnect();
            NodeDiagnostics.event("ENDPOINT_SWITCH", 0);
        }
        previousPollOrigin = route.origin;
    }

    static JSONObject post(Context c,String path,JSONObject body) throws Exception {
        EndpointRecovery.Attempt route = RECOVERY.current(Prefs.central(c));
        try {
            String text = TRANSPORT.post(route, path, body.toString(),
                    "PentagonProviderNode/" + BuildConfig.VERSION_NAME);
            JSONObject response;
            try { response = new JSONObject(text); }
            catch (JSONException error) { throw ApiTransport.acknowledgement(route, "read"); }
            boolean accepted = response.optBoolean("ok", false)
                    || ("/api/agent/result".equals(path) && response.optBoolean("ignored", false));
            if (!accepted) throw ApiTransport.acknowledgement(route, "read");
            RECOVERY.succeeded(route);
            return response;
        } catch (ApiTransport.Failure failure) {
            RECOVERY.failed(route, failure.kind);
            throw failure;
        }
    }

    static void reconnect() {
        RECOVERY.reconnect();
        TRANSPORT.reconnect();
    }

    static String endpointLabel(Context context) {
        return RECOVERY.current(Prefs.central(context)).label;
    }

    static String failureCode(Exception error) {
        return error instanceof ApiTransport.Failure ? ((ApiTransport.Failure) error).code : null;
    }

    static String failurePhase(Exception error) {
        return error instanceof ApiTransport.Failure ? ((ApiTransport.Failure) error).phase : "none";
    }

    static void cancelAll() {
        RECOVERY.reconnect();
        TRANSPORT.cancelAll();
    }
}
