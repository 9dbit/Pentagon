package id.domainradar.node;

import android.content.Context;
import android.os.PowerManager;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;
import java.time.Instant;
import java.util.ArrayDeque;

final class NodeDiagnostics {
    private static final ArrayDeque<JSONObject> events=new ArrayDeque<>();
    private static String phase="idle", error="NONE", result="none";
    private static long lastPollStart, pollGap, pollDuration, lastAck, dnsMs, httpMs;
    private static boolean running;
    private NodeDiagnostics() {}
    static synchronized void running(boolean value) { running=value; event(value?"SERVICE_START":"SERVICE_STOP",0); }
    static synchronized void phase(String value) { phase=value; }
    static synchronized void timing(String kind,long ms) {
        if("dns".equals(kind))dnsMs=ms; else httpMs=ms;
        event("dns".equals(kind)?"DNS_DONE":"HTTP_DONE",ms);
    }
    static synchronized void pollStart() {
        long now=SystemClock.elapsedRealtime(); pollGap=lastPollStart==0?0:now-lastPollStart; lastPollStart=now;
    }
    static synchronized void pollAck() {
        pollDuration=SystemClock.elapsedRealtime()-lastPollStart; lastAck=SystemClock.elapsedRealtime();
        if(!"NONE".equals(error))event("POLL_RECOVERED",pollDuration);
        error="NONE";
    }
    static synchronized void pollError(Exception e) { error=code(e); event("POLL_ERROR",SystemClock.elapsedRealtime()-lastPollStart); }
    static synchronized void result(String value) { result=value; event("accepted".equals(value)?"RESULT_ACCEPTED":"ignored".equals(value)?"RESULT_IGNORED":"RESULT_ERROR",0); }
    static synchronized void event(String name,long duration) {
        try {
            JSONObject e=new JSONObject(); e.put("event",name); e.put("at",Instant.now().toString()); e.put("duration_ms",Math.max(0,duration));
            if(events.size()>=20)events.removeFirst(); events.addLast(e);
        } catch(Exception ignored) {}
    }
    static String code(Exception e) {
        if(e instanceof javax.net.ssl.SSLException)return "TLS";
        if(e instanceof java.net.UnknownHostException)return "DNS";
        if(e instanceof java.net.SocketTimeoutException || e instanceof java.util.concurrent.TimeoutException)return "TIMEOUT";
        if(e instanceof InterruptedException)return "CANCELLED";
        String message=e.getMessage();
        if("HTTP_401".equals(message)||"HTTP_403".equals(message))return "AUTH";
        if(message!=null&&message.startsWith("HTTP_"))return "HTTP";
        if("ACK_REJECTED".equals(message))return "ACK";
        return e instanceof java.io.IOException?"IO":"UNKNOWN";
    }
    static synchronized JSONObject snapshot(Context c,boolean busy,long elapsed) {
        JSONObject o=new JSONObject();
        try {
            o.put("schema_version",1); o.put("uptime_ms",SystemClock.elapsedRealtime());
            o.put("configured_poll_ms",Prefs.configuredPollMs(c)); o.put("effective_poll_ms",Prefs.pollMs(c));
            o.put("last_poll_duration_ms",pollDuration); o.put("last_poll_gap_ms",pollGap);
            o.put("last_ack_age_ms",lastAck==0?JSONObject.NULL:SystemClock.elapsedRealtime()-lastAck);
            o.put("service_running",running); o.put("task_busy",busy); o.put("task_phase",phase);
            o.put("task_elapsed_ms",elapsed); o.put("dns_ms",dnsMs); o.put("http_ms",httpMs);
            o.put("last_error_code",error); o.put("last_result_state",result);
            PowerManager pm=(PowerManager)c.getSystemService(Context.POWER_SERVICE);
            if(pm!=null) {
                o.put("device_idle",pm.isDeviceIdleMode()); o.put("interactive",pm.isInteractive());
                o.put("power_save",pm.isPowerSaveMode()); o.put("battery_optimization_exempt",pm.isIgnoringBatteryOptimizations(c.getPackageName()));
            }
            o.put("events",new JSONArray(events));
        } catch(Exception ignored) {}
        return o;
    }
}
